/**
 * Wiring tests: run the plugin against a small fake harness that mimics the
 * documented dispatch semantics of `agent/request` (waterfall, awaited) and
 * `llm/stream` (waterfall, synchronous AsyncIterable), so the routing and the
 * admission gate are exercised without booting DSH.
 *
 * Run with: node plugin/test/plugin.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, name, inject } from '../index.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A fake harness exposing just the surface the plugin touches. */
function createHarness({ providers = ['local', 'local-strata'], models = { local: ['m-a'], 'local-strata': ['m-b'] } } = {}) {
  const listeners = new Map();
  const scoped = new Map();
  const effects = [];
  const tools = [];
  const logs = [];
  const sections = [];
  const liveAgents = new Map();
  const llm = {
    listProviders: () => providers.map((id) => ({ id, name: id })),
    listModels: async (provider) => {
      if (!providers.includes(provider)) throw new Error(`no adapter registered for provider "${provider}"`);
      return (models[provider] ?? []).map((id) => ({ id, name: id, provider }));
    },
  };
  const toolsService = {
    register(definition) {
      tools.push(definition);
      return () => {};
    },
  };
  const systemPrompt = {
    getSectionOrder: () => 2800,
    section(definition) {
      const entry = { definition, disposed: false };
      sections.push(entry);
      return () => {
        entry.disposed = true;
      };
    },
  };
  const agentsService = { get: (id) => liveAgents.get(id) };
  const ctx = {
    logger: {
      info: (...args) => logs.push(['info', args]),
      warn: (...args) => logs.push(['warn', args]),
      debug: (...args) => logs.push(['debug', args]),
      error: (...args) => logs.push(['error', args]),
    },
    get: (key) => {
      if (key === 'llm') return llm;
      if (key === 'systemPrompt') return systemPrompt;
      if (key === 'agents') return agentsService;
      return undefined;
    },
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return () => {};
    },
    effect: (fn) => {
      effects.push(fn());
    },
    inject: (deps, callback) => {
      if (deps.includes('tools')) callback({ ...ctx, tools: toolsService });
    },
  };

  const agentCtx = (id) => ({
    on(event, listener) {
      const list = scoped.get(id) ?? [];
      list.push({ event, listener });
      scoped.set(id, list);
    },
    get: (key) => ctx.get(key),
  });

  const emit = (event, payload) => {
    if (event === 'agent/created' && payload?.agent?.session?.id !== undefined) {
      liveAgents.set(payload.agent.session.id, payload.agent);
    }
    if (event === 'agent/disposed' && payload?.agent?.session?.id !== undefined) {
      liveAgents.delete(payload.agent.session.id);
    }
    for (const listener of listeners.get(event) ?? []) listener(payload);
  };

  /** Awaitable waterfall, as `agent/request` behaves. */
  const requestWaterfall = async (agent, seed) => {
    const chain = [...(listeners.get('agent/request') ?? []), ...(scoped.get(agent.id) ?? [])
      .filter((entry) => entry.event === 'agent/request')
      .map((entry) => entry.listener)];
    const run = (index) => async () => (index >= chain.length ? seed : chain[index]({ agent }, run(index + 1)));
    return run(0)();
  };

  /** Synchronous waterfall over AsyncIterable, as `llm/stream` behaves. */
  const streamWaterfall = (options, terminal) => {
    const chain = listeners.get('llm/stream') ?? [];
    const run = (index) => () => (index >= chain.length ? terminal() : chain[index](options, run(index + 1)));
    return run(0)();
  };

  return { ctx, emit, requestWaterfall, streamWaterfall, tools, logs, effects, sections, agents: { agentCtx } };
}

/** A delegated child agent with the durable lineage the harness persists. */
function childAgent(harness, id, parent = 'parent-session', options = {}) {
  return {
    id,
    options: { subagentDepth: 1, provider: 'deepseek-account', model: 'deepseek-flash', ...options },
    session: { id, header: { id, parentSession: parent, origin: 'subagent', delegationDepth: 1 } },
    ctx: harness.agents.agentCtx(id),
  };
}

/** A top-level agent with no delegation lineage. */
function rootAgent(harness, id, options = {}) {
  return {
    id,
    options: { provider: 'deepseek-account', model: 'deepseek-flash', ...options },
    session: { id, header: { id } },
    ctx: harness.agents.agentCtx(id),
  };
}

const CHILD_SEED = {
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  reasoningEffort: 'max',
  temperature: 0.7,
};

/** Build a stream that records concurrency and can be held open. */
function trackedStream(state, activate) {
  return (async function* () {
    state.active++;
    state.max = Math.max(state.max, state.active);
    state.started++;
    if (activate !== undefined) await activate();
    try {
      yield { type: 'text-delta', index: 0, text: 'hello' };
      yield { type: 'finish', reason: { kind: 'completed' } };
    } finally {
      state.active--;
    }
  })();
}

test('plugin identity and injection are declared', () => {
  assert.equal(name, 'local-compute-pool');
  assert.deepEqual(inject, ['llm']);
});

test('routing: a delegated child moves to a pooled endpoint, keeping exactly the six call-config fields', async () => {
  const harness = createHarness();
  apply(harness.ctx, { endpoints: [{ id: 'a', provider: 'local', model: 'm-a' }, { id: 'b', provider: 'local-strata', model: 'm-b' }] });
  await flush();

  const child = childAgent(harness, 'child-1');
  harness.emit('agent/created', { agent: child });
  const resolved = await harness.requestWaterfall(child, { ...CHILD_SEED });

  assert.equal(resolved.provider, 'local');
  assert.equal(resolved.model, 'm-a');
  assert.equal(resolved.temperature, 0.7, 'sampling is preserved');
  assert.equal('reasoningEffort' in resolved, false, 'the previous route effort is dropped');
  assert.deepEqual(Object.keys(resolved).sort(), ['model', 'provider', 'temperature']);
});

test('routing: a top-level agent keeps its route unless applyTo is all', async () => {
  const harness = createHarness();
  apply(harness.ctx, { endpoints: [{ id: 'a', provider: 'local', model: 'm-a' }] });
  await flush();
  const root = rootAgent(harness, 'root-1');
  harness.emit('agent/created', { agent: root });
  assert.deepEqual(await harness.requestWaterfall(root, { ...CHILD_SEED }), CHILD_SEED);

  const all = createHarness();
  apply(all.ctx, { applyTo: 'all', endpoints: [{ id: 'a', provider: 'local', model: 'm-a' }] });
  await flush();
  const routed = await all.requestWaterfall(rootAgent(all, 'root-2'), { ...CHILD_SEED });
  assert.equal(routed.provider, 'local');
});

test('routing: two children spread over two machines and stay sticky', async () => {
  const harness = createHarness();
  apply(harness.ctx, { endpoints: [{ id: 'a', provider: 'local', model: 'm-a' }, { id: 'b', provider: 'local-strata', model: 'm-b' }] });
  await flush();

  const first = childAgent(harness, 'child-1');
  const second = childAgent(harness, 'child-2');
  harness.emit('agent/created', { agent: first });
  harness.emit('agent/created', { agent: second });

  const one = await harness.requestWaterfall(first, { ...CHILD_SEED });
  const two = await harness.requestWaterfall(second, { ...CHILD_SEED });
  assert.notEqual(one.provider, two.provider, 'the two children use different machines');
  const again = await harness.requestWaterfall(first, { ...CHILD_SEED });
  assert.equal(again.provider, one.provider, 'the same child keeps its machine');
});

test('routing: an explicit pooled route is respected', async () => {
  const harness = createHarness();
  apply(harness.ctx, { endpoints: [{ id: 'a', provider: 'local', model: 'm-a' }, { id: 'b', provider: 'local-strata', model: 'm-b' }] });
  await flush();
  const child = childAgent(harness, 'child-1');
  harness.emit('agent/created', { agent: child });
  const resolved = await harness.requestWaterfall(child, { provider: 'local-strata', model: 'm-b' });
  assert.deepEqual(resolved, { provider: 'local-strata', model: 'm-b' });
});

test('routing: an unresolvable catalog leaves the inherited route untouched', async () => {
  const harness = createHarness({ providers: [], models: {} });
  apply(harness.ctx, { endpoints: [{ id: 'a', provider: 'local', model: 'm-a' }] });
  await flush();
  const child = childAgent(harness, 'child-1');
  harness.emit('agent/created', { agent: child });
  assert.deepEqual(await harness.requestWaterfall(child, { ...CHILD_SEED }), CHILD_SEED);
});

test('routing: model auto resolves to the first model the provider advertises', async () => {
  const harness = createHarness({ models: { local: ['small-model', 'big-model'] } });
  apply(harness.ctx, { endpoints: [{ id: 'a', provider: 'local', model: 'auto' }] });
  await flush();
  const child = childAgent(harness, 'child-1');
  harness.emit('agent/created', { agent: child });
  const resolved = await harness.requestWaterfall(child, { ...CHILD_SEED });
  assert.equal(resolved.model, 'small-model', 'auto takes the first advertised model');
});

test('routing: an unknown model id disables the endpoint instead of failing the child turn', async () => {
  const harness = createHarness();
  apply(harness.ctx, { endpoints: [{ id: 'a', provider: 'local', model: 'typo-model' }] });
  await flush();
  const child = childAgent(harness, 'child-1');
  harness.emit('agent/created', { agent: child });
  assert.deepEqual(await harness.requestWaterfall(child, { ...CHILD_SEED }), CHILD_SEED);
  assert.ok(
    harness.logs.some(([level, args]) => level === 'warn' && args.map(String).join(' ').includes('typo-model')),
    'the operator is told why the endpoint is unused',
  );
});

test('admission: concurrent streams on one endpoint serialize', async () => {
  const harness = createHarness();
  apply(harness.ctx, { endpoints: [{ id: 'a', provider: 'local', model: 'm-a' }], queue: { timeoutMs: 5_000 } });
  await flush();

  const state = { active: 0, max: 0, started: 0 };
  const options = { provider: 'local', model: 'm-a' };
  const consume = async () => {
    for await (const chunk of harness.streamWaterfall(options, () => trackedStream(state))) void chunk;
  };
  await Promise.all([consume(), consume(), consume()]);
  assert.equal(state.started, 3);
  assert.equal(state.max, 1, 'the endpoint never serves two calls at once');
});

test('admission: a pooled endpoint with concurrency 2 runs two calls at once', async () => {
  const harness = createHarness();
  apply(harness.ctx, { endpoints: [{ id: 'a', provider: 'local', model: 'm-a', concurrency: 2 }], queue: { timeoutMs: 5_000 } });
  await flush();
  const state = { active: 0, max: 0, started: 0 };
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const options = { provider: 'local', model: 'm-a' };
  const consume = async () => {
    for await (const chunk of harness.streamWaterfall(options, () => trackedStream(state, () => gate))) void chunk;
  };
  const running = Promise.all([consume(), consume()]);
  await flush();
  assert.equal(state.max, 2, 'both slots are used');
  open();
  await running;
});

test('admission: other providers are never gated', async () => {
  const harness = createHarness();
  apply(harness.ctx, { endpoints: [{ id: 'a', provider: 'local', model: 'm-a' }] });
  await flush();
  const state = { active: 0, max: 0, started: 0 };
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const options = { provider: 'deepseek-account', model: 'deepseek-flash' };
  const consume = async () => {
    for await (const chunk of harness.streamWaterfall(options, () => trackedStream(state, () => gate))) void chunk;
  };
  const running = Promise.all([consume(), consume()]);
  await flush();
  assert.equal(state.max, 2, 'unpooled routes run in parallel as before');
  release();
  await running;
});

test('reservation: a task already running on a single-slot machine keeps it to itself', async () => {
  const harness = createHarness({ providers: ['local', 'local-strata'], models: { local: ['m-a'], 'local-strata': ['m-b'] } });
  apply(harness.ctx, {
    endpoints: [
      { id: 'a', provider: 'local', model: 'm-a' },
      { id: 'b', provider: 'local-strata', model: 'm-b' },
    ],
  });
  await flush();

  // The task itself runs on the pooled `local` machine and is in flight.
  const root = rootAgent(harness, 'root-1', { provider: 'local', model: 'm-a' });
  harness.emit('agent/created', { agent: root });
  const rootStream = harness.streamWaterfall({ provider: 'local', model: 'm-a', sessionId: 'root-1' }, () => (async function* () {
    yield { type: 'text-delta', index: 0, text: 'working' };
    yield { type: 'finish', reason: { kind: 'completed' } };
  })());

  const child = childAgent(harness, 'child-1', 'root-1', { provider: 'local', model: 'm-a' });
  harness.emit('agent/created', { agent: child });
  const resolved = await harness.requestWaterfall(child, { provider: 'local', model: 'm-a' });
  assert.equal(resolved.provider, 'local-strata', 'the child goes to another machine while the task holds its own');
  assert.equal(resolved.model, 'm-b');

  for await (const chunk of rootStream) void chunk;

  // With the task's call finished, the freed slot is usable again.
  const later = childAgent(harness, 'child-2', 'root-1', { provider: 'local', model: 'm-a' });
  harness.emit('agent/created', { agent: later });
  const after = await harness.requestWaterfall(later, { provider: 'local', model: 'm-a' });
  assert.equal(after.provider, 'local', 'the task machine is a candidate again once the task is idle');
});

test('reservation: a single-endpoint pool leaves the child on the task machine to serialize there', async () => {
  const harness = createHarness({ providers: ['local'], models: { local: ['m-a'] } });
  apply(harness.ctx, { endpoints: [{ id: 'a', provider: 'local', model: 'm-a' }] });
  await flush();

  const root = rootAgent(harness, 'root-1', { provider: 'local', model: 'm-a' });
  harness.emit('agent/created', { agent: root });
  const rootStream = harness.streamWaterfall({ provider: 'local', model: 'm-a', sessionId: 'root-1' }, () => (async function* () {
    yield { type: 'finish', reason: { kind: 'completed' } };
  })());

  const child = childAgent(harness, 'child-1', 'root-1', { provider: 'local', model: 'm-a' });
  harness.emit('agent/created', { agent: child });
  const resolved = await harness.requestWaterfall(child, { provider: 'local', model: 'm-a' });
  assert.deepEqual(resolved, { provider: 'local', model: 'm-a' }, 'the inherited route is kept, not moved to a second slot');
  for await (const chunk of rootStream) void chunk;
});

test('admission: a failure parks the endpoint and the next child fails over', async () => {
  const harness = createHarness();
  apply(harness.ctx, {
    endpoints: [{ id: 'a', provider: 'local', model: 'm-a' }, { id: 'b', provider: 'local-strata', model: 'm-b' }],
    strategy: 'fixed',
    health: { failureThreshold: 1, cooldownMs: 60_000 },
  });
  await flush();
  const failing = { provider: 'local', model: 'm-a' };
  const stream = async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'connection refused' } } };
  };
  for await (const chunk of harness.streamWaterfall(failing, () => stream())) void chunk;

  const child = childAgent(harness, 'child-after-failure');
  harness.emit('agent/created', { agent: child });
  const resolved = await harness.requestWaterfall(child, { ...CHILD_SEED });
  assert.equal(resolved.provider, 'local-strata', 'the parked machine is skipped');
});

test('admission: a full queue reports a terminal failure chunk instead of throwing', async () => {
  const harness = createHarness();
  apply(harness.ctx, {
    endpoints: [{ id: 'a', provider: 'local', model: 'm-a' }],
    queue: { maxWaiting: 0, timeoutMs: 5_000 },
  });
  await flush();
  const options = { provider: 'local', model: 'm-a' };
  const state = { active: 0, max: 0, started: 0 };
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const first = (async () => {
    for await (const chunk of harness.streamWaterfall(options, () => trackedStream(state, () => gate))) void chunk;
  })();
  await flush();
  const chunks = [];
  for await (const chunk of harness.streamWaterfall(options, () => trackedStream(state))) chunks.push(chunk);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].type, 'finish');
  assert.equal(chunks[0].reason.kind, 'error');
  assert.equal(chunks[0].reason.failure.code, 'QUEUE_FULL');
  open();
  await first;
});

test('tool: local_pool reports the live pool and honours tool.enabled', async () => {
  const harness = createHarness();
  apply(harness.ctx, { endpoints: [{ id: 'a', provider: 'local', model: 'm-a' }] });
  await flush();
  assert.equal(harness.tools.length, 1);
  assert.equal(harness.tools[0].name, 'local_pool');
  // The API receives a JSON Schema, not a bare map of parameter fields.
  const parameters = JSON.parse(JSON.stringify(harness.tools[0].parameters));
  assert.equal(parameters.type, 'object');
  assert.equal(parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(parameters.properties), ['probe']);
  assert.equal(parameters.properties.probe.type, 'boolean');
  assert.deepEqual(parameters.required ?? [], []);
  const value = await harness.tools[0].execute({});
  assert.equal(value.totals.endpoints, 1);
  assert.equal(value.endpoints[0].model, 'm-a');
  assert.deepEqual(value.budgets, [], 'no task holds a budget until a whitelisted task is routed');
  const rendered = harness.tools[0].output.render({}, value);
  assert.match(rendered[0].text, /Local inference pool: 1\/1 endpoint\(s\) ready/);
  assert.doesNotMatch(rendered[0].text, /Task subagent budgets:/, 'an empty budget list renders nothing');

  const off = createHarness();
  apply(off.ctx, { endpoints: [{ id: 'a', provider: 'local', model: 'm-a' }], tool: { enabled: false } });
  await flush();
  assert.equal(off.tools.length, 0);
});

test('tool: local_pool reports each task\'s subagent budget', async () => {
  const harness = createHarness();
  apply(harness.ctx, {
    endpoints: [{ id: 'a', provider: 'local', model: 'm-a' }],
    triggers: [{ provider: 'deepseek-account', concurrency: 2 }],
  });
  await flush();
  const child = childAgent(harness, 'child-1');
  harness.emit('agent/created', { agent: child });
  await harness.requestWaterfall(child, { ...CHILD_SEED });

  const value = await harness.tools[0].execute({});
  assert.equal(value.budgets.length, 1, 'the delegating task now holds a budget');
  assert.equal(value.budgets[0].label, 'deepseek-account', 'labelled with the task\'s own provider');
  assert.equal(value.budgets[0].limit, 2);
  assert.equal(value.budgets[0].active, 0, 'no local call is in flight yet');
  const text = harness.tools[0].output.render({}, value)[0].text;
  assert.match(text, /Task subagent budgets:/);
  assert.match(text, /task deepseek-account: 0\/2 local subagent\(s\) running/);
});

test('tool: probe reports reachability and renders it', async () => {
  const harness = createHarness();
  apply(harness.ctx, { endpoints: [{ id: 'a', provider: 'local', model: 'm-a', baseURL: 'http://127.0.0.1:9/v1' }] });
  await flush();
  const value = await harness.tools[0].execute({ probe: true });
  assert.equal(value.endpoints[0].probe.reachable, false);
  const text = harness.tools[0].output.render({}, value)[0].text;
  assert.match(text, /probe: unreachable/);
});

test('disabled plugin routes nothing and registers no tool', async () => {
  const harness = createHarness();
  apply(harness.ctx, { enabled: false, endpoints: [{ id: 'a', provider: 'local', model: 'm-a' }], tool: { enabled: false } });
  await flush();
  const child = childAgent(harness, 'child-1');
  assert.deepEqual(await harness.requestWaterfall(child, { ...CHILD_SEED }), CHILD_SEED);
  assert.equal(harness.tools.length, 0);
});

test('live settings write: a volatile config change rebuilds the pool', async () => {
  const harness = createHarness();
  const live = {
    enabled: false,
    applyTo: 'children',
    endpoints: [{ id: 'a', provider: 'local', model: 'm-a' }],
  };
  const volatile = (key) => ({ get: () => live[key] });
  apply(harness.ctx, {
    enabled: volatile('enabled'),
    applyTo: volatile('applyTo'),
    endpoints: volatile('endpoints'),
    tool: { get: () => ({ enabled: false }) },
    logging: { get: () => ({ verbose: false }) },
  });
  await flush();

  const child = childAgent(harness, 'child-1');
  assert.deepEqual(await harness.requestWaterfall(child, { ...CHILD_SEED }), CHILD_SEED, 'disabled: untouched');

  live.enabled = true;
  harness.emit('loader/volatile-update', undefined);
  const routed = await harness.requestWaterfall(child, { ...CHILD_SEED });
  assert.equal(routed.provider, 'local', 'enabled live: routed');

  live.enabled = false;
  harness.emit('loader/volatile-update', undefined);
  assert.deepEqual(await harness.requestWaterfall(child, { ...CHILD_SEED }), CHILD_SEED, 'disabled again: untouched');
});

test('invalid config fails activation loudly', () => {
  const harness = createHarness();
  assert.throws(() => apply(harness.ctx, { endpoints: [{ provider: 'local' }], strategy: 'nonsense' }), /strategy/);
});

test('whitelist: only tasks whose provider is listed are taken over', async () => {
  const harness = createHarness();
  apply(harness.ctx, {
    triggers: [{ provider: 'deepseek-account', concurrency: 2 }],
    endpoints: [{ id: 'a', provider: 'local', model: 'm-a' }, { id: 'b', provider: 'local-strata', model: 'm-b' }],
  });
  await flush();

  const listed = rootAgent(harness, 'root-listed');
  harness.emit('agent/created', { agent: listed });
  const routedChild = childAgent(harness, 'child-listed', 'root-listed');
  harness.emit('agent/created', { agent: routedChild });
  const routed = await harness.requestWaterfall(routedChild, { ...CHILD_SEED });
  assert.equal(routed.provider, 'local', 'a whitelisted task delegates to the local pool');

  const other = rootAgent(harness, 'root-other', { provider: 'opencode-go' });
  harness.emit('agent/created', { agent: other });
  const plainChild = childAgent(harness, 'child-other', 'root-other');
  harness.emit('agent/created', { agent: plainChild });
  const untouched = await harness.requestWaterfall(plainChild, { ...CHILD_SEED });
  assert.deepEqual(untouched, CHILD_SEED, 'an unlisted task keeps the inherited route');
});

test('whitelist: the delegating task is told its subagent cap in the prompt', async () => {
  const harness = createHarness();
  apply(harness.ctx, {
    triggers: [{ provider: 'deepseek-account', concurrency: 2 }],
    endpoints: [{ id: 'a', provider: 'local', model: 'm-a', concurrency: 1 }],
  });
  await flush();

  const listed = rootAgent(harness, 'root-listed');
  harness.emit('agent/created', { agent: listed });
  assert.equal(harness.sections.length, 1, 'a whitelisted task gets one scoped section');
  const text = harness.sections[0].definition.text({});
  assert.match(text, /本地并行已启用/);
  assert.match(text, /最多同时运行 2 个本地子代理/);
  assert.match(text, /local \/ m-a（并发 1）/);
  assert.equal(harness.sections[0].definition.order, 2810, 'placed just after the subagent tool section');

  const other = rootAgent(harness, 'root-other', { provider: 'opencode-go' });
  harness.emit('agent/created', { agent: other });
  assert.equal(harness.sections.length, 1, 'an unlisted task gets no section');
});

test('whitelist: removing a provider on the fly withdraws its section', async () => {
  const harness = createHarness();
  const live = {
    triggers: [{ provider: 'deepseek-account', concurrency: 1 }],
    endpoints: [{ id: 'a', provider: 'local', model: 'm-a' }],
  };
  const volatile = (key) => ({ get: () => live[key] });
  apply(harness.ctx, {
    triggers: volatile('triggers'),
    endpoints: volatile('endpoints'),
    tool: { get: () => ({ enabled: false }) },
    logging: { get: () => ({ verbose: false }) },
  });
  await flush();

  const listed = rootAgent(harness, 'root-listed');
  harness.emit('agent/created', { agent: listed });
  assert.equal(harness.sections.length, 1);

  live.triggers = [];
  harness.emit('loader/volatile-update', undefined);
  assert.equal(harness.sections[0].disposed, true, 'the note disappears with the whitelist entry');
});

test('whitelist: a task budget serializes its children even across machines', async () => {
  const harness = createHarness();
  apply(harness.ctx, {
    triggers: [{ provider: 'deepseek-account', concurrency: 1 }],
    endpoints: [
      { id: 'a', provider: 'local', model: 'm-a' },
      { id: 'b', provider: 'local-strata', model: 'm-b' },
    ],
    queue: { timeoutMs: 5_000 },
  });
  await flush();

  const root = rootAgent(harness, 'root-1');
  harness.emit('agent/created', { agent: root });
  const first = childAgent(harness, 'child-1', 'root-1');
  const second = childAgent(harness, 'child-2', 'root-1');
  harness.emit('agent/created', { agent: first });
  harness.emit('agent/created', { agent: second });
  await harness.requestWaterfall(first, { ...CHILD_SEED });
  await harness.requestWaterfall(second, { ...CHILD_SEED });

  const state = { active: 0, max: 0, started: 0 };
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const consume = async (options) => {
    for await (const chunk of harness.streamWaterfall(options, () => trackedStream(state, () => gate))) void chunk;
  };
  const running = Promise.all([
    consume({ provider: 'local', model: 'm-a', sessionId: 'child-1' }),
    consume({ provider: 'local-strata', model: 'm-b', sessionId: 'child-2' }),
  ]);
  await flush();
  assert.equal(state.max, 1, 'one task budget covers both machines');
  open();
  await running;
  assert.equal(state.started, 2);
});
