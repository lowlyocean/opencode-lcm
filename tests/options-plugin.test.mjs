import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import OpencodeLcmPlugin from '../dist/index.js';
import { DEFAULT_OPTIONS, resolveOptions } from '../dist/options.js';
import { modelContext, pluginHarness, textMessage } from './v2-helpers.mjs';

const ALLOW_UNSAFE_BUN_WINDOWS_ENV = 'OPENCODE_LCM_ALLOW_UNSAFE_BUN_WINDOWS';

async function withSimulatedBunWindows(run) {
  const hadBun = 'Bun' in globalThis;
  const previousBun = globalThis.Bun;
  const previousAllowUnsafe = process.env[ALLOW_UNSAFE_BUN_WINDOWS_ENV];
  const previousSqliteRuntime = process.env.OPENCODE_LCM_SQLITE_RUNTIME;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

  try {
    globalThis.Bun = { version: '1.3.11' };
    delete process.env[ALLOW_UNSAFE_BUN_WINDOWS_ENV];
    delete process.env.OPENCODE_LCM_SQLITE_RUNTIME;
    Object.defineProperty(process, 'platform', {
      configurable: true,
      enumerable: true,
      value: 'win32',
    });
    await run();
  } finally {
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }
    if (previousAllowUnsafe === undefined) delete process.env[ALLOW_UNSAFE_BUN_WINDOWS_ENV];
    else process.env[ALLOW_UNSAFE_BUN_WINDOWS_ENV] = previousAllowUnsafe;
    if (previousSqliteRuntime === undefined) delete process.env.OPENCODE_LCM_SQLITE_RUNTIME;
    else process.env.OPENCODE_LCM_SQLITE_RUNTIME = previousSqliteRuntime;
    if (hadBun) globalThis.Bun = previousBun;
    else delete globalThis.Bun;
  }
}

test('resolveOptions normalizes malformed plugin config', () => {
  const resolved = resolveOptions({
    interop: {
      contextMode: false,
      ignoreToolPrefixes: ['custom_', '', 42],
    },
    scopeDefaults: {
      grep: 'bogus',
      describe: 'all',
    },
    scopeProfiles: [
      null,
      {},
      { worktree: '' },
      { worktree: 'C:/repo/a', grep: 'all', describe: 'invalid' },
    ],
    retention: {
      staleSessionDays: -1,
      deletedSessionDays: -4,
      orphanBlobDays: 7,
    },
    privacy: {
      excludeToolPrefixes: ['secret_', '', 42],
      excludePathPatterns: ['fixtures[/\\\\]private', null, ''],
      redactPatterns: ['token_[0-9]+', false, ''],
    },
    automaticRetrieval: {
      enabled: false,
      maxChars: Number.NaN,
      minTokens: Number.NaN,
      maxMessageHits: 3,
      maxSummaryHits: Number.NaN,
      maxArtifactHits: 2,
      scopeOrder: ['worktree', 'bogus', 'session', 'worktree'],
      scopeBudgets: { session: -1, root: 4, worktree: 0, all: Number.NaN },
      stop: { targetHits: -1, stopOnFirstScopeWithHits: true },
    },
    compactContextLimit: Number.NaN,
    previewBytePeek: Number.NaN,
    systemHint: false,
    binaryPreviewProviders: [],
    summaryV2: {
      strategy: 'bogus',
      perMessageBudget: 90,
    },
    runtimeSafety: {
      allowUnsafeBunWindows: 'yes',
    },
  });

  assert.equal('contextMode' in resolved.interop, false);
  assert.deepEqual(resolved.interop.ignoreToolPrefixes, ['custom_']);
  assert.deepEqual(resolved.scopeDefaults, { grep: 'session', describe: 'all' });
  assert.deepEqual(resolved.scopeProfiles, [
    { worktree: 'C:/repo/a', grep: 'all', describe: 'session' },
  ]);
  assert.equal(resolved.retention.staleSessionDays, undefined);
  assert.equal(resolved.retention.deletedSessionDays, undefined);
  assert.equal(resolved.retention.orphanBlobDays, 7);
  assert.deepEqual(resolved.privacy, {
    excludeToolPrefixes: ['secret_'],
    excludePathPatterns: ['fixtures[/\\\\]private'],
    redactPatterns: ['token_[0-9]+'],
  });
  assert.equal(resolved.automaticRetrieval.enabled, false);
  assert.equal(resolved.automaticRetrieval.maxChars, DEFAULT_OPTIONS.automaticRetrieval.maxChars);
  assert.equal(resolved.automaticRetrieval.minTokens, DEFAULT_OPTIONS.automaticRetrieval.minTokens);
  assert.equal(resolved.automaticRetrieval.maxMessageHits, 3);
  assert.equal(
    resolved.automaticRetrieval.maxSummaryHits,
    DEFAULT_OPTIONS.automaticRetrieval.maxSummaryHits,
  );
  assert.equal(resolved.automaticRetrieval.maxArtifactHits, 2);
  assert.deepEqual(resolved.automaticRetrieval.scopeOrder, ['worktree', 'session']);
  assert.deepEqual(resolved.automaticRetrieval.scopeBudgets, {
    session: DEFAULT_OPTIONS.automaticRetrieval.scopeBudgets.session,
    root: 4,
    worktree: 0,
    all: DEFAULT_OPTIONS.automaticRetrieval.scopeBudgets.all,
  });
  assert.deepEqual(resolved.automaticRetrieval.stop, {
    targetHits: DEFAULT_OPTIONS.automaticRetrieval.stop.targetHits,
    stopOnFirstScopeWithHits: true,
  });
  assert.equal(resolved.compactContextLimit, DEFAULT_OPTIONS.compactContextLimit);
  assert.equal(resolved.previewBytePeek, DEFAULT_OPTIONS.previewBytePeek);
  assert.equal(resolved.systemHint, false);
  assert.deepEqual(resolved.binaryPreviewProviders, DEFAULT_OPTIONS.binaryPreviewProviders);
  assert.deepEqual(resolved.summaryV2, {
    strategy: DEFAULT_OPTIONS.summaryV2.strategy,
    perMessageBudget: 90,
  });
  assert.deepEqual(resolved.runtimeSafety, {
    allowUnsafeBunWindows: false,
  });
});

for (const [label, config, env, backend] of [
  ['default safety', false, false, 'node_sidecar'],
  ['config cannot bypass safety', true, false, 'node_sidecar'],
  ['explicit environment override', false, true, 'in_process'],
]) {
  test(`Bun Windows: ${label}`, async (t) => {
    await withSimulatedBunWindows(async () => {
      if (env) process.env[ALLOW_UNSAFE_BUN_WINDOWS_ENV] = '1';
      const h = await pluginHarness(t, { runtimeSafety: { allowUnsafeBunWindows: config } });
      await h.session();
      await h.prompt('sidecar preserved core functionality', 'user-1');
      assert.match(await h.tool('lcm_status'), new RegExp(`runtime_safety_backend=${backend}`));
      assert.match(await h.tool('lcm_describe'), /sidecar preserved core functionality/);
      const compaction = modelContext([]);
      await h.hook('compaction', compaction);
      assert.match(compaction.system[0].text, /LCM prototype resume note/);
      await h.close();
      assert.ok(h.aborted);
      assert.ok(h.registrations.every((r) => r.disposed === 1));
    });
  });
}

test('V2 plugin exports setup and registers all LCM tools', async (t) => {
  assert.equal(OpencodeLcmPlugin.id, 'opencode-lcm');
  assert.equal(typeof OpencodeLcmPlugin.setup, 'function');
  const h = await pluginHarness(t);
  assert.deepEqual(
    Object.keys(h.tools).sort(),
    [
      'lcm_artifact',
      'lcm_blob_gc',
      'lcm_blob_stats',
      'lcm_compact',
      'lcm_describe',
      'lcm_doctor',
      'lcm_expand',
      'lcm_export_snapshot',
      'lcm_grep',
      'lcm_import_snapshot',
      'lcm_lineage',
      'lcm_pin_session',
      'lcm_retrieval_debug',
      'lcm_retention_report',
      'lcm_retention_prune',
      'lcm_resume',
      'lcm_status',
      'lcm_unpin_session',
    ].sort(),
  );
  assert.match(
    await h.tool('lcm_import_snapshot', { filePath: 'unused.json' }),
    /mode is required/,
  );
});

test('context hook respects disabled system hint and keeps native messages below threshold', async (t) => {
  const h = await pluginHarness(t, { systemHint: false });
  const context = modelContext([textMessage('m1', 'unchanged')]);
  const before = structuredClone(context);
  await h.hook('context', context);
  assert.deepEqual(context, before);
});

test('Bun Windows exposes disposable safe-mode status when Node cannot start', async (t) => {
  await withSimulatedBunWindows(async () => {
    const previous = process.env.OPENCODE_LCM_NODE_PATH;
    const h = await pluginHarness(t, {}, { manualStart: true });
    try {
      process.env.OPENCODE_LCM_NODE_PATH = path.join(h.directory, 'missing-node.exe');
      await h.start();
      assert.deepEqual(Object.keys(h.tools), ['lcm_status']);
      assert.match(await h.tool('lcm_status'), /reason=bun_windows_runtime_guard/);
      await h.close();
      assert.equal(h.registrations[0].disposed, 1);
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_LCM_NODE_PATH;
      else process.env.OPENCODE_LCM_NODE_PATH = previous;
    }
  });
});
