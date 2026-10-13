/**
 * Client-half tests: load the browser bundle once with a stubbed module loader,
 * then exercise the page exactly the way the Plugins page does — registered
 * through `configForms.whileServed`, rendered from a live settings controller,
 * fed providers/models by the Host directory, and saving through a
 * revision-fenced `mutate`.
 *
 * Run with: node plugin/test/client-page.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Minimal React shim: element records plus persistent hook state. */
function createReactShim() {
  const states = [];
  let cursor = 0;
  return {
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false);
      return { type, props: { ...(props ?? {}), ...(flat.length > 0 ? { children: flat } : {}) } };
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], (next) => {
        states[index] = typeof next === 'function' ? next(states[index]) : next;
      }];
    },
    // React runs effects after mount; the shim runs them on every render.
    useEffect(effect) {
      effect();
    },
    resetCursor() {
      cursor = 0;
    },
  };
}

/** A dictionary whose lookup returns the key itself, so assertions can name keys. */
const t = (key) => `«${key}»`;

/** The configuration a fresh install reports: no endpoints yet. */
const EMPTY_VALUE = {
  enabled: true,
  applyTo: 'children',
  strategy: 'least-busy',
  endpoints: [],
  health: { failureThreshold: 2, cooldownMs: 120_000 },
  queue: { maxWaiting: 32, timeoutMs: 600_000 },
  tool: { enabled: true },
};

/** The Host model directory the provider/model dropdowns read. */
const CATALOG = {
  ok: true,
  value: {
    groups: [
      { id: 'local', name: '本地', models: [{ id: 'qwen3-local', name: 'Qwen3 Local' }] },
      { id: 'local-strata', name: '本地-Strata', models: [{ id: 'strata-model', name: 'Strata' }] },
    ],
    failures: [],
  },
};

/** A context that runs registered effects immediately, as Cordis does. */
function makeCtx(hooks, controller, catalog = CATALOG) {
  return {
    locale: { bind: () => t, register: () => () => {} },
    on: () => () => {},
    remote: {
      $on: () => () => {},
      session: {
        modelCatalog: async () => {
          hooks.catalogCalls += 1;
          return catalog;
        },
      },
    },
    configForms: {
      whileServed: (namespaces, register) => {
        hooks.watched.push(...namespaces);
        register(new Set(namespaces));
        return () => {};
      },
      get: (namespace) => {
        hooks.requested.push(namespace);
        return controller;
      },
    },
    slots: {
      inject: (slot, callback) => {
        hooks.injected.push(slot);
        callback();
        return () => {};
      },
      register: (options, component) => {
        hooks.registered.push({ options, component });
        return () => {};
      },
    },
    effect: (callback) => {
      callback();
    },
  };
}

// The module loader stub must exist before the bundle is evaluated.
let definition;
globalThis.window = { __ModuleLoader__: { load: (value) => { definition = value; } } };
await import('../client.js');

/** A fresh plugin instance (its own closures) over a fresh React shim. */
function instantiate() {
  const react = createReactShim();
  const plugin = definition.factory((request) => {
    if (request === 'react') return react;
    throw new Error(`unexpected require(${request})`);
  });
  return { plugin, react };
}

/** Register the bundle and hand back the page the Plugins page would render. */
function registeredPage(options = {}) {
  const { plugin, react } = instantiate();
  const state = options.state ?? { value: EMPTY_VALUE, revision: 7, writable: true, mode: 'host' };
  const calls = [];
  const controller = {
    getSnapshot: () => state,
    subscribe: () => () => {},
    mutate: options.mutate ?? (async (ops, revision) => {
      calls.push({ ops, revision });
      return true;
    }),
  };
  const hooks = { injected: [], registered: [], watched: [], requested: [], catalogCalls: 0 };
  plugin.apply(makeCtx(hooks, controller, options.catalog));
  const component = hooks.registered[0]?.component;
  assert.equal(typeof component, 'function', 'the page component is registered');
  return { component, react, controller, hooks, calls, plugin };
}

/** Walk an element tree, expanding function components. */
function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  visit(node);
  if (typeof node.type === 'function' && node.type.length <= 1) {
    walk(node.type(node.props), visit);
    return;
  }
  walk(node.props?.children, visit);
}
/** Collect elements matching a predicate. */
function findAll(tree, predicate) {
  const found = [];
  walk(tree, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
}

/** Render a tree to plain text, expanding function components. */
function renderText(node, out = []) {
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) renderText(child, out);
    return out;
  }
  if (node === null || typeof node !== 'object') return out;
  if (typeof node.type === 'function' && node.type.length <= 1) {
    renderText(node.type(node.props), out);
    return out;
  }
  renderText(node.props?.children, out);
  return out;
}

/**
 * Expand a tree once into plain host elements, so later assertions never re-run
 * a component (the hook shim keys state by call order, like React keys it by
 * instance).
 */
function materialize(node) {
  if (Array.isArray(node)) return node.map((child) => materialize(child));
  if (node === null || typeof node !== 'object') return node;
  if (typeof node.type === 'function' && node.type.length <= 1) return materialize(node.type(node.props));
  const children = node.props?.children;
  if (children === undefined) return node;
  return { ...node, props: { ...node.props, children: materialize(children) } };
}

/** Render the page with a reset hook cursor, after the catalog has loaded. */
async function renderPage(page, props = { view: 'page' }) {
  // Materializing is what runs the components (and their effects), so the
  // directory read has to start before the flush that awaits its answer.
  page.react.resetCursor();
  materialize(page.component(props));
  await flush();
  page.react.resetCursor();
  return materialize(page.component(props));
}

/** @returns the control bound to one configuration path. */
function byField(tree, field) {
  return findAll(tree, (node) => node.props?.['data-field'] === field)[0];
}

/**
 * @returns one control's props as a *fresh* render sees them.
 *
 * `byField` on an already materialized tree re-runs the components while walking
 * it, and the hook shim keys state by call order — so a re-run can read another
 * component's slot. Re-render instead of trusting a re-executed copy.
 * @param page - the registered page.
 * @param field - the `data-field` value.
 * @returns the control's props, or undefined.
 */
async function freshField(page, field) {
  const tree = await renderPage(page);
  const found = [];
  (function collect(node) {
    if (Array.isArray(node)) {
      for (const child of node) collect(child);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (node.props?.['data-field'] === field) found.push(node);
    collect(node.props?.children);
  })(tree);
  return found[0]?.props;
}

/** @returns the option values of the model select, read from a fresh render. */
async function freshModelChoices(page) {  const tree = await renderPage(page);
  return selectValues(tree, (label) => label.includes('auto'));
}

/** @returns the option values of one select, matched by a predicate over its options. */
function selectValues(tree, match) {
  const selects = findAll(tree, (node) => node.type === 'select');
  const select = selects.find((candidate) => findAll(candidate, () => true)
    .some((node) => node.type === 'option' && match(String(node.props.children))));
  return select === undefined ? undefined : select.props.children.map((option) => option.props.value);
}

test('client: every boolean control is a switch drawn from the aria state', async () => {
  const page = registeredPage({
    state: {
      value: {
        ...EMPTY_VALUE,
        endpoints: [{ id: 'machine-a', provider: 'local', model: 'auto', concurrency: 1, enabled: true }],
        triggers: [{ provider: 'local', concurrency: 2 }],
        tool: { enabled: false },
      },
      revision: 3,
      writable: true,
    },
  });
  let tree = await renderPage(page);

  // The value stays in a native checkbox: that is what keeps keyboard, focus and
  // assistive-technology semantics right, and what every existing assertion reads.
  for (const field of ['enabled', 'triggers.local.marked', 'endpoints.0.enabled', 'tool.enabled']) {
    assert.equal(byField(tree, field).props.type, 'checkbox', `${field} keeps its native checkbox`);
  }

  // The visual track mirrors that state through aria-checked, never a class.
  const readSwitch = (f) => {
    const label = findAll(tree, (node) => node.type === 'label'
      && findAll(node.props?.children, (child) => child.props?.['data-field'] === f).length > 0)[0];
    return findAll(label?.props?.children, (node) => node.props?.['aria-checked'] !== undefined)[0];
  };
  assert.equal(readSwitch('enabled').props['aria-checked'], 'true', 'on reads true');
  assert.equal(readSwitch('triggers.local.marked').props['aria-checked'], 'true');
  assert.equal(readSwitch('endpoints.0.enabled').props['aria-checked'], 'true');
  assert.equal(readSwitch('tool.enabled').props['aria-checked'], 'false', 'off reads false');

  // Flipping the checkbox is what the track follows.
  byField(tree, 'tool.enabled').props.onChange({ target: { checked: true } });
  tree = await renderPage(page);
  assert.equal(readSwitch('tool.enabled').props['aria-checked'], 'true', 'the track follows the new value');

  // The whole stylesheet ships once per page, not once per card.
  assert.equal(findAll(tree, (node) => node.type === 'style').length, 1);
});

test('client: switches are disabled on a read-only connection while keeping their value', async () => {
  const page = registeredPage({
    state: {
      value: { ...EMPTY_VALUE, endpoints: [{ id: 'machine-a', provider: 'local', model: 'auto', concurrency: 1 }] },
      revision: 3,
      writable: false,
      mode: 'memory',
    },
  });
  const tree = await renderPage(page);
  const input = byField(tree, 'enabled');
  assert.equal(input.props.disabled, true, 'the switch is not clickable');
  assert.equal(input.props.checked, true, 'but it still shows the stored value');
  assert.equal(byField(tree, 'endpoints.0.enabled').props.disabled, true, 'and so does the per-endpoint one');
});

test('client: the routing card keeps three controls and drops stickiness', async () => {
  const page = registeredPage();
  const tree = await renderPage(page);

  assert.ok(byField(tree, 'enabled') !== undefined, 'the runtime on/off switch stays');
  assert.ok(byField(tree, 'applyTo') !== undefined, 'the scope select stays');
  assert.ok(byField(tree, 'strategy') !== undefined, 'the placement select stays');
  // Removed from the page: stickiness is a property of the pool, not a preference.
  assert.equal(byField(tree, 'sticky'), undefined, 'no stickiness checkbox on the page');
  const strategies = byField(tree, 'strategy').props.children.map((option) => option.props.value);
  assert.deepEqual(strategies, ['least-busy', 'fixed'], 'round-robin is not offered any more');
});

test('client: each endpoint still has its own enable and name controls', async () => {
  const page = registeredPage({
    state: {
      value: {
        ...EMPTY_VALUE,
        endpoints: [{ id: 'machine-a', provider: 'local', model: 'auto', concurrency: 1, enabled: true }],
      },
      revision: 3,
      writable: true,
    },
  });
  const tree = await renderPage(page);
  assert.equal(byField(tree, 'endpoints.0.enabled').props.checked, true, 'the per-endpoint switch is a different field');
  assert.equal(byField(tree, 'endpoints.0.enabled').props.type, 'checkbox');
  assert.equal(byField(tree, 'endpoints.0.label').props.type, 'text');
});

test('client: the page is registered for this bundle card while the namespace is served', () => {
  const page = registeredPage();
  assert.equal(definition.id, 'dsh-local-compute-pool');
  assert.deepEqual(page.plugin.inject, ['slots', 'locale', 'remote', 'remote.session', 'configForms']);

  assert.equal(page.hooks.watched[0], 'local-compute-pool', 'follows its own settings namespace');
  assert.equal(page.hooks.requested[0], 'local-compute-pool', 'the form binds that namespace');
  assert.equal(page.hooks.injected[0], 'plugins.bundle.config', 'the bundle card hosts the page');
  assert.equal(page.hooks.registered[0].options.name, 'plugins.bundle.config');
  assert.equal(page.hooks.registered[0].options.key, 'dsh-local-compute-pool', 'keyed by package name');
});

test('client: summary view renders a one-liner', () => {
  const page = registeredPage();
  page.react.resetCursor();
  assert.match(renderText(materialize(page.component({ view: 'summary' }))).join(' '), /«summary»/);
});

test('client: an empty endpoint list invites adding one', async () => {
  const page = registeredPage();
  const text = renderText(await renderPage(page)).join(' ');
  assert.match(text, /«emptyEndpoints»/);
  assert.match(text, /«addEndpoint»/);
  assert.equal(page.hooks.catalogCalls, 1, 'the directory is read once');
});

test('client: provider and model dropdowns come from the Host directory', async () => {
  const page = registeredPage({
    state: {
      value: { ...EMPTY_VALUE, endpoints: [{ id: 'machine-a', provider: 'local', model: 'auto', concurrency: 1 }] },
      revision: 4,
      writable: true,
    },
  });
  const tree = await renderPage(page);
  const providers = selectValues(tree, (label) => label.includes('本地'));
  assert.deepEqual(providers, ['local', 'local-strata'], 'every configured provider is offered');
  const models = selectValues(tree, (label) => label.includes('auto') || label.includes('Qwen3 Local'));
  assert.deepEqual(models, ['auto', 'qwen3-local'], 'auto plus that provider\'s models');
});

test('client: adding an endpoint writes the whole array in one atomic batch', async () => {
  const page = registeredPage();
  let tree = await renderPage(page);
  const add = findAll(tree, (node) => node.type === 'button' && /addEndpoint/.test(String(node.props.children)))[0];
  assert.ok(add !== undefined, 'the add button renders');
  assert.equal(add.props.disabled, false, 'add is enabled once providers are known');
  add.props.onClick();

  tree = await renderPage(page);
  const text = renderText(tree).join(' ');
  assert.match(text, /local/, 'the new row shows the first provider');

  const save = findAll(tree, (node) => node.type === 'button' && /«save»/.test(String(node.props.children)))[0];
  await save.props.onClick();

  assert.equal(page.calls.length, 1);
  assert.equal(page.calls[0].revision, 7, 'the write is fenced by the revision the draft read');
  assert.deepEqual(page.calls[0].ops, [{
    op: 'set',
    path: ['endpoints'],
    value: [{ id: 'local', provider: 'local', model: 'auto', concurrency: 1, enabled: true }],
  }]);
});

test('client: removing an endpoint writes the remaining array', async () => {
  const page = registeredPage({
    state: {
      value: {
        ...EMPTY_VALUE,
        endpoints: [
          { id: 'a', provider: 'local', model: 'auto', concurrency: 1, enabled: true },
          { id: 'b', provider: 'local-strata', model: 'auto', concurrency: 1, enabled: true },
        ],
      },
      revision: 9,
      writable: true,
    },
  });
  let tree = await renderPage(page);
  const remove = findAll(tree, (node) => node.type === 'button' && /removeEndpoint/.test(String(node.props.children)))[0];
  assert.ok(remove !== undefined, 'each endpoint offers removal');
  remove.props.onClick();

  tree = await renderPage(page);
  const save = findAll(tree, (node) => node.type === 'button' && /«save»/.test(String(node.props.children)))[0];
  await save.props.onClick();

  assert.deepEqual(page.calls[0].ops, [{
    op: 'set',
    path: ['endpoints'],
    value: [{ id: 'b', provider: 'local-strata', model: 'auto', concurrency: 1, enabled: true }],
  }]);
});

test('client: switching the provider updates the model list before saving, and drops the dead pin', async () => {
  const page = registeredPage({
    state: {
      value: {
        ...EMPTY_VALUE,
        endpoints: [{ id: 'machine-a', provider: 'local', model: 'qwen3-local', concurrency: 1 }],
      },
      revision: 4,
      writable: true,
    },
  });
  const tree = await renderPage(page);
  // The row starts on `local`, pinned to that provider's model.
  assert.deepEqual(await freshModelChoices(page), ['auto', 'qwen3-local'], 'the saved provider drives the list');

  byField(tree, 'endpoints.0.provider').props.onChange({ target: { value: 'local-strata' } });

  const models = await freshModelChoices(page);
  assert.deepEqual(models, ['auto', 'strata-model'], `the list follows the chosen provider, not the saved one (got ${JSON.stringify(models)})`);
  assert.equal((await freshField(page, 'endpoints.0.model')).value, 'auto', 'a pin from the previous provider is not carried over');

  const save = findAll(await renderPage(page), (node) => node.type === 'button' && /«save»/.test(String(node.props.children)))[0];
  await save.props.onClick();
  assert.deepEqual(page.calls[0].ops, [{
    op: 'set',
    path: ['endpoints'],
    value: [{ id: 'machine-a', provider: 'local-strata', model: 'auto', concurrency: 1 }],
  }], 'one save writes the provider and the reset model together');
});

test('client: an endpoint name is editable and saved with the row', async () => {
  const page = registeredPage({
    state: {
      value: {
        ...EMPTY_VALUE,
        endpoints: [{ id: 'machine-a', provider: 'local', model: 'auto', concurrency: 1, label: '本机 (:8888)' }],
      },
      revision: 6,
      writable: true,
    },
  });
  let tree = await renderPage(page);
  assert.equal(byField(tree, 'endpoints.0.label').props.value, '本机 (:8888)', 'the stored name is shown');
  assert.match(renderText(tree).join(' '), /本机 \(:8888\)/, 'the row header uses the name');

  byField(tree, 'endpoints.0.label').props.onChange({ target: { value: '书房的 4090' } });
  tree = await renderPage(page);
  const save = findAll(tree, (node) => node.type === 'button' && /«save»/.test(String(node.props.children)))[0];
  await save.props.onClick();

  assert.deepEqual(page.calls[0].ops, [{
    op: 'set',
    path: ['endpoints'],
    value: [{ id: 'machine-a', provider: 'local', model: 'auto', concurrency: 1, label: '书房的 4090' }],
  }]);
});

test('client: scalar edits keep their own path ops alongside the array', async () => {
  const page = registeredPage();
  let tree = await renderPage(page);
  byField(tree, 'health.failureThreshold').props.onChange({ target: { value: '1' } });

  tree = await renderPage(page);
  const save = findAll(tree, (node) => node.type === 'button' && /«save»/.test(String(node.props.children)))[0];
  await save.props.onClick();

  assert.equal(page.calls.length, 1);
  assert.deepEqual(page.calls[0].ops, [{ op: 'set', path: ['health', 'failureThreshold'], value: 1 }]);
});

test('client: the whitelist lists every configured provider, unmarked by default', async () => {
  const page = registeredPage();
  const tree = await renderPage(page);
  assert.equal(byField(tree, 'triggers.local.marked').props.checked, false);
  assert.equal(byField(tree, 'triggers.local-strata.marked').props.checked, false);
  assert.equal(byField(tree, 'triggers.local.concurrency').props.disabled, true, 'the number follows the mark');
  assert.equal(byField(tree, 'triggers.local.concurrency').props.value, 1);
});

test('client: marking a provider and setting its cap writes the whitelist', async () => {
  const page = registeredPage();
  let tree = await renderPage(page);
  byField(tree, 'triggers.local-strata.marked').props.onChange({ target: { checked: true } });

  tree = await renderPage(page);
  assert.equal(byField(tree, 'triggers.local-strata.concurrency').props.disabled, false, 'now editable');
  byField(tree, 'triggers.local-strata.concurrency').props.onChange({ target: { value: '3' } });

  tree = await renderPage(page);
  const save = findAll(tree, (node) => node.type === 'button' && /«save»/.test(String(node.props.children)))[0];
  await save.props.onClick();

  assert.deepEqual(page.calls[0].ops, [{
    op: 'set',
    path: ['triggers'],
    value: [{ provider: 'local-strata', concurrency: 3 }],
  }]);
});

test('client: unmarking a provider removes it from the whitelist', async () => {
  const page = registeredPage({
    state: {
      value: {
        ...EMPTY_VALUE,
        triggers: [
          { provider: 'local', concurrency: 2 },
          { provider: 'local-strata', concurrency: 1 },
        ],
      },
      revision: 5,
      writable: true,
    },
  });
  let tree = await renderPage(page);
  assert.equal(byField(tree, 'triggers.local.marked').props.checked, true);
  assert.equal(byField(tree, 'triggers.local.concurrency').props.value, 2);
  byField(tree, 'triggers.local.marked').props.onChange({ target: { checked: false } });

  tree = await renderPage(page);
  const save = findAll(tree, (node) => node.type === 'button' && /«save»/.test(String(node.props.children)))[0];
  await save.props.onClick();

  assert.deepEqual(page.calls[0].ops, [{
    op: 'set',
    path: ['triggers'],
    value: [{ provider: 'local-strata', concurrency: 1 }],
  }]);
});

test('client: a whitelist entry the directory no longer lists stays removable', async () => {
  const page = registeredPage({
    state: {
      value: { ...EMPTY_VALUE, triggers: [{ provider: 'retired-provider', concurrency: 1 }] },
      revision: 2,
      writable: true,
    },
  });
  const tree = await renderPage(page);
  assert.equal(byField(tree, 'triggers.retired-provider.marked').props.checked, true);
  assert.match(renderText(tree).join(' '), /retired-provider/);
  assert.match(renderText(tree).join(' '), /«whitelistMissing»/);
});

test('client: a refused write refreshes the draft and says so', async () => {
  const page = registeredPage({
    state: {
      value: { ...EMPTY_VALUE, endpoints: [{ id: 'a', provider: 'local', model: 'auto', concurrency: 1 }] },
      revision: 2,
      writable: true,
    },
    mutate: async () => false,
  });
  let tree = await renderPage(page);
  const remove = findAll(tree, (node) => node.type === 'button' && /removeEndpoint/.test(String(node.props.children)))[0];
  remove.props.onClick();
  tree = await renderPage(page);
  const save = findAll(tree, (node) => node.type === 'button' && /«save»/.test(String(node.props.children)))[0];
  await save.props.onClick();
  tree = await renderPage(page);
  const text = renderText(tree).join(' ');
  assert.match(text, /«refused»/);
  assert.doesNotMatch(text, /«saved»/);
});

test('client: a directory that is not configured yet is reported', async () => {
  const page = registeredPage({ catalog: { ok: true, value: { groups: [], failures: [] } } });
  const text = renderText(await renderPage(page)).join(' ');
  assert.match(text, /«noProviders»/);
  const add = findAll(await renderPage(page), (node) => node.type === 'button' && /addEndpoint/.test(String(node.props.children)))[0];
  assert.equal(add.props.disabled, true, 'no provider to add');
});

test('client: a failed directory read offers a retry', async () => {
  const page = registeredPage({ catalog: { ok: false } });
  const tree = await renderPage(page);
  const text = renderText(tree).join(' ');
  assert.match(text, /«catalogFailed»/);
  assert.match(text, /«retry»/);
});

test('client: a read-only connection disables saving and says why', async () => {
  const page = registeredPage({ state: { value: EMPTY_VALUE, revision: 3, writable: false, mode: 'memory' } });
  const tree = await renderPage(page);
  const text = renderText(tree).join(' ');
  assert.match(text, /«notWritable»/);
  const add = findAll(tree, (node) => node.type === 'button' && /addEndpoint/.test(String(node.props.children)))[0];
  assert.equal(add.props.disabled, true);
});
