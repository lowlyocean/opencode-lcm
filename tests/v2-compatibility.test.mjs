import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Media } from '@opencode/ai';
import { getLogger, setLogger } from '../dist/logging.js';
import { SqliteLcmStore } from '../dist/store.js';
import { transformV2Messages } from '../dist/v2-messages.js';
import { modelContext, pluginHarness, textMessage, v2Event } from './v2-helpers.mjs';

test('terminal V2 events archive text, reasoning and tools exactly once; deltas are ignored', async (t) => {
  const h = await pluginHarness(t, { freshTailMessages: 1 });
  await h.session();
  await h.prompt('user original decision quartz protocol', 'u1');
  const data = { sessionID: 's1', assistantMessageID: 'a1', ordinal: 0 };
  await h.emit(v2Event('session.text.delta', { ...data, delta: 'partial-stream' }));
  const text = v2Event('session.text.ended', { ...data, text: 'assistant terminal quartz answer' });
  await h.emit(text);
  await h.emit(text);
  await h.emit(v2Event('session.reasoning.ended', { ...data, text: 'quartz reasoning retained' }));
  const tool = { sessionID: 's1', assistantMessageID: 'a1', id: 'tool1' };
  await h.emit(v2Event('session.tool.input.started', { ...tool, name: 'read' }));
  await h.emit(
    v2Event('session.tool.called', { ...tool, input: { file: 'quartz.txt' }, executed: false }),
  );
  await h.emit(
    v2Event('session.tool.success', {
      ...tool,
      content: [{ type: 'text', text: 'quartz tool completed' }],
      executed: false,
    }),
  );
  const failed = { ...tool, id: 'tool2' };
  await h.emit(v2Event('session.tool.input.started', { ...failed, name: 'shell' }));
  await h.emit(
    v2Event('session.tool.failed', {
      ...failed,
      error: { type: 'error', message: 'quartz tool failure' },
      executed: false,
    }),
  );
  const ignored = { ...tool, id: 'tool3' };
  await h.emit(
    v2Event('session.tool.input.started', { ...ignored, name: 'context-mode_ctx_search' }),
  );
  await h.emit(
    v2Event('session.tool.success', {
      ...ignored,
      content: [{ type: 'text', text: 'infrastructure-secret-needle' }],
      executed: false,
    }),
  );
  await h.prompt('fresh follow up', 'u2');
  const snapshotPath = path.join(h.directory, 'snapshot.json');
  await h.tool('lcm_export_snapshot', { filePath: snapshotPath });
  const snapshot = await readFile(snapshotPath, 'utf8');
  assert.match(snapshot, /user original decision quartz protocol/);
  assert.match(snapshot, /assistant terminal quartz answer/);
  assert.match(snapshot, /quartz reasoning retained/);
  assert.match(snapshot, /quartz tool completed/);
  assert.match(snapshot, /quartz tool failure/);
  assert.doesNotMatch(snapshot, /partial-stream/);
  const before = await h.tool('lcm_status');
  await h.emit(text);
  assert.equal(await h.tool('lcm_status'), before);
  assert.doesNotMatch(
    await h.tool('lcm_grep', { query: 'infrastructure-secret-needle' }),
    /infrastructure-secret-needle/,
  );
  assert.match(await h.tool('lcm_grep', { query: 'quartz' }), /session=s1/);
});

for (const sidecar of [false, true]) {
  test(`recall reaches final V2 model context${sidecar ? ' through Node sidecar' : ''}`, async (t) => {
    const originalBun = globalThis.Bun;
    const hadBun = 'Bun' in globalThis;
    if (sidecar && process.platform === 'win32') globalThis.Bun = { version: 'test' };
    t.after(() => {
      if (hadBun) globalThis.Bun = originalBun;
      else delete globalThis.Bun;
    });
    const h = await pluginHarness(t, {
      freshTailMessages: 1,
      minMessagesForTransform: 3,
      automaticRetrieval: { minTokens: 1, maxChars: 3000 },
    });
    await h.session();
    await h.prompt('The quartz protocol access code is violet-otter-738.', 'old-1');
    await h.prompt('Continue the unrelated deployment.', 'old-2');
    await h.prompt('Deployment complete.', 'old-3');
    // The requested fact is absent from the incoming model context.
    const context = modelContext([
      textMessage('current-1', 'Earlier discussion'),
      textMessage('current-2', 'Deployment complete', 'assistant'),
      textMessage('current-3', 'What is the quartz protocol access code?'),
    ]);
    assert.doesNotMatch(JSON.stringify(context.messages), /violet-otter-738/);
    await h.hook('context', context);
    const recalled = context.messages
      .flatMap((message) => message.content)
      .filter((part) => part.metadata?.opencodeLcm === 'retrieved-context');
    assert.equal(recalled.length, 1);
    assert.match(recalled[0].text, /violet-otter-738/);
    assert.match(context.messages[0].content[0].text, /Archived by opencode-lcm/);
    assert.equal(context.messages[2].content[0].text, 'What is the quartz protocol access code?');
    await h.hook('context', context);
    const markers = context.messages
      .flatMap((message) => message.content)
      .map((part) => part.metadata?.opencodeLcm);
    assert.equal(markers.filter((marker) => marker === 'retrieved-context').length, 1);
    assert.equal(markers.filter((marker) => marker === 'archive-summary').length, 1);
    assert.equal(context.system.length, 1);
    assert.match(await h.tool('lcm_retrieval_debug'), /status=recalled/);
    await h.close();
  });
}

test('native tool pairing, media, checkpoints and provider metadata survive context transformation', async (t) => {
  const h = await pluginHarness(t, { freshTailMessages: 1, minMessagesForTransform: 3 });
  const media = {
    type: 'media',
    media: new Media.Asset({ source: { type: 'base64', data: 'aGk=', mediaType: 'text/plain' } }),
  };
  const checkpoint = { type: 'compaction', provider: 'test', encrypted: 'opaque-checkpoint' };
  const call = {
    type: 'tool-call',
    id: 'pair1',
    name: 'context-mode_ctx_search',
    input: { query: 'needle' },
    providerMetadata: { test: { opaque: 'keep' } },
  };
  const context = modelContext([
    textMessage('u0', 'Earlier task instruction'),
    {
      id: 'a1',
      role: 'assistant',
      content: [call, checkpoint, { type: 'effort', effort: 'high' }],
    },
    {
      id: 't1',
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          id: 'pair1',
          name: 'context-mode_ctx_search',
          result: { type: 'text', value: 'infrastructure payload' },
        },
      ],
    },
    { id: 'u1', role: 'user', content: [{ type: 'text', text: 'fresh request' }, media] },
  ]);
  await h.hook('context', context);
  assert.deepEqual(context.messages[1].content[0], call);
  assert.strictEqual(context.messages[1].content[1], checkpoint);
  assert.strictEqual(context.messages[3].content[1], media);
  assert.equal(context.messages[2].content[0].id, 'pair1');
  assert.match(context.messages[2].content[0].result.value, /infrastructure tool output omitted/);
  assert.doesNotMatch(context.messages[3].content.at(-1).text, /ctx_search|infrastructure payload/);
});

test('compaction and resume context reach native system parts and deduplicate', async (t) => {
  const h = await pluginHarness(t);
  await h.session();
  await h.prompt('Keep the quartz deployment decision.', 'u1');
  const context = modelContext([]);
  await h.hook('compaction', context);
  await h.hook('compaction', context);
  assert.equal(context.system.length, 1);
  assert.match(context.system[0].text, /LCM prototype resume note/);
  assert.match(context.system[0].text, /quartz/);
  await h.emit(
    v2Event('session.compaction.ended', {
      sessionID: 's1',
      reason: 'manual',
      text: 'quartz compaction terminal summary',
      recent: 'u1',
    }),
  );
  assert.match(await h.tool('lcm_describe'), /quartz compaction terminal summary/);
  assert.match(await h.tool('lcm_resume'), /quartz/);
});

test('current-session tool fallback and explicit other-session selection', async (t) => {
  const h = await pluginHarness(t);
  await h.session('s1');
  await h.prompt('first-session-unique', 'u1', 's1');
  await h.session('s2', 's1');
  await h.prompt('second-session-unique', 'u2', 's2');
  assert.match(await h.tool('lcm_describe', {}, 's1'), /first-session-unique/);
  assert.doesNotMatch(await h.tool('lcm_describe', {}, 's1'), /second-session-unique/);
  assert.match(await h.tool('lcm_describe', { sessionID: 's2' }, 's1'), /second-session-unique/);
  assert.match(await h.tool('lcm_doctor', {}, 's2'), /checked_scope=session:s2/);
  assert.match(await h.tool('lcm_lineage', {}, 's2'), /s1/);
  await h.tool('lcm_pin_session', {}, 's2');
  assert.match(await h.tool('lcm_status'), /pinned_sessions=1/);
  await h.tool('lcm_unpin_session', {}, 's2');
  assert.match(await h.tool('lcm_status'), /pinned_sessions=0/);
});

test('cleanup aborts subscription, disposes once, and closes SQLite even with pending capture', async (t) => {
  const h = await pluginHarness(t);
  await h.session();
  await h.prompt('pending archive survives shutdown', 'u1');
  await h.close();
  await h.close();
  assert.ok(h.aborted);
  assert.equal(h.registrations.length, 4);
  assert.ok(h.registrations.every((registration) => registration.disposed === 1));
  // Reopen the actual archive and prove shutdown flushed deferred parts.
  const store = new SqliteLcmStore(h.directory, h.context.options);
  try {
    assert.match(await store.describe({ sessionID: 's1' }), /pending archive survives shutdown/);
  } finally {
    await store.close();
  }
});

test('partial setup failure cleans up registrations and the subscription', async (t) => {
  const h = await pluginHarness(t, {}, { manualStart: true, failHook: 'context' });
  await assert.rejects(h.start(), /registration failed/);
  assert.ok(h.aborted);
  assert.ok(h.registrations.every((registration) => registration.disposed === 1));
});

test('a failing registration disposer does not prevent other disposal or archive closure', async (t) => {
  const h = await pluginHarness(t);
  await h.session();
  await h.prompt('flush despite disposal failure', 'u1');
  h.registrations[0].dispose = () => {
    throw new Error('dispose failed');
  };
  await assert.rejects(h.close(), /dispose failed/);
  assert.ok(h.registrations.slice(1).every((registration) => registration.disposed === 1));
  const store = new SqliteLcmStore(h.directory, h.context.options);
  try {
    assert.match(await store.describe({ sessionID: 's1' }), /flush despite disposal failure/);
  } finally {
    await store.close();
  }
  // Teardown sees the same rejected idempotent cleanup promise.
  h.context.expectedCleanupError = /dispose failed/;
});

test('native messages sharing an ID keep their own content and idless messages gain stable IDs', async (t) => {
  const h = await pluginHarness(t, { freshTailMessages: 1, minMessagesForTransform: 3 });
  const context = modelContext([
    textMessage('shared', 'original user text'),
    textMessage('shared', 'original assistant text', 'assistant'),
    { role: 'user', content: [{ type: 'text', text: 'current request' }] },
  ]);
  await h.hook('context', context);
  const id = context.messages[2].id;
  assert.ok(id);
  assert.equal(context.messages[0].role, 'user');
  assert.equal(context.messages[1].role, 'assistant');
  await h.hook('context', context);
  assert.equal(context.messages[2].id, id);
  assert.equal(
    context.messages[2].content.filter((part) => part.metadata?.opencodeLcm === 'archive-summary')
      .length,
    1,
  );
});

test('optional context and subscription failures are contained; failed transforms do not mutate host messages', async (t) => {
  const logger = getLogger();
  const warnings = [];
  setLogger({
    debug() {},
    info() {},
    error() {},
    warn(message, context) {
      warnings.push({ message, context });
    },
  });
  t.after(() => setLogger(logger));
  const h = await pluginHarness(t, {}, { failStream: true });
  await h.hook('context', modelContext(null));
  assert.match(await h.tool('lcm_status'), /op=chat.messages.transform/);
  assert.ok(warnings.some((warning) => warning.context.operation === 'event.subscribe'));
  const messages = [textMessage('u1', 'preserve this')];
  const before = structuredClone(messages);
  await assert.rejects(
    transformV2Messages(
      {
        async transformMessages(local) {
          local[0].parts[0].text = 'partial mutation';
          throw new Error('store failed');
        },
      },
      's1',
      messages,
    ),
    /store failed/,
  );
  assert.deepEqual(messages, before);
});

test('real store failures leave optional prompt and compaction hooks usable while explicit tools report errors', async (t) => {
  const previous = process.env.OPENCODE_LCM_SQLITE_RUNTIME;
  process.env.OPENCODE_LCM_SQLITE_RUNTIME = 'bun';
  try {
    const h = await pluginHarness(t);
    await assert.doesNotReject(h.prompt('prompt survives unavailable SQLite', 'u1'));
    const context = modelContext([textMessage('u1', 'keep original text')]);
    const before = structuredClone(context.messages);
    await assert.doesNotReject(h.hook('context', context));
    assert.deepEqual(context.messages, before);
    const compaction = modelContext([]);
    await assert.doesNotReject(h.hook('compaction', compaction));
    assert.deepEqual(compaction.system, []);
    await assert.rejects(h.tool('lcm_status'));
    await h.close();
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_LCM_SQLITE_RUNTIME;
    else process.env.OPENCODE_LCM_SQLITE_RUNTIME = previous;
  }
});

test('cleanup waits for an in-flight context hook before closing its store', async (t) => {
  const h = await pluginHarness(t);
  const get = h.context.session.get;
  let release;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  h.context.session.get = async (input) => {
    entered();
    await barrier;
    return get(input);
  };
  const context = modelContext([textMessage('u1', 'current text')]);
  const running = h.hook('context', context);
  await started;
  let closed = false;
  const closing = h.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release();
  await Promise.all([running, closing]);
  assert.ok(h.registrations.every((registration) => registration.disposed === 1));
});
