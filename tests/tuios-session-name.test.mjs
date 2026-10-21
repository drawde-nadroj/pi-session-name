import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install, DEFAULTS, STATE_TYPE, loadConfig, validName, namingFailure, failureDiagnostic } from '../extensions/tuios-session-name.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
const answer = name => ({ stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'rename_current_session', arguments: { name } }], usage: { input: 20, output: 5 } });
function setup(options = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, { TUIOS_ENV: options.outside ? '0' : '1', TUIOS_WINDOW_ID: 'test-window', TUIOS_SESSION: 'test-session' });
  if (options.noTuios) for (const key of ['TUIOS_ENV', 'TUIOS_WINDOW_ID', 'TUIOS_SESSION']) delete process.env[key];
  if (options.partialTuios) delete process.env.TUIOS_WINDOW_ID;
  const handlers = {}, commands = {}, calls = [], warnings = [], requests = [], entries = structuredClone(options.entries ?? []);
  let piName = options.name, windowName = options.windowName ?? '', onEvent, onFailed, closed = false;
  let result = options.result ?? answer('Useful session title');
  const ctx = {
    mode: options.mode ?? 'tui',
    ui: { notify: (...args) => warnings.push(args) },
    sessionManager: { getEntries: () => entries },
    modelRegistry: {
      find: (provider, model) => options.missingModel ? undefined : { provider, id: model },
      streamSimple: (model, context, opts) => {
        requests.push({ model, context, opts });
        return { result: async () => typeof result === 'function' ? result(opts) : result };
      },
    },
  };
  const pi = {
    on: (event, handler) => { handlers[event] = handler; },
    registerCommand: (name, definition) => { commands[name] = definition; },
    getSessionName: () => piName,
    setSessionName: name => {
      piName = name || undefined;
      void handlers.session_info_changed?.({ name: piName }, ctx);
    },
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data: structuredClone(data) }),
    exec: async (command, args, opts) => {
      calls.push({ command, args, opts });
      if (options.exec) {
        const special = await options.exec(command, args);
        if (special) return special;
      }
      if (args[0] === 'list-windows') return { code: 0, killed: false, stdout: JSON.stringify({ windows: [{ window_id: 'test-window', custom_name: windowName }] }) };
      assert.equal(args[0], 'set-window');
      windowName = args.at(-1);
      // Real stream and CLI result ordering can differ; the default mock emits before the result.
      if (!options.deferEcho) onEvent?.({ type: 'window-retitled', window: 'test-window', title: windowName });
      return { code: 0, killed: false, stdout: '' };
    },
  };
  let api;
  try {
    api = install(pi, {
      config: () => { if (options.badConfig) throw new Error('bad'); return { ...DEFAULTS, ...options.config }; },
      watch: (args, event, failed) => {
        assert.ok(!options.outside && !options.noTuios && !options.partialTuios, 'standalone mode must not start a TUIOS watcher');
        onEvent = event; onFailed = failed;
        assert.deepEqual(args, ['subscribe', '--session', 'test-session', '--window', 'test-window', '--types', 'window-retitled']);
        return { ready: options.ready ?? Promise.resolve(), close: () => { closed = true; } };
      },
    });
  } finally { process.env = saved; }
  const emit = (type, data = {}) => handlers[type]?.(data, ctx);
  return {
    api, emit, calls, warnings, requests, entries, handlers, commands,
    input: text => emit('input', { source: 'interactive', text }),
    start: () => emit('session_start', { reason: 'startup' }),
    idle: async () => { await api?.idle(); await tick(); await api?.idle(); },
    manualPi: name => { piName = name || undefined; return emit('session_info_changed', { name: piName }); },
    manualWindow: name => { windowName = name; onEvent({ type: 'window-retitled', window: 'test-window', title: name }); },
    wire: event => onEvent(event), disconnect: () => onFailed(),
    setResult: value => { result = value; },
    get name() { return piName; }, get windowName() { return windowName; }, get closed() { return closed; },
  };
}

test('ordinary Pi names automatically without any TUIOS processes or environment', async () => {
  for (const options of [{ outside: true }, { noTuios: true }, { partialTuios: true }]) {
    const h = setup(options); await h.start(); h.input('Build a garden planner'); await h.idle();
    assert.equal(h.name, 'Useful session title');
    assert.equal(h.api.state().locked, false);
    assert.equal(h.requests.length, 1);
    assert.equal(h.api.state().windowId, '');
    assert.deepEqual(h.calls, []);
    await h.commands['name-status'].handler('', { ui: { notify: message => assert.match(message, /TUIOS sync: off/) } });
    await h.emit('session_shutdown');
    assert.equal(h.closed, false);
  }
});

test('standalone manual name wins during inference and survives resume', async () => {
  let finish;
  const h = setup({ noTuios: true, result: () => new Promise(resolve => { finish = resolve; }) });
  await h.start(); h.input('Subject'); await tick();
  await h.manualPi('Human title');
  assert.equal(h.requests[0].opts.signal.aborted, true);
  finish(answer('Late title')); await h.idle();
  assert.equal(h.name, 'Human title');
  const resumed = setup({ noTuios: true, name: h.name, entries: h.entries });
  await resumed.start(); resumed.input('Another topic'); await resumed.idle();
  assert.equal(resumed.api.state().locked, true);
  assert.equal(resumed.requests.length, 0);
  assert.deepEqual(h.calls, []); assert.deepEqual(resumed.calls, []);
});

test('standalone resume keeps automatic titles unlocked and /new clears inherited names', async () => {
  const h = setup({ noTuios: true }); await h.start(); h.input('Subject'); await h.idle();
  const resumed = setup({ noTuios: true, name: h.name, entries: h.entries });
  await resumed.start(); resumed.input('Next subject'); await resumed.idle();
  assert.equal(resumed.requests.length, 1); assert.equal(resumed.api.state().locked, false);
  const fresh = setup({ noTuios: true, name: 'Inherited title' });
  await fresh.emit('session_start', { reason: 'new' });
  assert.equal(fresh.name, undefined); assert.equal(fresh.api.state().locked, false);
  fresh.input('Fresh subject'); await fresh.idle();
  assert.equal(fresh.name, 'Useful session title'); assert.deepEqual(fresh.calls, []);
  const manual = setup({ noTuios: true, name: 'Existing manual title' });
  await manual.start(); manual.input('Leave my title alone'); await manual.idle();
  assert.equal(manual.requests.length, 0); assert.equal(manual.name, 'Existing manual title');
});

test('standalone disabled and noninteractive modes make no requests', async () => {
  for (const options of [{ config: { enabled: false } }, { mode: 'rpc' }, { mode: 'print' }, { mode: 'json' }]) {
    const h = setup({ noTuios: true, ...options }); await h.start(); h.input('Ignored'); await h.idle();
    assert.equal(h.requests.length, 0); assert.deepEqual(h.calls, []);
  }
});

test('automatic call sees only bounded supplied text and one tool; own renames do not lock', async () => {
  const h = setup(); await h.start();
  assert.equal(h.input('Build a small garden planner'), undefined);
  await h.idle();
  assert.equal(h.name, 'Useful session title'); assert.equal(h.windowName, h.name);
  assert.equal(h.api.state().locked, false);
  assert.equal(h.requests.length, 1);
  const { context, opts, model } = h.requests[0];
  assert.deepEqual(model, { provider: 'openai', id: 'gpt-6-luna' });
  assert.deepEqual(context.tools.map(t => t.name), ['rename_current_session']);
  assert.deepEqual(Object.keys(context.tools[0].parameters.properties), ['name']);
  assert.equal(context.messages.length, 1);
  assert.deepEqual(JSON.parse(context.messages[0].content).recentUserMessages, ['Build a small garden planner']);
  assert.equal(opts.maxTokens, 160);
  assert.equal(opts.reasoning, 'minimal');
  assert.equal(h.api.state().inputTokens, 20);
  assert.equal(h.api.state().calls, 1);
});

test('manual Pi rename locks permanently, persists, and still syncs later human names', async () => {
  const h = setup(); await h.start(); h.input('First subject'); await h.idle();
  await h.manualPi('My own title'); h.input('Different subject'); await h.idle();
  assert.equal(h.requests.length, 1); assert.equal(h.windowName, 'My own title');
  assert.equal(h.api.state().locked, true);
  await h.emit('session_shutdown'); assert.equal(h.closed, true);
  const resumed = setup({ entries: h.entries, name: h.name, windowName: h.windowName });
  await resumed.start(); resumed.input('Resumed'); await resumed.idle();
  assert.equal(resumed.requests.length, 0); assert.equal(resumed.api.state().locked, true);
  resumed.manualWindow('Another human name'); await resumed.idle();
  assert.equal(resumed.name, 'Another human name');
});

test('manual window rename and clear lock, but OSC and other windows do not', async () => {
  const h = setup(); await h.start();
  h.wire({ type: 'window-retitled', window: 'test-window', pty_id: 'pty', title: 'OSC title' });
  h.wire({ type: 'window-retitled', window: 'other', title: 'Other' });
  assert.equal(h.api.state().locked, false);
  h.manualWindow('Chosen in TUIOS'); await h.idle();
  assert.equal(h.name, 'Chosen in TUIOS'); assert.equal(h.api.state().locked, true);
  h.manualWindow(''); await h.idle(); assert.equal(h.name, undefined);
});

test('manual rename during inference aborts and discards a late response', async () => {
  let finish;
  const h = setup({ result: () => new Promise(resolve => { finish = resolve; }) });
  await h.start(); h.input('Subject'); await tick();
  h.manualWindow('Human wins');
  assert.equal(h.requests[0].opts.signal.aborted, true);
  finish(answer('Late model title')); await h.idle();
  assert.equal(h.name, 'Human wins'); assert.equal(h.windowName, 'Human wins');
});

test('newer input invalidates old result, each message gets a bounded call', async () => {
  let finish;
  const h = setup({ config: { maxContextChars: 256 }, result: () => new Promise(resolve => { finish = resolve; }) });
  await h.start(); h.input('a'.repeat(400)); await tick(); h.input('Second topic');
  h.setResult(answer('Second topic title')); finish(answer('Old topic title')); await h.idle();
  assert.equal(h.requests.length, 2); assert.equal(h.name, 'Second topic title');
  for (const request of h.requests) assert.ok(JSON.parse(request.context.messages[0].content).recentUserMessages.join('\n').length <= 256);
});

test('rejects unexpected, multiple, oversized, control-character and extra-argument tool calls', async () => {
  const invalid = [
    { ...answer('Good title'), content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'bad' } }] },
    { ...answer('Good title'), content: [...answer('One').content, ...answer('Two').content] },
    answer('x'.repeat(61)), answer('Escape\u001btitle'), answer('two\nlines'), answer(''),
    { ...answer('Good title'), content: [{ type: 'toolCall', name: 'rename_current_session', arguments: { name: 'Fine title', window: 'other' } }] },
    { ...answer('Good title'), stopReason: 'length' },
  ];
  for (const result of invalid) {
    const h = setup({ result }); await h.start(); h.input('Test'); await h.idle();
    assert.equal(h.name, undefined); assert.equal(h.calls.filter(c => c.args[0] === 'set-window').length, 0);
    assert.equal(h.warnings.length, 1);
  }
});

test('no-op response, disabled config, noninteractive input and missing model are safe', async () => {
  const noop = setup({ result: { stopReason: 'stop', content: [] } }); await noop.start(); noop.input('Hello'); await noop.idle();
  assert.equal(noop.name, undefined); assert.equal(noop.warnings.length, 0);
  for (const options of [{ mode: 'rpc' }, { mode: 'print' }, { config: { enabled: false } }]) {
    const h = setup(options); await h.start(); h.input('Ignored'); await h.idle(); assert.equal(h.requests.length, 0);
  }
  const h = setup({ missingModel: true }); await h.start();
  h.emit('input', { source: 'extension', text: 'Synthetic' }); await h.idle(); assert.equal(h.warnings.length, 0);
  h.input('User'); await h.idle(); h.input('Retry'); await h.idle(); assert.equal(h.warnings.length, 1);
});

test('existing names and external changes during downtime conservatively lock', async () => {
  for (const options of [{ name: 'Existing Pi name' }, { windowName: 'Existing window name' }]) {
    const h = setup(options); await h.start(); assert.equal(h.api.state().locked, true);
    assert.equal(h.name, h.windowName);
  }
  const h = setup(); await h.start(); h.input('Topic'); await h.idle();
  const resumed = setup({ entries: h.entries, name: h.name, windowName: '' }); await resumed.start();
  assert.equal(resumed.api.state().locked, true); assert.equal(resumed.name, undefined);
});

test('/new clears inherited Pi and window names without locking automatic naming', async () => {
  for (const deferEcho of [false, true]) {
    const h = setup({ name: 'Old session', windowName: 'Old window', deferEcho });
    await h.emit('session_start', { reason: 'new' });
    await h.idle();
    assert.equal(h.name, undefined);
    assert.equal(h.windowName, '');
    assert.equal(h.api.state().locked, false);
    assert.equal(h.api.state().calls, 0);
    assert.deepEqual(h.api.state().recent, []);
    if (deferEcho) h.wire({ type: 'window-retitled', window: 'test-window', title: '' });
    h.input('A new topic'); await h.idle();
    assert.equal(h.name, 'Useful session title');
    assert.equal(h.windowName, h.name);
    assert.equal(h.api.state().locked, false);
  }
});

test('/new clears the window with automatic model calls disabled', async () => {
  const h = setup({ windowName: 'Previous title', config: { enabled: false } });
  await h.emit('session_start', { reason: 'new' });
  assert.equal(h.name, undefined); assert.equal(h.windowName, '');
  h.input('No model call'); await h.idle();
  assert.equal(h.requests.length, 0);
});

test('reload and resume retain conservative window-name ownership', async () => {
  for (const reason of ['reload', 'resume']) {
    const h = setup({ windowName: 'Keep my name' });
    await h.emit('session_start', { reason });
    assert.equal(h.name, 'Keep my name');
    assert.equal(h.api.state().locked, true);
  }
});

test('disconnect and event gaps pause naming; invalid config is inert', async () => {
  for (const disconnect of [h => h.disconnect(), h => h.wire({ type: 'gap' })]) {
    const h = setup(); await h.start(); disconnect(h); h.input('No call'); await h.idle();
    assert.equal(h.requests.length, 0); assert.equal(h.warnings.length, 1);
  }
  const h = setup({ badConfig: true }); await h.start(); assert.equal(h.calls.length, 0); assert.equal(h.warnings.length, 1);
});

test('session switch discards old inference and restores independent state', async () => {
  let finish;
  const h = setup({ result: () => new Promise(resolve => { finish = resolve; }) });
  await h.start(); h.input('Old session'); await tick();
  await h.emit('session_shutdown');
  assert.equal(h.requests[0].opts.signal.aborted, true);
  finish(answer('Should not apply')); await tick();
  assert.equal(h.name, undefined);
});

test('late automatic window echo restores the human name', async () => {
  let release, entered;
  const writeStarted = new Promise(resolve => { entered = resolve; });
  let first = true;
  const h = setup({ exec: async (_cmd, args) => {
    if (args[0] === 'set-window' && first) { first = false; entered(); await new Promise(resolve => { release = resolve; }); }
  } });
  await h.start(); h.input('Topic'); await writeStarted;
  h.manualWindow('Human name'); release(); await h.idle();
  assert.equal(h.name, 'Human name'); assert.equal(h.windowName, 'Human name'); assert.equal(h.api.state().locked, true);
});

test('manual Pi rename during startup snapshot is not lost', async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  let first = true;
  const h = setup({ exec: async (_cmd, args) => {
    if (args[0] === 'list-windows' && first) { first = false; entered(); await new Promise(resolve => { release = resolve; }); }
  } });
  const starting = h.start(); await started;
  await h.manualPi('Human during startup'); release(); await starting; await h.idle();
  assert.equal(h.windowName, 'Human during startup'); assert.equal(h.api.state().locked, true);
});

test('CLI failures pause writes and repeated failure notices are bounded', async () => {
  const h = setup({ name: 'Manual name', exec: async (_cmd, args) => {
    if (args[0] === 'set-window') return { code: 1, killed: false, stdout: '' };
  } });
  await h.start(); await h.manualPi('Later name'); await h.idle();
  assert.equal(h.calls.filter(c => c.args[0] === 'set-window').length, 1);
  assert.equal(h.warnings.length, 1);
});

test('deadline aborts inference without changing the title', async () => {
  const h = setup({ config: { timeoutMs: 5 }, result: opts => new Promise(resolve => {
    opts.signal.addEventListener('abort', () => resolve(answer('Too late')), { once: true });
  }) });
  await h.start(); h.input('Subject'); await h.idle();
  assert.equal(h.requests[0].opts.signal.aborted, true); assert.equal(h.name, undefined);
});

test('provider subscription failure is explained safely and visible in status', async () => {
  const h = setup({ result: { stopReason: 'error', content: [], errorMessage: "The 'gpt-4.1-nano' model is not supported when using Codex with a ChatGPT account. secret-canary" } });
  await h.start(); h.input('Subject'); await h.idle();
  assert.match(h.warnings[0][0], /not supported by your ChatGPT\/Codex login/);
  assert.ok(!h.warnings[0][0].includes('secret-canary'));
  await h.commands['name-status'].handler('', { ui: { notify: message => {
    assert.match(message, /Last error:/); assert.ok(!message.includes('secret-canary'));
  } } });
  assert.equal(h.name, undefined);
  h.setResult(answer('Recovered title')); h.input('Retry'); await h.idle();
  await h.commands['name-status'].handler('', { ui: { notify: message => assert.ok(!message.includes('Last error:')) } });
});

test('failure formatter never echoes raw errors, prompts, or credential-like strings', () => {
  for (const raw of ['secret-canary', '401 invalid API key secret-canary', '429 quota secret-canary', '404 secret-canary', '__proto__']) {
    const safe = namingFailure(new Error(raw)); assert.equal(typeof safe, 'string'); assert.ok(!safe.includes('secret-canary'));
  }
});

test('unknown failures report their stage without exposing raw error text', async () => {
  const h = setup({ result: () => { throw new TypeError('private-provider-detail'); } });
  await h.start(); h.input('Subject'); await h.idle();
  assert.match(h.warnings[0][0], /stage: provider request; type: TypeError/);
  assert.ok(!h.warnings[0][0].includes('private-provider-detail'));
  let reads = 0;
  const w = setup({ exec: async (_cmd, args) => {
    if (args[0] === 'list-windows' && ++reads > 2) return { code: 0, killed: false, stdout: 'private-invalid-output' };
  } });
  await w.start(); w.input('Subject'); await w.idle();
  assert.match(w.warnings[0][0], /TUIOS did not return valid window JSON/);
  assert.match(w.warnings[0][0], /stage: reading window/);
  assert.ok(!w.warnings[0][0].includes('private-invalid-output'));
});

test('provider diagnostics classify server and network errors with bounded technical facts', () => {
  const diagnostic = failureDiagnostic(new Error('OpenAI API error (503): private-provider-detail'), 'provider response');
  assert.match(diagnostic, /server error/); assert.match(diagnostic, /HTTP 503/);
  assert.ok(!diagnostic.includes('private-provider-detail'));
  assert.match(namingFailure(new Error('fetch failed: private-provider-detail')), /connection failed/);
});

test('configuration parsing is bounded and title validation rejects invisible controls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-naming-test-'));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    assert.deepEqual(loadConfig(), DEFAULTS);
    const path = join(dir, 'tuios-session-name.json');
    writeFileSync(path, JSON.stringify({ model: 'other-model', enabled: false }));
    assert.equal(loadConfig().model, 'other-model'); assert.equal(loadConfig().enabled, false);
    for (const bad of ['{', 'null', '{"maxContextChars":999999}', '{"enabled":"yes"}', '{"unknown":true}']) {
      writeFileSync(path, bad); assert.throws(loadConfig);
    }
    assert.equal(validName('Normal title ✓', 60), true);
    assert.equal(validName('Hidden\u202ename', 60), false);
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    rmSync(dir, { recursive: true, force: true });
  }
});
