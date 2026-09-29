import { randomUUID } from 'node:crypto';
import Plugin from '../dist/index.js';
import { cleanupWorkspace, makeOptions, makeWorkspace } from './helpers.mjs';

export function v2Event(type, data, created = Date.now()) {
  return {
    id: randomUUID(),
    type,
    created,
    data,
    durable: { aggregateID: data.sessionID, seq: created, version: 1 },
  };
}

export async function pluginHarness(t, options = {}, settings = {}) {
  const directory = makeWorkspace('lcm-v2');
  const tools = {};
  const hooks = {};
  const registrations = [];
  const queue = [];
  let wake;
  let aborted = false;
  const register = () => {
    const registration = {
      disposed: 0,
      async dispose() {
        this.disposed++;
      },
    };
    registrations.push(registration);
    return registration;
  };
  const context = {
    location: { directory },
    options: makeOptions(options),
    tool: {
      async transform(callback) {
        callback({
          add(tool) {
            tools[tool.name] = tool;
          },
        });
        return register();
      },
    },
    session: {
      async get({ sessionID }) {
        return {
          id: sessionID,
          location: { directory },
          time: { created: 1, updated: 1 },
          title: sessionID,
        };
      },
      async hook(name, callback) {
        if (settings.failHook === name) throw new Error('registration failed');
        hooks[name] ??= [];
        hooks[name].push(callback);
        return register();
      },
    },
    event: {
      async *subscribe({ signal }) {
        const abort = () => {
          aborted = true;
          wake?.();
        };
        signal.addEventListener('abort', abort, { once: true });
        try {
          if (settings.failStream) throw new Error('stream failed');
          while (!signal.aborted) {
            if (!queue.length)
              await new Promise((resolve) => {
                wake = resolve;
              });
            if (signal.aborted) break;
            const item = queue.shift();
            yield item.event;
            item.done();
          }
        } finally {
          signal.removeEventListener('abort', abort);
        }
      },
    },
  };
  let cleanup;
  t.after(async () => {
    try {
      await cleanup?.();
    } catch (error) {
      if (!context.expectedCleanupError?.test(error.message)) throw error;
    }
    await cleanupWorkspace(directory);
  });
  const harness = {
    directory,
    context,
    tools,
    hooks,
    registrations,
    get aborted() {
      return aborted;
    },
    async start() {
      cleanup = await Plugin.setup(context);
      return cleanup;
    },
    async close() {
      await cleanup?.();
    },
    async emit(event) {
      await new Promise((done) => {
        queue.push({ event, done });
        wake?.();
      });
    },
    async hook(name, input) {
      for (const callback of hooks[name] ?? []) await callback(input);
    },
    async tool(name, input = {}, sessionID = 's1') {
      const result = await tools[name].execute(input, {
        sessionID,
        messageID: 'tool-message',
        id: 'call-id',
        agent: 'build',
        signal: new AbortController().signal,
        async progress() {},
      });
      return result.content;
    },
    async prompt(text, messageID = randomUUID(), sessionID = 's1') {
      await harness.hook('prompt', { sessionID, messageID, prompt: { text }, delivery: 'now' });
    },
    async session(sessionID = 's1', parentID) {
      await harness.emit(
        v2Event('session.created', {
          sessionID,
          parentID,
          title: sessionID,
          slug: sessionID,
          projectID: 'project',
          location: { directory },
          version: '2',
        }),
      );
    },
  };
  if (!settings.manualStart) await harness.start();
  return harness;
}

export function modelContext(messages, sessionID = 's1') {
  return {
    sessionID,
    messages,
    system: [],
    tools: {},
    agent: 'build',
    model: { providerID: 'test', modelID: 'test' },
    options: {},
  };
}

export function textMessage(id, text, role = 'user') {
  return { id, role, content: [{ type: 'text', text }] };
}
