/**
 * Unit tests for the endpoint pool: selection, stickiness, admission control,
 * health parking, and failover. Run with:
 *   node --test plugin/test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalPool, PoolQueueError } from '../lib/pool.js';
import { normalizeConfig } from '../lib/config.js';

/** Build a normalized config with the given endpoint overrides. */
function configWith(endpoints, extra = {}) {
  return normalizeConfig({ endpoints, ...extra });
}

/** Build a pool whose clock the test controls. */
function poolWith(endpoints, extra = {}) {
  const config = configWith(endpoints, extra);
  let now = 1_000_000;
  const pool = new LocalPool(config.endpoints, {
    strategy: config.strategy,
    // Stickiness is fixed by the plugin (`createPool` passes `true`), so the
    // helper mirrors that instead of reading a config field that no longer exists.
    sticky: true,
    queue: config.queue,
    health: config.health,
    now: () => now,
  });
  return { pool, config, advance: (ms) => { now += ms; } };
}

const A = { id: 'a', provider: 'local', model: 'm-a' };
const B = { id: 'b', provider: 'local-strata', model: 'm-b' };

test('config: rejects malformed rows with actionable messages', () => {
  assert.throws(() => normalizeConfig({ endpoints: [{ provider: '' }] }), /provider/);
  assert.throws(() => normalizeConfig({ endpoints: [A, A] }), /duplicate endpoint id/);
  assert.throws(() => normalizeConfig({ endpoints: [A], strategy: 'nope' }), /strategy/);
  assert.throws(() => normalizeConfig({ endpoints: [A], queue: { maxWaiting: -1 } }), /maxWaiting/);
  assert.throws(() => normalizeConfig({ endpoints: 'nope' }), /endpoints/);
  assert.doesNotThrow(() => normalizeConfig({ endpoints: [A, B] }));
  assert.doesNotThrow(() => normalizeConfig({ enabled: false }));
  // An empty list is the shipped starting point: the settings page adds endpoints.
  assert.doesNotThrow(() => normalizeConfig(undefined));
  assert.doesNotThrow(() => normalizeConfig({ endpoints: [] }));
});

test('config: legacy strategy values map onto the supported set', () => {
  // `round-robin` is no longer offered; an existing profile that still says it
  // must keep loading and land on the policy that behaves the same when idle.
  assert.equal(normalizeConfig({ endpoints: [A], strategy: 'round-robin' }).strategy, 'least-busy');
  assert.equal(normalizeConfig({ endpoints: [A], strategy: 'fixed' }).strategy, 'fixed');
  assert.equal(normalizeConfig({ endpoints: [A] }).strategy, 'least-busy', 'the default is least-busy');
  assert.throws(() => normalizeConfig({ endpoints: [A], strategy: 'nope' }), /strategy/);
});

test('config: stickiness and the on/off switch are not settings any more', () => {
  // Both were removed from the page: stickiness is a pool property, and the
  // bundle card owns enable/disable. `enabled` is still read for old profiles.
  const config = normalizeConfig({ endpoints: [A], sticky: false, enabled: false });
  assert.equal('sticky' in config, false, 'sticky is not part of the normalized config');
  assert.equal(config.enabled, false, 'an old `enabled: false` is still honoured');
  assert.equal(normalizeConfig({ endpoints: [A] }).enabled, true, 'and defaults to on');
  const pool = new LocalPool(config.endpoints, {
    strategy: config.strategy,
    sticky: true,
    queue: config.queue,
    health: config.health,
  });
  assert.equal(pool.route('s1').id, 'a');
  assert.equal(pool.route('s1').id, 'a', 'the pool is always sticky in the shipped wiring');
});

test('pool: least-busy spreads sessions and stays sticky per session', () => {
  const { pool } = poolWith([A, B], { strategy: 'least-busy' });
  const first = pool.route('session-1');
  const second = pool.route('session-2');
  assert.notEqual(first.id, second.id, 'two fresh sessions land on different machines');
  assert.equal(pool.route('session-1').id, first.id, 'a session keeps its endpoint');
  assert.equal(pool.route('session-2').id, second.id);
});

test('pool: a busy endpoint loses to an idle one', async () => {
  const { pool } = poolWith([A, B], { strategy: 'least-busy' });
  const release = await pool.acquire(pool.endpointById('a'), {});
  assert.equal(pool.route('fresh').id, 'b', 'the idle machine wins while a is occupied');
  release();
  assert.equal(pool.route('fresh').id, 'b', 'the assignment stays sticky after the call settles');
});

test('pool: round-robin alternates endpoints', () => {
  const { pool } = poolWith([A, B], { strategy: 'round-robin', sticky: false });
  assert.equal(pool.route('s1').id, 'a');
  assert.equal(pool.route('s2').id, 'b');
  assert.equal(pool.route('s3').id, 'a');
});

test('pool: fixed always picks the first endpoint', () => {
  const { pool } = poolWith([A, B], { strategy: 'fixed' });
  assert.equal(pool.route('s1').id, 'a');
  assert.equal(pool.route('s2').id, 'a');
});

test('pool: admission serializes above the endpoint concurrency', async () => {
  const { pool } = poolWith([A, B], { strategy: 'fixed' });
  const endpoint = pool.endpointById('a');
  const release1 = await pool.acquire(endpoint, {});
  assert.equal(endpoint.active, 1);

  let admitted = false;
  const second = pool.acquire(endpoint, {}).then((release) => {
    admitted = true;
    return release;
  });
  await Promise.resolve();
  assert.equal(admitted, false, 'the second request waits for the slot');

  release1();
  const release2 = await second;
  assert.equal(admitted, true);
  assert.equal(endpoint.active, 1);
  release2();
  assert.equal(endpoint.active, 0);
});

test('pool: concurrency above one admits in parallel', async () => {
  const { pool } = poolWith([{ ...A, concurrency: 2 }]);
  const endpoint = pool.endpointById('a');
  const release1 = await pool.acquire(endpoint, {});
  const release2 = await pool.acquire(endpoint, {});
  assert.equal(endpoint.active, 2);
  release1();
  release2();
});

test('pool: a queued request times out with a stable code', async () => {
  const { pool } = poolWith([A], { queue: { timeoutMs: 20, maxWaiting: 4 } });
  const endpoint = pool.endpointById('a');
  const release = await pool.acquire(endpoint, {});
  await assert.rejects(pool.acquire(endpoint, {}), (error) => {
    assert.ok(error instanceof PoolQueueError);
    assert.equal(error.code, 'QUEUE_TIMEOUT');
    return true;
  });
  release();
  assert.equal(endpoint.waiting, 0);
});

test('pool: a full queue rejects instead of growing without bound', async () => {
  const { pool } = poolWith([A], { queue: { maxWaiting: 1, timeoutMs: 5_000 } });
  const endpoint = pool.endpointById('a');
  const release = await pool.acquire(endpoint, {});
  const queued = pool.acquire(endpoint, {});
  await assert.rejects(pool.acquire(endpoint, {}), (error) => error.code === 'QUEUE_FULL');
  release();
  (await queued)();
});

test('pool: an aborted wait gives up its place', async () => {
  const { pool } = poolWith([A], { queue: { maxWaiting: 4, timeoutMs: 5_000 } });
  const endpoint = pool.endpointById('a');
  const release = await pool.acquire(endpoint, {});
  const controller = new AbortController();
  const waiting = pool.acquire(endpoint, { signal: controller.signal });
  assert.equal(endpoint.waiting, 1);
  controller.abort();
  await assert.rejects(waiting, (error) => error.code === 'ABORTED');
  assert.equal(endpoint.waiting, 0);
  release();
});

test('pool: repeated failures park an endpoint and failover re-routes', () => {
  const { pool, advance } = poolWith([A, B], { strategy: 'fixed', health: { failureThreshold: 2, cooldownMs: 1000 } });
  const first = pool.route('s1');
  assert.equal(first.id, 'a');
  pool.noteFailure(first, 'TRANSPORT');
  assert.equal(pool.route('s1').id, 'a', 'one failure keeps the endpoint');
  pool.noteFailure(first, 'TRANSPORT');
  assert.equal(pool.route('s1').id, 'b', 'the parked endpoint is skipped and stickiness fails over');
  advance(1001);
  assert.equal(pool.route('s2').id, 'a', 'the endpoint returns after its cooldown');
});

test('pool: ignored failure codes never park an endpoint', () => {
  const { pool } = poolWith([A], { health: { failureThreshold: 1, cooldownMs: 1000 } });
  const endpoint = pool.route('s1');
  pool.noteFailure(endpoint, 'CONTEXT_WINDOW_EXCEEDED');
  assert.equal(pool.endpointById('a').cooldownUntil, 0);
  assert.equal(pool.snapshot().endpoints[0].state, 'ready');
});

test('pool: a successful call clears the failure history', () => {
  const { pool } = poolWith([A], { health: { failureThreshold: 3, cooldownMs: 1000 } });
  const endpoint = pool.route('s1');
  pool.noteFailure(endpoint, 'TRANSPORT');
  pool.noteSuccess(endpoint);
  assert.equal(pool.endpointById('a').failures, 0);
});

test('pool: unusable endpoints are never chosen, and auto models resolve', () => {
  const { pool } = poolWith([{ ...A, model: 'auto' }, B]);
  pool.setUnavailable('b', 'provider missing');
  assert.equal(pool.route('s1'), undefined, 'an unresolved auto model cannot be routed to');
  pool.setResolvedModel('a', 'resolved-model');
  assert.equal(pool.route('s1').id, 'a');
  pool.setUnavailable('a', 'gone');
  assert.equal(pool.route('s1'), undefined);
  pool.resetAvailability();
  assert.equal(pool.usableEndpoints().length, 2, 'a catalog refresh restores both endpoints');
  assert.notEqual(pool.route('s1'), undefined);
});

test('pool: snapshot reports state, load, and totals', async () => {
  const { pool } = poolWith([A, B]);
  const release = await pool.acquire(pool.endpointById('a'), {});
  const snapshot = pool.snapshot();
  assert.equal(snapshot.totals.endpoints, 2);
  assert.equal(snapshot.totals.active, 1);
  assert.equal(snapshot.endpoints[0].state, 'ready');
  assert.equal(snapshot.endpoints[0].active, 1);
  release();
});

test('pool: a task budget caps concurrency across endpoints', async () => {
  const { pool } = poolWith([A, B], { strategy: 'fixed' });
  pool.setBudget('task-1', 1);
  const releaseFirst = await pool.acquire(pool.endpointById('a'), { budgetKey: 'task-1' });

  let admitted = false;
  const second = pool.acquire(pool.endpointById('b'), { budgetKey: 'task-1' }).then((release) => {
    admitted = true;
    return release;
  });
  await Promise.resolve();
  assert.equal(admitted, false, 'the task budget is the binding limit, not the machine');
  assert.equal(pool.budgetSnapshot()[0].waiting, 1);

  releaseFirst();
  const releaseSecond = await second;
  assert.equal(admitted, true);
  assert.equal(pool.budgetSnapshot()[0].active, 1);
  releaseSecond();
  assert.equal(pool.budgetSnapshot()[0].active, 0);
});

test('pool: budgets are per task and independent of each other', async () => {
  const { pool } = poolWith([A, B]);
  pool.setBudget('task-1', 1);
  pool.setBudget('task-2', 1);
  const one = await pool.acquire(pool.endpointById('a'), { budgetKey: 'task-1' });
  const two = await pool.acquire(pool.endpointById('b'), { budgetKey: 'task-2' });
  assert.deepEqual(pool.budgetSnapshot().map((budget) => budget.active).sort(), [1, 1]);
  one();
  two();
});

test('pool: raising a task budget admits queued work immediately', async () => {
  const { pool } = poolWith([A, B]);
  pool.setBudget('task-1', 1);
  const release = await pool.acquire(pool.endpointById('a'), { budgetKey: 'task-1' });
  const queued = pool.acquire(pool.endpointById('b'), { budgetKey: 'task-1' });
  await Promise.resolve();
  pool.setBudget('task-1', 2);
  const second = await queued;
  assert.equal(pool.budgetSnapshot()[0].active, 2);
  release();
  second();
});

test('pool: a cancelled budget wait gives up its place', async () => {
  const { pool } = poolWith([A, B]);
  pool.setBudget('task-1', 1);
  const release = await pool.acquire(pool.endpointById('a'), { budgetKey: 'task-1' });
  const controller = new AbortController();
  const waiting = pool.acquire(pool.endpointById('b'), { budgetKey: 'task-1', signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, (error) => error.code === 'ABORTED');
  assert.equal(pool.budgetSnapshot()[0].waiting, 0);
  release();
});

test('pool: child sessions remember their delegating task', () => {
  const { pool } = poolWith([A]);
  pool.setBudget('parent-session', 2);
  pool.bindDelegation('child-session', {
    taskKey: 'parent-session',
    taskRoute: { provider: 'deepseek-account', model: 'deepseek-flash' },
    label: 'deepseek-account',
  });
  assert.equal(pool.parentOfChild('child-session'), 'parent-session');
  assert.equal(pool.parentOfChild('unknown'), undefined);
  assert.equal(pool.isOwnTaskRoute('child-session', 'deepseek-account', 'deepseek-flash'), true);
  assert.equal(pool.isOwnTaskRoute('child-session', 'local', 'm-a'), false);
  assert.equal(pool.budgetSnapshot()[0].label, 'deepseek-account', 'the budget row is labelled with the task provider');
  pool.forgetDelegation('child-session');
  assert.equal(pool.parentOfChild('child-session'), undefined, 'disposal clears the delegation record');
});

test('pool: a request without a budget key is not gated by any task', async () => {
  const { pool } = poolWith([A, B]);
  pool.setBudget('task-1', 1);
  const release = await pool.acquire(pool.endpointById('a'), { budgetKey: 'task-1' });
  const unrelated = await pool.acquire(pool.endpointById('b'), {});
  assert.equal(pool.budgetSnapshot()[0].active, 1);
  release();
  unrelated();
});
