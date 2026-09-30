import type { SessionInfo, V2Event } from '@opencode/client';
import type { SessionPrompt } from '@opencode/plugin/promise/session';
import type { Event } from './lcm-store.js';
import type { Message, Part, Properties } from './types.js';
import { emptyPart, lcmToolName } from './v2-messages.js';

const CAPTURED_EVENTS = new Set([
  'session.created',
  'session.renamed',
  'session.moved',
  'session.forked',
  'session.deleted',
  'session.text.ended',
  'session.reasoning.ended',
  'session.step.started',
  'session.synthetic',
  'session.tool.input.started',
  'session.tool.called',
  'session.tool.success',
  'session.tool.failed',
  'session.compaction.ended',
]);

/** Translate the 2.0 durable event union, never streaming deltas, into store events. */
export class V2EventAdapter {
  private readonly seen = new Set<string>();
  private readonly sessions = new Map<string, Message>();
  private readonly tools = new Map<string, { name: string; input?: unknown }>();
  private readonly messageTimes = new Map<string, number>();

  constructor(private readonly directory: string) {}

  hasSession(sessionID: string): boolean {
    return this.sessions.has(sessionID);
  }

  session(info: SessionInfo): Event {
    const message: Message = {
      id: info.id,
      sessionID: info.id,
      role: 'session',
      title: info.title,
      parentID: info.parentID,
      directory: info.location.directory,
      time: info.time,
    };
    this.sessions.set(info.id, message);
    return this.event('session.updated', info.id, info.time.updated, { info: message });
  }

  private event(
    type: string,
    sessionID: string,
    created: number,
    properties: Partial<Properties>,
  ): Event {
    return { type, sessionID, timestamp: created, properties: properties as Properties };
  }

  private message(
    sessionID: string,
    messageID: string,
    created: number,
    role: string,
    parts: Part[],
  ): Event[] {
    const key = `${sessionID}:${messageID}`;
    const started = this.messageTimes.get(key) ?? created;
    this.messageTimes.set(key, started);
    const oldest = this.messageTimes.keys().next().value;
    if (this.messageTimes.size > 4096 && oldest !== undefined) this.messageTimes.delete(oldest);
    return [
      this.event('message.updated', sessionID, created, {
        info: { id: messageID, sessionID, role, time: { created: started } },
      }),
      ...parts.map((part) => this.event('message.part.updated', sessionID, created, { part })),
    ];
  }

  prompt(prompt: SessionPrompt): Event[] {
    const { sessionID, messageID } = prompt;
    const text = emptyPart(sessionID, messageID, `${messageID}:prompt`, 'text');
    text.text = prompt.prompt.text;
    const files = (prompt.prompt.files ?? []).map((file, index) => ({
      ...emptyPart(sessionID, messageID, `${messageID}:file:${index}`, 'file'),
      url: file.uri,
      filename: file.name,
    }));
    return this.message(sessionID, messageID, Date.now(), 'user', [text, ...files]);
  }

  convert(event: V2Event): Event[] {
    if (!CAPTURED_EVENTS.has(event.type)) return [];
    if (!('sessionID' in event.data) || !('created' in event)) return [];
    if (this.seen.has(event.id)) return [];
    this.seen.add(event.id);
    const oldest = this.seen.values().next().value;
    if (this.seen.size > 4096 && oldest !== undefined) this.seen.delete(oldest);
    const sessionID = event.data.sessionID;
    const created = event.created;
    switch (event.type) {
      case 'session.created':
      case 'session.renamed':
      case 'session.moved':
      case 'session.forked':
      case 'session.deleted': {
        const info: Message = this.sessions.get(sessionID) ?? {
          id: sessionID,
          sessionID,
          role: 'session',
          directory: this.directory,
          time: { created },
        };
        if ('title' in event.data) info.title = event.data.title;
        if ('parentID' in event.data) info.parentID = event.data.parentID;
        if ('location' in event.data) info.directory = event.data.location.directory;
        this.sessions.set(sessionID, info);
        if (event.type === 'session.deleted') {
          this.sessions.delete(sessionID);
          for (const key of this.tools.keys())
            if (key.startsWith(`${sessionID}:`)) this.tools.delete(key);
        }
        return [
          this.event(
            event.type === 'session.deleted' ? 'session.deleted' : 'session.updated',
            sessionID,
            created,
            { info: { ...info } },
          ),
        ];
      }
      case 'session.text.ended':
      case 'session.reasoning.ended': {
        const data = event.data;
        const type = event.type === 'session.text.ended' ? 'text' : 'reasoning';
        const part = emptyPart(
          sessionID,
          data.assistantMessageID,
          `${data.assistantMessageID}:${type}:${data.ordinal}`,
          type,
        );
        part.text = data.text;
        return this.message(sessionID, data.assistantMessageID, created, 'assistant', [part]);
      }
      case 'session.step.started':
        return this.message(
          sessionID,
          event.data.assistantMessageID,
          event.data.started,
          'assistant',
          [],
        );
      case 'session.synthetic': {
        const id = `lcm-synthetic-${event.id}`;
        const part = emptyPart(sessionID, id, `${id}:text`, 'text');
        part.text = event.data.text;
        return this.message(sessionID, id, created, 'user', [part]);
      }
      case 'session.tool.input.started': {
        this.tools.set(`${sessionID}:${event.data.id}`, { name: lcmToolName(event.data.name) });
        const oldestTool = this.tools.keys().next().value;
        if (this.tools.size > 4096 && oldestTool !== undefined) this.tools.delete(oldestTool);
        return [];
      }
      case 'session.tool.called': {
        const tool = this.tools.get(`${sessionID}:${event.data.id}`);
        if (tool) tool.input = event.data.input;
        return [];
      }
      case 'session.tool.success':
      case 'session.tool.failed': {
        const data = event.data;
        const key = `${sessionID}:${data.id}`;
        const tool = this.tools.get(key);
        this.tools.delete(key);
        // A subscription started mid-call cannot recover the tool name safely.
        if (!tool) return [];
        const part = emptyPart(
          sessionID,
          data.assistantMessageID,
          `${data.assistantMessageID}:tool:${data.id}`,
          'tool',
        );
        part.tool = tool.name;
        part.callID = data.id;
        part.state = {
          status: event.type === 'session.tool.success' ? 'completed' : 'error',
          input: tool.input,
          output: (data.content ?? [])
            .flatMap((item) => (item.type === 'text' ? [item.text] : []))
            .join('\n'),
          error: 'error' in data ? data.error.message : '',
          metadata: data.metadata,
          attachments: (data.content ?? []).flatMap((item, index) =>
            item.type === 'file'
              ? [
                  {
                    ...emptyPart(
                      sessionID,
                      data.assistantMessageID,
                      `${part.id}:file:${index}`,
                      'file',
                    ),
                    url: item.uri,
                    mime: item.mime,
                    filename: item.name,
                  },
                ]
              : [],
          ),
        };
        return this.message(sessionID, data.assistantMessageID, created, 'assistant', [part]);
      }
      case 'session.compaction.ended': {
        const id = `lcm-compaction-${event.id}`;
        const part = emptyPart(sessionID, id, `${id}:text`, 'text');
        part.text = event.data.text;
        return [
          ...this.message(sessionID, id, created, 'assistant', [part]),
          this.event('session.compacted', sessionID, created, { sessionID }),
        ];
      }
      default:
        return [];
    }
  }

  clear(): void {
    this.seen.clear();
    this.sessions.clear();
    this.tools.clear();
    this.messageTimes.clear();
  }
}
