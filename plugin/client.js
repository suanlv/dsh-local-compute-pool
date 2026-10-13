/**
 * Local compute pool — browser half.
 *
 * Renders this bundle's own configuration page inside the Plugins section:
 * the bundle card opens on a page whose body is this component, right where the
 * shipped feature bundles put theirs (`plugins.bundle.config`, keyed by the
 * package name).
 *
 * The endpoint list is not fixed: it starts empty, and providers plus models are
 * chosen from the live directory (`remote.session.modelCatalog()`, the same
 * source the official Subagent page reads) instead of being typed by hand.
 * Saving writes the whole `endpoints` array plus the edited scalars in one
 * revision-fenced `mutate`, so adds, removals, and edits cannot race each other.
 *
 * Controls and styles are the bundle's own, built on theme tokens only: a plain
 * bundle must not import a Harness Client package such as ui-primitives.
 */
window.__ModuleLoader__.load({
  id: 'dsh-local-compute-pool',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace owned by this page. */
    const NS = 'local-compute-pool';
    /** Settings namespace = this bundle row's Loader entry id. */
    const ENTRY_ID = 'local-compute-pool';
    /** `plugins.bundle.config` cell: this bundle's own card. */
    const BUNDLE_KEY = 'dsh-local-compute-pool';
    /** Separator used to key drafts by a configuration path. */
    const SEP = '\u0000';
    /** The sentinel the Host resolves to the provider's first advertised model. */
    const AUTO_MODEL = 'auto';

    const zh = {
      summary: '把子代理分配到多台机器的本地模型上：按负载铺开、每端点排队限流、失败冷却换机。',
      intro: '主代理保持自己的模型；被委派的子代理会落到下面这些本地端点。改动写入 profile 配置并立即生效。',
      routing: '路由',
      whitelist: '触发白名单',
      whitelistHint: '只有使用这些 provider 的任务，才会把子代理交给本地端点并行执行；勾选即启用。',
      whitelistEmpty: '目录里还没有可勾选的 provider：先在"设置 → 模型"里配好 provider。',
      whitelistMissing: '（配置里有，但目录中已不存在）',
      taskLimit: '并行上限',
      taskLimitHint: '该 provider 的任务最多同时运行几个本地子代理；会写进该任务的提示词，并真实限流（超出排队）。',
      subagentPool: '子代理模型池',
      subagentPoolHint: '白名单任务会尝试把子代理分配给下面这些 provider/模型；每项"并发"是该端点能同时服务的请求数。',
      endpoints: '本地端点',
      failures: '失败与冷却',
      admission: '排队准入',
      routing: '路由',
      routingHint: '只有停在标题旁的插件开关会停用整个插件；下面这些改完保存即生效，不用重启。',
      enabled: '启用路由',
      enabledHint: '只停掉"接管子代理"这一件事：关闭后子代理保持原线路，其余设置不变。要彻底停用整个插件，用标题旁的开关。',
      applyTo: '作用范围',
      applyToChildren: '仅子代理',
      applyToAll: '主代理也走本地',
      applyToHint: '仅子代理：主代理保持自己的模型。"主代理也走本地"会把主代理的整段对话都落到本地模型，工具调用能力取决于该模型本身。',
      strategy: '分配策略',
      strategyLeastBusy: '按负载（默认）',
      strategyFixed: '固定第一台',
      strategyHint: '只有一台可用端点时两种策略完全一样；多台时"按负载"会优先选空闲的。',
      failureThreshold: '换机器前允许的连续失败次数',
      failureThresholdHint: '同时也是"在同一台上重试几次"：设为 1 可最快换机。',
      cooldownMs: '失败后冷却时长（毫秒）',
      cooldownMsHint: '默认 120000；某台机器经常关机就调大。',
      maxWaiting: '单端点排队上限',
      timeoutMs: '排队超时（毫秒）',
      timeoutMsHint: '默认 600000；本地模型很慢时调大。',
      toolEnabled: '注册 local_pool 状态工具',
      toolHint: '让模型查看每台机器在跑 / 排队 / 冷却的数量。',
      provider: '已配置的 provider',
      label: '名称',
      labelHint: '给这台机器起个名字（可留空）。只影响显示，不影响路由；端点标识 id 保持不变。',
      model: '模型',
      concurrency: '并发',
      concurrencyHint: '服务端支持批处理时才调大，默认 1。',
      endpointEnabled: '参与分配',
      addEndpoint: '＋ 添加本地端点',
      removeEndpoint: '删除',
      emptyEndpoints: '还没有端点。点下面的"添加本地端点"，从已配置的 provider 里选一个（例如 local、local-strata）。',
      loadingCatalog: '正在读取已配置的 provider 与模型…',
      catalogFailed: '读取 provider 目录失败。',
      retry: '重试',
      catalogPartial: '有 provider 读取失败，列表可能不完整。',
      noProviders: '当前没有可用的 provider：请先在"设置 → 模型"里配好本地 OpenAI 兼容 provider。',
      keepUnavailable: '（已配置但目录里没有）',
      autoModel: 'auto（该 provider 的第一个模型）',
      save: '保存',
      saving: '保存中…',
      saved: '已保存并立即生效。',
      discard: '放弃改动',
      refused: '宿主拒绝了这次写入（可能是配置已被别处改动），已刷新为最新值。',
      invalidNumber: '数字字段需要填写有效数字。',
      notWritable: '当前连接不能写入配置（需要在跑 DSH 的本机页面打开）。',
      stateHint: '运行时状态（在跑 / 排队 / 冷却）不在这个页面：让模型调用 local_pool 工具查看。',
      loading: '正在读取配置…',
    };
    const en = {
      summary: 'Spread delegated subagents across several local model endpoints, with per-endpoint queues and failover.',
      intro: 'The main agent keeps its own model; delegated children land on the endpoints below. Changes persist to the profile configuration and apply immediately.',
      routing: 'Routing',
      whitelist: 'Trigger whitelist',
      whitelistHint: 'Only tasks running on these providers hand their subagents to the local endpoints; tick one to enable it.',
      whitelistEmpty: 'No provider to tick yet: configure one under Settings → Models first.',
      whitelistMissing: '(configured, no longer in the directory)',
      taskLimit: 'Parallel limit',
      taskLimitHint: 'How many local subagents one task on this provider may run at once — written into that task\'s prompt and enforced (extra work queues).',
      subagentPool: 'Subagent model pool',
      subagentPoolHint: 'Whitelisted tasks place their subagents on these provider/model rows; each row\'s concurrency is what that endpoint serves at once.',
      endpoints: 'Endpoints',
      failures: 'Failures',
      admission: 'Admission',
      routing: 'Routing',
      routingHint: 'Only the card switch beside the title disables the whole plugin; everything below applies as soon as you save, without a restart.',
      enabled: 'Route subagents',
      enabledHint: 'Turns off taking over subagents only: after that a child keeps the route the harness resolved, and every other setting stays as it is. To stop the plugin entirely, use the card switch.',
      applyTo: 'Applies to',
      applyToChildren: 'Subagents only',
      applyToAll: 'Main agent too',
      applyToHint: 'Subagents only keeps the main agent on its own model. "Main agent too" moves the main conversation onto a local model; tool calling then depends on that model.',
      strategy: 'Placement',
      strategyLeastBusy: 'Least busy (default)',
      strategyFixed: 'First endpoint',
      strategyHint: 'With a single usable endpoint both policies behave identically; with several, "least busy" prefers the idle one.',
      failureThreshold: 'Failures before switching machines',
      failureThresholdHint: 'Also the retries allowed on one machine: 1 switches fastest.',
      cooldownMs: 'Cooldown after failures (ms)',
      cooldownMsHint: 'Default 120000; raise it when a machine is often off.',
      maxWaiting: 'Queue depth per endpoint',
      timeoutMs: 'Queue timeout (ms)',
      timeoutMsHint: 'Default 600000; raise it for very slow local models.',
      toolEnabled: 'Register the local_pool status tool',
      toolHint: 'Lets the model inspect in-flight / queued / parked counts per machine.',
      provider: 'Configured provider',
      label: 'Name',
      labelHint: 'A name for this machine (optional). Display only — routing is unaffected and the endpoint id stays as it is.',
      model: 'Model',
      concurrency: 'Concurrency',
      concurrencyHint: 'Raise only when the server batches; 1 by default.',
      endpointEnabled: 'In rotation',
      addEndpoint: '+ Add a local endpoint',
      removeEndpoint: 'Remove',
      emptyEndpoints: 'No endpoints yet. Use "Add a local endpoint" and pick one of your configured providers (for example local, local-strata).',
      loadingCatalog: 'Reading the configured providers and models…',
      catalogFailed: 'Reading the provider directory failed.',
      retry: 'Retry',
      catalogPartial: 'Some providers failed to load; the list may be incomplete.',
      noProviders: 'No provider is available: configure a local OpenAI-compatible provider under Settings → Models first.',
      keepUnavailable: '(configured, not in the directory)',
      autoModel: 'auto (the provider\'s first model)',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved and applied.',
      discard: 'Discard changes',
      refused: 'The Host refused this write (the configuration may have moved); the page refreshed to the latest values.',
      invalidNumber: 'Number fields need a valid number.',
      notWritable: 'This connection cannot write configuration (open the page on the machine running DSH).',
      stateHint: 'Runtime state (in flight / queued / parked) is not on this page: ask the model to call the local_pool tool.',
      loading: 'Reading configuration…',
    };

    /**
     * The page's stylesheet, rendered once at the root.
     *
     * Controls deliberately mirror the harness primitives (`Switch`, `Input`,
     * `Button`) token for token — a bundle cannot import a Client package, so the
     * only way to look native is to use the same variables they use. Every colour
     * carries a fallback so a deployment without the tokens still shows something
     * visible instead of an invisible control.
     */
    const CSS = `
.bls-root { display: flex; flex-direction: column; gap: 18px; color: var(--dsw-alias-label-primary); font-size: 13px; }
.bls-note { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; margin: 0; }
.bls-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 12px 14px; background: var(--dsw-alias-bg-layer-1); display: flex; flex-direction: column; gap: 10px; }
.bls-cardTitle { margin: 0; padding-bottom: 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 13px; font-weight: 500; }
.bls-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 28px; }
.bls-rowText { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.bls-label { font-size: 13px; }
.bls-hint { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.bls-input { width: 240px; box-sizing: border-box; height: 32px; padding: 0 8px; border: 0.5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l1)); border-radius: var(--dsw-radius-md, 6px); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 14px; font-family: inherit; }
.bls-input:focus-within, .bls-input:focus { border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); outline: none; }
.bls-inputSmall { width: 72px; }
.bls-number { text-align: right; font-variant-numeric: tabular-nums; }
.bls-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.bls-switch { display: inline-flex; align-items: center; cursor: pointer; }
.bls-switchInput { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; opacity: 0; pointer-events: none; }
.bls-switchTrack { box-sizing: border-box; position: relative; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border-radius: 999px; corner-shape: round; background: var(--dsw-alias-border-l3, #d0d5dd); transition: background 120ms ease; }
.bls-switchTrack[aria-checked='true'] { background: var(--dsw-alias-brand-primary, #2F6FEB); }
.bls-switchThumb { display: block; width: 16px; height: 16px; border-radius: 50%; corner-shape: round; background: var(--dsw-alias-switch-thumb, #fff); transition: transform 120ms ease; }
.bls-switchTrack[aria-checked='true'] .bls-switchThumb { transform: translateX(16px); background: var(--dsw-alias-label-primary-foreground, #fff); }
.bls-switchInput:focus-visible + .bls-switchTrack { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #2F6FEB)); outline-offset: 2px; }
.bls-switch:has(.bls-switchInput:disabled) { cursor: default; opacity: 0.5; }
.bls-endpoint { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 12px 14px; background: var(--dsw-alias-bg-layer-2); display: flex; flex-direction: column; gap: 10px; }
.bls-endpointHead { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.bls-endpointId { font-weight: 500; }
.bls-empty { border: 1px dashed var(--dsw-alias-border-l3, var(--dsw-alias-border-l1)); border-radius: 8px; padding: 12px; text-align: center; }
.bls-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.bls-button { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; height: 28px; padding: 0 10px; border: none; border-radius: var(--dsw-radius-sm, 4px); background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)); color: var(--dsw-alias-label-primary-foreground, #fff); font-size: 12px; line-height: 18px; font-family: inherit; cursor: pointer; }
.bls-button:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary)); }
.bls-button:disabled { opacity: .4; cursor: not-allowed; }
.bls-ghost { background: transparent; color: var(--dsw-alias-label-primary); }
.bls-ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.bls-danger { background: transparent; color: var(--dsw-alias-state-error-primary); border: 0.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l1)); }
.bls-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.bls-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.bls-ok { color: var(--dsw-alias-state-success-primary); font-size: 12px; }
.bls-link { background: none; border: 0; padding: 0; color: var(--dsw-alias-brand-primary); font-size: 12px; font-family: inherit; cursor: pointer; }
`.trim();

    /** @returns the value at one path, or undefined. */
    function getAt(value, path) {
      let node = value;
      for (const key of path) {
        if (node === null || node === undefined) return undefined;
        node = node[key];
      }
      return node;
    }

    /** @returns a fresh endpoint id derived from the provider, unique in `endpoints`. */
    function nextEndpointId(endpoints, provider) {
      const base = String(provider ?? 'endpoint').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'endpoint';
      const taken = new Set(endpoints.map((endpoint) => endpoint?.id));
      if (!taken.has(base)) return base;
      let index = 2;
      while (taken.has(`${base}-${index}`)) index += 1;
      return `${base}-${index}`;
    }

    /**
     * The live provider/model directory behind the two dropdowns.
     * @param ctx - the page plugin's context (injects `remote` and `remote.session`).
     * @returns a tiny store the page subscribes to.
     */
    function createCatalog(ctx) {
      let state = { status: 'idle', groups: [], failures: [] };
      const listeners = new Set();
      const publish = (next) => {
        state = next;
        for (const listener of [...listeners]) listener();
      };
      const load = async () => {
        if (state.status === 'loading') return;
        publish({ ...state, status: 'loading' });
        try {
          const response = await ctx.remote.session.modelCatalog();
          if (response?.ok === true) {
            publish({
              status: 'ready',
              groups: Array.isArray(response.value?.groups) ? response.value.groups : [],
              failures: Array.isArray(response.value?.failures) ? response.value.failures : [],
            });
          } else {
            publish({ ...state, status: 'error' });
          }
        } catch (error) {
          publish({ status: 'error', groups: [], failures: [], message: error?.message ?? String(error) });
        }
      };
      ctx.effect(() => ctx.remote.$on('llm/adapters-updated', () => {
        void load();
      }), 'local-compute-pool: catalog on adapter change');
      ctx.effect(() => ctx.remote.$on('settings/document-updated', () => {
        void load();
      }), 'local-compute-pool: catalog on settings change');
      ctx.effect(() => ctx.on('connection/reset', () => {
        void load();
      }), 'local-compute-pool: catalog after reconnect');
      return {
        getSnapshot: () => state,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        load,
      };
    }

    /** One labelled control row. */
    function Row({ label, hint, children }) {
      return h('div', { className: 'bls-row' }, [
        h('div', { className: 'bls-rowText', key: 'text' }, [
          h('span', { className: 'bls-label', key: 'label' }, label),
          hint === undefined ? null : h('span', { className: 'bls-hint', key: 'hint' }, hint),
        ]),
        h('div', { key: 'control' }, children),
      ]);
    }

    /**
     * One on/off control drawn like the harness `Switch` primitive.
     *
     * The value still lives in a native checkbox: keyboard focus, the space key,
     * and the assistive-technology semantics all come from it for free, and the
     * visual layer is a sibling span. The span's state keys off `aria-checked`
     * rather than a class, exactly as the official primitive does, so the picture
     * can never disagree with the state a screen reader reads.
     *
     * Declared at module scope on purpose: a component type created during a
     * render is a new type every time, and React would unmount and remount the
     * subtree — losing focus and restarting the thumb transition on every keystroke
     * elsewhere on the page.
     * @param options - `{ field, checked, disabled, onChange }`.
     * @returns the label wrapping the input and its track.
     */
    function Switch({ field, checked, disabled, onChange }) {
      return h('label', { className: 'bls-switch' }, [
        h('input', {
          key: 'input',
          type: 'checkbox',
          className: 'bls-switchInput',
          'data-field': field,
          checked: checked === true,
          disabled: disabled === true,
          onChange: (event) => onChange(event.target.checked),
        }),
        h('span', { key: 'track', className: 'bls-switchTrack', 'aria-checked': String(checked === true) }, [
          h('span', { key: 'thumb', className: 'bls-switchThumb' }),
        ]),
      ]);
    }

    /** The editable page for this bundle's settings namespace. */
    function Editor({ t, controller, catalog }) {
      const readState = () => controller?.getSnapshot?.() ?? {};
      const [state, setState] = React.useState(readState);
      const [directory, setDirectory] = React.useState(() => catalog.getSnapshot());
      const [draft, setDraft] = React.useState({});
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [saved, setSaved] = React.useState(false);

      React.useEffect(() => {
        if (typeof controller?.subscribe !== 'function') return undefined;
        const off = controller.subscribe(() => setState(readState()));
        return () => {
          off?.();
        };
      }, [controller]);

      React.useEffect(() => {
        const off = catalog.subscribe(() => setDirectory(catalog.getSnapshot()));
        if (catalog.getSnapshot().status === 'idle') void catalog.load();
        return () => {
          off?.();
        };
      }, [catalog]);

      const value = state.value ?? {};
      const keyOf = (path) => path.join(SEP);
      const ENDPOINTS_KEY = keyOf(['endpoints']);
      const hasDraftEndpoints = Object.prototype.hasOwnProperty.call(draft, ENDPOINTS_KEY);
      const endpoints = hasDraftEndpoints
        ? draft[ENDPOINTS_KEY]
        : (Array.isArray(value.endpoints) ? value.endpoints : []);
      const TRIGGERS_KEY = keyOf(['triggers']);
      const hasDraftTriggers = Object.prototype.hasOwnProperty.call(draft, TRIGGERS_KEY);
      const triggers = hasDraftTriggers
        ? draft[TRIGGERS_KEY]
        : (Array.isArray(value.triggers) ? value.triggers : []);

      const read = (path) => {
        const key = keyOf(path);
        return Object.prototype.hasOwnProperty.call(draft, key) ? draft[key] : getAt(value, path);
      };
      const write = (path, next) => {
        setSaved(false);
        setDraft((currentDraft) => ({ ...currentDraft, [keyOf(path)]: next }));
      };
      const writeEndpoints = (next) => {
        setSaved(false);
        setDraft((currentDraft) => ({ ...currentDraft, [ENDPOINTS_KEY]: next }));
      };
      const writeTriggers = (next) => {
        setSaved(false);
        setDraft((currentDraft) => ({ ...currentDraft, [TRIGGERS_KEY]: next }));
      };
      const triggerFor = (provider) => triggers.find((trigger) => trigger?.provider === provider);

      /**
       * Mark or unmark one provider, keeping its number.
       * @param provider - the provider id.
       * @param patch - `{ concurrency }` to set one, `{}` to keep, `null` to unmark.
       */
      const setTrigger = (provider, patch) => {
        const rest = triggers.filter((trigger) => trigger?.provider !== provider);
        if (patch === null) {
          writeTriggers(rest);
          return;
        }
        writeTriggers([...rest, { provider, concurrency: 1, ...(triggerFor(provider) ?? {}), ...patch }]);
      };
      /**
       * Patch one endpoint row against whatever the draft currently holds.
       *
       * The transform form matters: a handler may run in a render whose closed-over
       * `endpoints` is stale (React batches, and a control can be invoked from a
       * previously rendered tree). Reading the draft inside the updater keeps the
       * change additive instead of replacing the array with an old copy.
       * @param index - the endpoint row.
       * @param patch - fields to merge into that row.
       */
      const patchEndpoint = (index, patch) => {
        setSaved(false);
        setDraft((currentDraft) => {
          const current = Object.prototype.hasOwnProperty.call(currentDraft, ENDPOINTS_KEY)
            ? currentDraft[ENDPOINTS_KEY]
            : (Array.isArray(value.endpoints) ? value.endpoints : []);
          return {
            ...currentDraft,
            [ENDPOINTS_KEY]: current.map((endpoint, position) => (position === index ? { ...endpoint, ...patch } : endpoint)),
          };
        });
      };

      /**
       * Point one endpoint row at another provider, resetting its pinned model.
       *
       * The pinned model belonged to the previous provider, so it goes back to
       * `auto` in the same array write: an exact id from another provider is
       * never what the new one advertises, and carrying it over is what made the
       * model list look like it still came from the old provider. One array key
       * changes, so one save writes provider and model together.
       * @param index - the endpoint row.
       * @param provider - the chosen provider id.
       */
      const setEndpointProvider = (index, provider) => {
        patchEndpoint(index, { provider, model: AUTO_MODEL });
      };

      const providers = [];
      const modelsByProvider = new Map();
      for (const group of directory.groups) {
        const id = group?.id;
        if (typeof id !== 'string' || id.length === 0) continue;
        providers.push({ id, name: typeof group.name === 'string' && group.name.length > 0 ? group.name : id });
        modelsByProvider.set(id, (Array.isArray(group.models) ? group.models : [])
          .map((model) => ({ id: model?.id, name: typeof model?.name === 'string' && model.name.length > 0 ? model.name : model?.id }))
          .filter((model) => typeof model.id === 'string' && model.id.length > 0));
      }

      const dirtyKeys = Object.keys(draft);
      const numberIssue = dirtyKeys.some((key) => {
        if (key === ENDPOINTS_KEY) return false;
        const next = draft[key];
        return typeof next === 'number' && !Number.isFinite(next);
      });

      const save = async () => {
        if (dirtyKeys.length === 0 || numberIssue) return;
        setBusy(true);
        setError(null);
        const ops = dirtyKeys
          .filter((key) => key !== ENDPOINTS_KEY && key !== TRIGGERS_KEY)
          .map((key) => ({ op: 'set', path: key.split(SEP), value: draft[key] }));
        if (hasDraftEndpoints) {
          ops.push({
            op: 'set',
            path: ['endpoints'],
            value: endpoints.map((endpoint) => ({
              ...endpoint,
              model: typeof endpoint.model === 'string' && endpoint.model.length > 0 ? endpoint.model : AUTO_MODEL,
            })),
          });
        }
        if (hasDraftTriggers) {
          ops.push({
            op: 'set',
            path: ['triggers'],
            value: triggers.map((trigger) => ({
              provider: trigger.provider,
              concurrency: typeof trigger.concurrency === 'number' && trigger.concurrency > 0 ? trigger.concurrency : 1,
            })),
          });
        }
        try {
          const accepted = await controller.mutate(ops, state.revision);
          setDraft({});
          if (accepted === false) setError(t('refused'));
          else setSaved(true);
        } catch (failure) {
          setError(failure?.message ?? String(failure));
        } finally {
          setBusy(false);
        }
      };

      /** @returns a switch bound to one configuration path. */
      const toggle = (path, options = {}) => h(Switch, {
        field: path.join('.'),
        checked: read(path) === true,
        disabled: options.disabled === true,
        onChange: (next) => write(path, next),
      });

      const number = (path, min) => h('input', {
        type: 'number',
        min,
        className: 'bls-input bls-inputSmall',
        'data-field': path.join('.'),
        value: read(path) ?? '',
        onChange: (event) => {
          const raw = event.target.value;
          write(path, raw === '' ? undefined : Number(raw));
        },
      });

      const select = (path, choices) => h('select', {
        className: 'bls-input',
        'data-field': path.join('.'),
        value: read(path) ?? choices[0][0],
        onChange: (event) => write(path, event.target.value),
      }, choices.map(([optionValue, optionLabel]) => h('option', { key: optionValue, value: optionValue }, optionLabel)));

      /** Provider choices: the directory, plus any configured value it no longer lists. */
      const providerChoices = (current) => {
        const choices = providers.map((provider) => [provider.id, `${provider.name} (${provider.id})`]);
        if (typeof current === 'string' && current.length > 0 && !providers.some((provider) => provider.id === current)) {
          choices.push([current, `${current} ${t('keepUnavailable')}`]);
        }
        return choices;
      };

      /**
       * Choose one endpoint row's model.
       *
       * The row's own array entry is the single source of truth: a provider
       * switch rewrites that entry (provider plus a reset model) in one array
       * write, so this stays consistent with it. Reading the pinned model from a
       * separate per-path draft would keep offering the previous provider's
       * model until a save.
       * @param index - the endpoint row.
       * @param endpoint - the row's current values.
       * @returns the model select element, defaulting to `auto`.
       */
      const modelSelect = (index, endpoint) => h('select', {
        className: 'bls-input',
        'data-field': `endpoints.${index}.model`,
        value: typeof endpoint.model === 'string' && endpoint.model.length > 0 ? endpoint.model : AUTO_MODEL,
        onChange: (event) => patchEndpoint(index, { model: event.target.value }),
      }, modelChoices(effectiveProvider(index, endpoint), endpoint.model)
        .map(([optionValue, optionLabel]) => h('option', { key: optionValue, value: optionValue }, optionLabel)));

      /**
       * Choose one endpoint row's provider.
       *
       * Only the row's array entry changes; provider and a reset model go in one
       * write, so the row has a single source of truth and one save is one op.
       * @param index - the endpoint row.
       * @param endpoint - the row's current values.
       * @returns the provider select element.
       */
      const providerSelect = (index, endpoint) => h('select', {
        className: 'bls-input',
        'data-field': `endpoints.${index}.provider`,
        value: typeof endpoint.provider === 'string' && endpoint.provider.length > 0
          ? endpoint.provider
          : providerChoices(endpoint.provider)[0][0],
        onChange: (event) => setEndpointProvider(index, event.target.value),
      }, providerChoices(endpoint.provider)
        .map(([optionValue, optionLabel]) => h('option', { key: optionValue, value: optionValue }, optionLabel)));

      /**
       * The provider one endpoint row should be read as.
       *
       * Reads the same array the row renders from — never a separate per-path
       * draft, which would fall back to the saved provider and make the model
       * list keep showing the previous provider's models until a save.
       * @param index - the endpoint row.
       * @param endpoint - the row's current values.
       * @returns the row's provider, or the saved value when the draft row is empty.
       */
      const effectiveProvider = (index, endpoint) => {
        const current = endpoints[index];
        const provider = current?.provider;
        return typeof provider === 'string' && provider.length > 0 ? provider : endpoint.provider;
      };

      /** Model choices: `auto` plus that provider's advertised models. */
      const modelChoices = (providerId, current) => {
        const choices = [[AUTO_MODEL, t('autoModel')]];
        for (const model of modelsByProvider.get(providerId) ?? []) choices.push([model.id, `${model.name} — ${model.id}`]);
        if (typeof current === 'string' && current.length > 0 && current !== AUTO_MODEL
          && !(modelsByProvider.get(providerId) ?? []).some((model) => model.id === current)) {
          choices.push([current, `${current} ${t('keepUnavailable')}`]);
        }
        return choices;
      };

      const writable = state.writable === true;
      const loading = state.value === undefined && state.revision === undefined;
      const catalogStatus = directory.status;

      /** Whitelist rows: every provider the Host serves, plus stored ones it no longer lists. */
      const whitelistRows = [
        ...providers.map((provider) => ({ provider: provider.id, name: provider.name, missing: false })),
        ...triggers
          .filter((trigger) => typeof trigger?.provider === 'string'
            && !providers.some((provider) => provider.id === trigger.provider))
          .map((trigger) => ({ provider: trigger.provider, name: trigger.provider, missing: true })),
      ];

      return h('div', { className: 'bls-root' }, [
        h('style', { key: 'style' }, CSS),
        h('p', { className: 'bls-note', key: 'intro' }, t('intro')),
        loading ? h('p', { className: 'bls-note', key: 'loading' }, t('loading')) : null,
        writable ? null : h('p', { className: 'bls-error', key: 'readonly' }, t('notWritable')),

        h('div', { className: 'bls-card', key: 'routing' }, [
          h('h4', { className: 'bls-cardTitle', key: 'title' }, t('routing')),
          h('p', { className: 'bls-note', key: 'routingHint' }, t('routingHint')),
          h(Row, { key: 'enabled', label: t('enabled'), hint: t('enabledHint') }, toggle(['enabled'], { disabled: !writable })),
          h(Row, { key: 'applyTo', label: t('applyTo'), hint: t('applyToHint') }, select(['applyTo'], [
            ['children', t('applyToChildren')],
            ['all', t('applyToAll')],
          ])),
          h(Row, { key: 'strategy', label: t('strategy'), hint: t('strategyHint') }, select(['strategy'], [
            ['least-busy', t('strategyLeastBusy')],
            ['fixed', t('strategyFixed')],
          ])),
        ]),

        h('div', { className: 'bls-card', key: 'whitelist' }, [
          h('h4', { className: 'bls-cardTitle', key: 'title' }, t('whitelist')),
          h('p', { className: 'bls-note', key: 'hint' }, t('whitelistHint')),
          catalogStatus === 'ready' && providers.length === 0
            ? h('p', { className: 'bls-note bls-empty', key: 'empty' }, t('whitelistEmpty'))
            : null,
          ...whitelistRows.map((row) => {
            const entry = triggerFor(row.provider);
            const marked = entry !== undefined;
            return h('div', { className: 'bls-row', key: `trigger-${row.provider}` }, [
              h('div', { className: 'bls-rowText', key: 'text' }, [
                h('span', { className: 'bls-label', key: 'label' }, `${row.name} (${row.provider})${row.missing ? ` ${t('whitelistMissing')}` : ''}`),
                marked ? h('span', { className: 'bls-hint', key: 'hint' }, t('taskLimitHint')) : null,
              ]),
              h('div', { className: 'bls-actions', key: 'control' }, [
                // The cap only means something while the provider is in the
                // whitelist, so it stays disabled until the switch is on.
                h('input', {
                  key: 'limit',
                  type: 'number',
                  min: 1,
                  title: t('taskLimit'),
                  className: 'bls-input bls-inputSmall bls-number',
                  'data-field': `triggers.${row.provider}.concurrency`,
                  disabled: !marked || !writable,
                  value: entry?.concurrency ?? 1,
                  onChange: (event) => setTrigger(row.provider, {
                    concurrency: event.target.value === '' ? 1 : Number(event.target.value),
                  }),
                }),
                h(Switch, {
                  key: 'marked',
                  field: `triggers.${row.provider}.marked`,
                  checked: marked,
                  disabled: !writable,
                  onChange: (next) => setTrigger(row.provider, next ? {} : null),
                }),
              ]),
            ]);
          }),
        ]),

        h('div', { className: 'bls-card', key: 'endpoints' }, [
          h('h4', { className: 'bls-cardTitle', key: 'title' }, t('subagentPool')),
          h('p', { className: 'bls-note', key: 'hint' }, t('subagentPoolHint')),
          catalogStatus === 'loading' ? h('p', { className: 'bls-note', key: 'cat-loading' }, t('loadingCatalog')) : null,
          catalogStatus === 'error'
            ? h('p', { className: 'bls-error', key: 'cat-error' }, [
              t('catalogFailed'),
              ' ',
              h('button', {
                key: 'retry',
                type: 'button',
                className: 'bls-link',
                onClick: () => {
                  void catalog.load();
                },
              }, t('retry')),
            ])
            : null,
          directory.failures.length > 0 ? h('p', { className: 'bls-note', key: 'cat-partial' }, t('catalogPartial')) : null,
          catalogStatus === 'ready' && providers.length === 0
            ? h('p', { className: 'bls-note bls-empty', key: 'cat-empty' }, t('noProviders'))
            : null,
          endpoints.length === 0 ? h('p', { className: 'bls-note bls-empty', key: 'empty' }, t('emptyEndpoints')) : null,
          ...endpoints.map((endpoint, index) => h('div', { className: 'bls-endpoint', key: `endpoint-${index}` }, [
            h('div', { className: 'bls-endpointHead', key: 'head' }, [
              h('span', { className: 'bls-endpointId', key: 'id' }, endpoint.label ?? endpoint.id ?? `#${index + 1}`),
              h('button', {
                key: 'remove',
                type: 'button',
                className: 'bls-button bls-danger',
                disabled: !writable,
                onClick: () => writeEndpoints(endpoints.filter((_entry, position) => position !== index)),
              }, t('removeEndpoint')),
            ]),
            h(Row, { key: 'label', label: t('label'), hint: t('labelHint') }, h('input', {
              type: 'text',
              className: 'bls-input',
              'data-field': `endpoints.${index}.label`,
              value: endpoint.label ?? '',
              placeholder: endpoint.id ?? '',
              onChange: (event) => patchEndpoint(index, { label: event.target.value }),
            })),
            h(Row, { key: 'provider', label: t('provider') }, providerSelect(index, endpoint)),
            h(Row, { key: 'model', label: t('model') }, modelSelect(index, endpoint)),
            h(Row, {
              key: 'concurrency',
              label: t('concurrency'),
              hint: t('concurrencyHint'),
            }, h('input', {
              type: 'number',
              min: 1,
              className: 'bls-input bls-inputSmall bls-number',
              'data-field': `endpoints.${index}.concurrency`,
              value: endpoint.concurrency ?? 1,
              onChange: (event) => patchEndpoint(index, {
                concurrency: event.target.value === '' ? undefined : Number(event.target.value),
              }),
            })),
            h(Row, { key: 'enabled', label: t('endpointEnabled') }, h(Switch, {
              field: `endpoints.${index}.enabled`,
              checked: endpoint.enabled !== false,
              disabled: !writable,
              onChange: (next) => patchEndpoint(index, { enabled: next }),
            })),
          ])),
          h('div', { className: 'bls-actions', key: 'add' }, [
            h('button', {
              key: 'add',
              type: 'button',
              className: 'bls-button bls-ghost',
              disabled: !writable || providers.length === 0,
              onClick: () => {
                const provider = providers[0]?.id ?? '';
                writeEndpoints([
                  ...endpoints,
                  {
                    id: nextEndpointId(endpoints, provider),
                    provider,
                    model: AUTO_MODEL,
                    concurrency: 1,
                    enabled: true,
                  },
                ]);
              },
            }, t('addEndpoint')),
          ]),
        ]),

        h('div', { className: 'bls-card', key: 'failures' }, [
          h('h4', { className: 'bls-cardTitle', key: 'title' }, t('failures')),
          h(Row, {
            key: 'threshold',
            label: t('failureThreshold'),
            hint: t('failureThresholdHint'),
          }, number(['health', 'failureThreshold'], 1)),
          h(Row, {
            key: 'cooldown',
            label: t('cooldownMs'),
            hint: t('cooldownMsHint'),
          }, number(['health', 'cooldownMs'], 0)),
        ]),

        h('div', { className: 'bls-card', key: 'admission' }, [
          h('h4', { className: 'bls-cardTitle', key: 'title' }, t('admission')),
          h(Row, { key: 'maxWaiting', label: t('maxWaiting') }, number(['queue', 'maxWaiting'], 0)),
          h(Row, {
            key: 'timeout',
            label: t('timeoutMs'),
            hint: t('timeoutMsHint'),
          }, number(['queue', 'timeoutMs'], 1)),
          h(Row, { key: 'tool', label: t('toolEnabled'), hint: t('toolHint') }, toggle(['tool', 'enabled'], { disabled: !writable })),
        ]),

        h('div', { className: 'bls-actions', key: 'actions' }, [
          h('button', {
            key: 'save',
            type: 'button',
            className: 'bls-button',
            disabled: busy || dirtyKeys.length === 0 || !writable || numberIssue,
            onClick: save,
          }, busy ? t('saving') : t('save')),
          dirtyKeys.length === 0 ? null : h('button', {
            key: 'discard',
            type: 'button',
            className: 'bls-button bls-ghost',
            disabled: busy,
            onClick: () => {
              setDraft({});
              setSaved(false);
              setError(null);
            },
          }, t('discard')),
          numberIssue ? h('span', { key: 'invalid', className: 'bls-error' }, t('invalidNumber')) : null,
          error === null ? null : h('span', { key: 'error', className: 'bls-error' }, error),
          saved ? h('span', { key: 'saved', className: 'bls-ok' }, t('saved')) : null,
        ]),
        h('p', { className: 'bls-note', key: 'stateHint' }, t('stateHint')),
      ]);
    }

    /** Slot entry: the bundle page renders the form; other views get a one-liner. */
    function LocalPoolPage(props) {
      if (props.view === 'summary') return h('span', null, props.t('summary'));
      if (props.controller === undefined || props.controller === null) return h('p', { className: 'bls-note' }, props.t('noForm'));
      return h(Editor, props);
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.session', 'configForms'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'local-compute-pool: dictionaries');
        const catalog = createCatalog(ctx);
        // The page edits the namespace this bundle's own row owns, so it is
        // registered through whileServed: no host Config, no page.
        ctx.effect(() => ctx.configForms.whileServed([ENTRY_ID], () => {
          const controller = ctx.configForms.get(ENTRY_ID);
          const dispose = ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
            name: 'plugins.bundle.config',
            key: BUNDLE_KEY,
          }, (props) => h(LocalPoolPage, { ...props, t, controller, catalog })));
          return () => {
            dispose();
          };
        }), 'local-compute-pool: settings page');
      },
    };
  },
});
