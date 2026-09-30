import { createHash } from 'node:crypto';
import type { ContentPart, Message as V2Message } from '@opencode/ai';
import type { LcmStore } from './lcm-store.js';
import type { ConversationMessage, Part } from './types.js';

export function emptyPart(sessionID: string, messageID: string, id: string, type: string): Part {
  return {
    id,
    sessionID,
    messageID,
    type,
    state: { output: '', error: '' },
    files: [],
    source: {},
  };
}

export function stringifyContent(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
}

// OpenCode exposes local context-mode tools with the plugin namespace prepended.
// Normalize only that known namespace; the native tool name remains unchanged.
export function lcmToolName(name: string): string {
  return name.startsWith('context-mode_ctx_') ? name.slice('context-mode_'.length) : name;
}

function toPart(content: ContentPart, sessionID: string, messageID: string, index: number): Part {
  const part = emptyPart(sessionID, messageID, `${messageID}:${index}`, content.type);
  if ('metadata' in content) part.metadata = { ...content.metadata };
  switch (content.type) {
    case 'text':
    case 'reasoning':
      part.text = content.text;
      break;
    case 'tool-call':
      part.type = 'tool';
      part.tool = lcmToolName(content.name);
      part.callID = content.id;
      part.state = { status: 'running', input: content.input, output: '', error: '' };
      break;
    case 'tool-result': {
      part.type = 'tool';
      part.tool = lcmToolName(content.name);
      part.callID = content.id;
      const value =
        content.result.type === 'content'
          ? content.result.value
              .map((item) => (item.type === 'text' ? item.text : item.uri))
              .join('\n')
          : stringifyContent(content.result.value);
      part.state = {
        status: content.result.type === 'error' ? 'error' : 'completed',
        output: content.result.type === 'error' ? '' : value,
        error: content.result.type === 'error' ? value : '',
      };
      break;
    }
    case 'media': {
      part.type = 'file';
      part.filename = content.filename;
      part.mime = content.media.mediaType;
      const source = content.media.source;
      part.url = source.type === 'url' ? source.url : content.media.inline()?.dataUrl;
      break;
    }
    case 'compaction':
      // Provider checkpoints and encrypted reasoning stay native on writeback.
      part.text = content.text ?? undefined;
      break;
  }
  return part;
}

/** Keep native provider fields/media objects outside the serializable sidecar payload. */
export async function transformV2Messages(
  store: LcmStore,
  sessionID: string,
  messages: V2Message[],
): Promise<void> {
  const originals: Map<string, ContentPart>[] = [];
  const local: ConversationMessage[] = messages.map((message, index) => {
    const parts = new Map<string, ContentPart>();
    originals.push(parts);
    const id =
      message.id ?? `lcm-v2-${createHash('sha256').update(JSON.stringify(message)).digest('hex')}`;
    return {
      info: { id, sessionID, role: message.role, time: { created: index } },
      parts: message.content.map((content, partIndex) => {
        const part = toPart(content, sessionID, id, partIndex);
        parts.set(part.id, content);
        return part;
      }),
    };
  });
  if (!(await store.transformMessages(local))) return;
  const transformed = local.map(
    (message, index): V2Message => ({
      ...messages[index],
      id: messages[index].id ?? message.info.id,
      content: message.parts.map((part): ContentPart => {
        const original = originals[index].get(part.id);
        if (!original) return { type: 'text', text: part.text ?? '', metadata: part.metadata };
        if (original.type === 'text' || original.type === 'reasoning') {
          return { ...original, text: part.text ?? '', metadata: part.metadata };
        }
        if (original.type === 'tool-result') {
          const before = toPart(original, sessionID, message.info.id, 0);
          if (
            before.state.output !== part.state.output ||
            before.state.error !== part.state.error
          ) {
            return {
              ...original,
              result: {
                type: part.state.status === 'error' ? 'error' : 'text',
                value: part.state.status === 'error' ? part.state.error : part.state.output,
              },
            };
          }
        }
        return original;
      }),
    }),
  );
  // Commit only after the entire transform succeeds (optional hooks fail open).
  messages.splice(0, messages.length, ...transformed);
}
