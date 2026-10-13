/**
 * 本地算力池 (Local compute pool) — a DSH host plugin that spreads
 * delegated subagent work across several local model endpoints.
 *
 * Two extension points, both documented harness waterfalls:
 *
 * - `agent/request` picks the endpoint for an agent's next model call. Children
 *   are routed onto the configured local endpoints (one machine per agent,
 *   sticky, with failover), so `subagent` and `workflow` delegations light up
 *   both machines instead of inheriting the parent's cloud route.
 * - `llm/stream` wraps every call routed to a pooled endpoint in that endpoint's
 *   admission queue, so a one-slot local server is never asked to serve two
 *   conversations at once.
 *
 * The declared `Config` makes this entry a settings namespace, so the Plugins
 * page can edit every field live; `loader/volatile-update` then rebuilds the
 * pool from the new values without remounting the plugin.
 *
 * @module dsh-local-compute-pool
 */
import { AUTO_MODEL, normalizeConfig } from './lib/config.js';
import { LocalPool } from './lib/pool.js';
import {
  failureCodeOf,
  isRoutingTarget,
  isSubagentChild,
  outcomeOf,
  rewriteCallConfig,
  sameRoute,
  sessionKeyOf,
} from './lib/agent.js';
import { buildConfigSchema } from './lib/schema.js';
import { loadSchemastery } from './lib/schemastery.js';
import { buildPoolTool } from './lib/tool.js';

/** Plugin identity shown by the loader and the plugin manager. */
export const name = 'local-compute-pool';

/** The pool needs the live llm catalog to validate routes and resolve `auto`. */
export const inject = ['llm'];

/**
 * The volatile configuration schema, when this deployment can reach the
 * harness-shipped schemastery. Without it the plugin still runs — it simply
 * offers no settings form and keeps its own validation.
 */
const schemastery = await loadSchemastery();
export const Config = schemastery === undefined ? undefined : buildConfigSchema(schemastery);

const PREFIX = 'local-compute-pool:';

/** @returns the current value of a possibly-volatile Loader config field. */
function unwrap(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
}

/**
 * Read one plain snapshot out of a (possibly reactive) Loader config.
 * @param config - the row's `config`.
 * @returns plain values for every declared field.
 */
function snapshotConfig(config) {
  const source = config ?? {};
  return {
    enabled: unwrap(source.enabled),
    applyTo: unwrap(source.applyTo),
    strategy: unwrap(source.strategy),
    respectExplicitRoute: unwrap(source.respectExplicitRoute),
    requireRegisteredRoute: unwrap(source.requireRegisteredRoute),
    triggers: unwrap(source.triggers),
    endpoints: unwrap(source.endpoints),
    queue: unwrap(source.queue),
    health: unwrap(source.health),
    tool: unwrap(source.tool),
    logging: unwrap(source.logging),
  };
}

/** @returns a readable one-line description of an error. */
function describeError(error) {
  return error?.message ?? String(error);
}

/**
 * Mount the pool.
 * @param ctx - the plugin's context (injects `llm`).
 * @param rawConfig - the bundle row's `config`, validated here.
 */
export function apply(ctx, rawConfig) {
  let current = normalizeConfig(snapshotConfig(rawConfig));
  let pool = createPool(current);

  const info = (message, ...args) => ctx.logger?.info(`${PREFIX} ${message}`, ...args);
  const warn = (message, ...args) => ctx.logger?.warn(`${PREFIX} ${message}`, ...args);
  const debug = (message, ...args) => {
    if (current.logging.verbose) ctx.logger?.debug?.(`${PREFIX} ${message}`, ...args);
  };

  /** @returns a fresh pool over one normalized configuration. */
  function createPool(config) {
    return new LocalPool(config.endpoints, {
      strategy: config.strategy,
      // Stickiness is a property of the pool, not a preference: one subagent
      // stays on the machine it was placed on, so its prompt prefix keeps
      // hitting the same cache and its tool-call dialect stays stable. Turning
      // it off would re-route the same subagent on every request.
      sticky: true,
      queue: config.queue,
      health: config.health,
    });
  }

  let disposed = false;
  ctx.effect(() => () => {
    disposed = true;
  });

  // ---------------------------------------------------------------------------
  // Live catalog: drop endpoints whose route cannot work, resolve `model: auto`.
  // ---------------------------------------------------------------------------
  let lastSummary;
  let refreshPromise = null;

  const refreshNow = async () => {
    const llm = ctx.get('llm');
    if (llm === undefined) return;
    let providerIds;
    try {
      providerIds = new Set(llm.listProviders().map((entry) => entry.id ?? entry.provider));
    } catch (error) {
      warn('cannot read the llm provider catalog: %s', describeError(error));
      return;
    }
    pool.resetAvailability();
    for (const endpoint of current.endpoints) {
      if (!endpoint.enabled) continue;
      if (!providerIds.has(endpoint.provider)) {
        pool.setUnavailable(endpoint.id, `provider "${endpoint.provider}" is not registered; check the llm-pi-ai providers config`);
        continue;
      }
      let models;
      try {
        models = await llm.listModels(endpoint.provider);
      } catch (error) {
        const detail = `model lookup failed: ${describeError(error)}`;
        if (current.requireRegisteredRoute) pool.setUnavailable(endpoint.id, detail);
        else warn('endpoint %s: %s', endpoint.id, detail);
        continue;
      }
      const ids = models
        .map((model) => model?.id)
        .filter((id) => typeof id === 'string' && id.length > 0);
      if (endpoint.model === AUTO_MODEL) {
        // `auto` means the provider's first advertised model.
        const picked = ids[0];
        if (picked === undefined) {
          pool.setUnavailable(endpoint.id, `provider "${endpoint.provider}" advertises no model`);
          continue;
        }
        pool.setResolvedModel(endpoint.id, picked);
        debug('endpoint %s resolved to model %s', endpoint.id, picked);
        continue;
      }
      if (current.requireRegisteredRoute && ids.length > 0 && !ids.includes(endpoint.model)) {
        const sample = ids.slice(0, 4).join(', ');
        pool.setUnavailable(
          endpoint.id,
          `model "${endpoint.model}" is not advertised by provider "${endpoint.provider}" (available: ${sample}${ids.length > 4 ? ', …' : ''})`,
        );
      }
    }
    const snapshot = pool.snapshot();
    const summary = snapshot.endpoints
      .map((endpoint) => `${endpoint.id}=${endpoint.state}${endpoint.model === AUTO_MODEL ? '' : ` (${endpoint.model})`}`)
      .join(', ');
    if (summary !== lastSummary) {
      lastSummary = summary;
      info('%s/%s endpoints ready [%s]', snapshot.totals.ready, snapshot.totals.endpoints, summary);
      for (const endpoint of snapshot.endpoints) {
        if (endpoint.state === 'unavailable') warn('endpoint %s unusable: %s', endpoint.id, endpoint.reason ?? 'unknown reason');
      }
    }
  };

  /** Serialize catalog refreshes; the tool awaits the same promise. */
  const refreshCatalogs = () => {
    if (disposed) return Promise.resolve();
    if (refreshPromise !== null) return refreshPromise;
    refreshPromise = refreshNow()
      .catch((error) => warn('catalog refresh failed: %s', describeError(error)))
      .finally(() => {
        refreshPromise = null;
      });
    return refreshPromise;
  };

  ctx.on('llm/adapters-updated', () => {
    void refreshCatalogs();
  }, { global: true });

  // ---------------------------------------------------------------------------
  // Live configuration: a settings write updates the volatile fields in place,
  // so rebuild the pool from the new values instead of remounting.
  // ---------------------------------------------------------------------------
  /** @returns whether the pool currently has any endpoint to route to. */
  const hasEndpoint = () => current.endpoints.some((endpoint) => endpoint.enabled);
  let warnedNoEndpoint = false;
  const warnNoEndpoint = () => {
    if (warnedNoEndpoint) return;
    warnedNoEndpoint = true;
    warn('no local endpoint configured yet: delegated children keep the route the harness resolved. Add endpoints in 插件 / Plugins → 本地算力池.');
  };

  // ---------------------------------------------------------------------------
  // Whitelist: which providers' tasks may delegate to the local pool, and how
  // many local subagents each such task may run at once.
  // ---------------------------------------------------------------------------
  /** @returns a Map of provider id → per-task parallel limit. */
  const triggerLimits = () => new Map(current.triggers.map((trigger) => [trigger.provider, trigger.concurrency]));

  /** @returns the provider a live agent's requests currently use. */
  const providerOf = (agent) => agent?.session?.requestHeader?.()?.config?.provider ?? agent?.options?.provider;

  /** @returns the agent that delegated this one, when the harness still tracks it. */
  const parentAgentOf = (agent) => {
    const parentId = agent?.session?.header?.parentSession;
    if (parentId === undefined) return undefined;
    return ctx.get('agents')?.get(parentId);
  };

  /**
   * @returns the parallel limit of the task this agent delegates from, or
   * undefined when the whitelist is empty or the delegating provider is off it.
   */
  const taskLimitFor = (agent) => {
    if (current.triggers.length === 0) return undefined;
    const delegator = parentAgentOf(agent) ?? agent;
    const provider = providerOf(delegator);
    return provider === undefined ? undefined : triggerLimits().get(provider);
  };

  /** @returns one endpoint's prompt fragment. */
  const describeEndpointForPrompt = (endpoint) => `${endpoint.provider} / ${endpoint.model === AUTO_MODEL ? 'auto' : endpoint.model}（并发 ${endpoint.concurrency}）`;

  /**
   * The dynamic section text: it re-reads the live configuration on every
   * assembly, so a settings write changes the budget the model is told about.
   * @param agent - the delegating agent this section belongs to.
   * @returns the prompt text, or an empty string when this task is not whitelisted.
   */
  const budgetText = (agent) => {
    const delegator = parentAgentOf(agent) ?? agent;
    const provider = providerOf(delegator);
    if (provider === undefined) return '';
    if (current.triggers.length === 0) {
      return '[local-compute-pool] 本地并行已安装但白名单为空：暂不接管子代理。请在 插件 / Plugins → 本地算力池 里勾选要启用本地并行的 provider。';
    }
    const limit = triggerLimits().get(provider);
    if (limit === undefined) return '';
    const available = current.endpoints.filter((endpoint) => endpoint.enabled);
    // The task's own machine is the endpoint serving its provider, whether that
    // row pinned an exact model or is still on `auto`.
    const own = pool.endpointForRoute(provider);
    const lines = [
      `[local-compute-pool] 本地并行已启用：本任务模型 provider \`${provider}\` 在白名单内。`,
      `- 子代理分配上限：本任务最多同时运行 ${limit} 个本地子代理；超出会排队等待，不会失败。`,
      available.length === 0
        ? '- 可用本地端点：暂无（请先在插件设置里添加）。'
        : `- 可用本地端点（每端点并发）：${available.map(describeEndpointForPrompt).join('；')}。`,
    ];
    if (own !== undefined) {
      // The task's own model is served by a pooled machine: that machine is
      // running this task, so it is kept for the task and the children land
      // elsewhere (or wait for this machine when it is the only one).
      lines.push(`- 本任务自己正跑在端点 \`${own.id}\` 上：该机器留给本任务，子代理会分配到其它端点；`
        + '若没有其它端点，子代理会与你的请求在同一台机器上排队串行，请据此控制并行宽度。');
    }
    lines.push(`- 请把独立工作拆成不超过 ${limit} 个并行子代理；需要更多时，等其中一个结束后再派下一个，不要一次性都堆到同一台机器上。`);
    return lines.join('\n');
  };

  /** @returns the prompt order for this section (just after the subagent tool's). */
  const sectionOrder = () => {
    const systemPrompt = ctx.get('systemPrompt');
    try {
      return systemPrompt === undefined ? 2810 : systemPrompt.getSectionOrder('TOOL_SUBAGENT') + 10;
    } catch {
      return 2810;
    }
  };

  /** agent → disposer of its scoped budget section. */
  const sectionDisposers = new Map();
  /** Agents seen through `agent/created`, so a later config change can add sections. */
  const knownAgents = new Set();

  /**
   * Keep one agent's scoped prompt section in sync with its provider and the
   * live whitelist: registered while the task is whitelisted, removed otherwise.
   * @param agent - the agent whose prompt may carry the budget note.
   */
  const refreshSection = (agent) => {
    if (agent === undefined || agent === null) return;
    const limit = taskLimitFor(agent);
    const existing = sectionDisposers.get(agent);
    if (limit === undefined) {
      if (existing !== undefined) {
        sectionDisposers.delete(agent);
        existing();
      }
      return;
    }
    if (existing !== undefined) return;
    const systemPrompt = agent.ctx?.get?.('systemPrompt') ?? ctx.get('systemPrompt');
    if (systemPrompt === undefined) return;
    const dispose = systemPrompt.section({
      name: 'local-compute-pool:task-budget',
      order: sectionOrder(),
      text: () => budgetText(agent),
    });
    sectionDisposers.set(agent, dispose);
  };

  /** Re-evaluate every section we own (after a settings write). */
  const refreshSections = () => {
    for (const agent of knownAgents) refreshSection(agent);
    for (const agent of [...sectionDisposers.keys()]) refreshSection(agent);
  };

  const rebuild = () => {
    let next;
    try {
      next = normalizeConfig(snapshotConfig(rawConfig));
    } catch (error) {
      warn('configuration rejected, keeping the previous values: %s', describeError(error));
      return;
    }
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    current = next;
    pool = createPool(current);
    if (current.enabled && !hasEndpoint()) warnNoEndpoint();
    info(
      'configuration changed: enabled=%s, %d trigger(s), %d endpoint(s), applyTo=%s, strategy=%s',
      current.enabled,
      current.triggers.length,
      current.endpoints.length,
      current.applyTo,
      current.strategy,
    );
    refreshSections();
    void refreshCatalogs();
  };
  ctx.on('loader/volatile-update', rebuild);

  // ---------------------------------------------------------------------------
  // Route selection: one endpoint per agent, sticky, with failover.
  // ---------------------------------------------------------------------------
  const routeAgentRequest = async (payload, next) => {
    const resolved = await next();
    if (!current.enabled) return resolved;
    const agent = payload?.agent;
    if (!isRoutingTarget(agent, current.applyTo)) return resolved;

    // The whitelist decides whether this task delegates locally at all: with a
    // non-empty list, only tasks whose own route is on it are taken over, and
    // each such task also carries its own subagent budget.
    const delegator = parentAgentOf(agent) ?? agent;
    const delegatorKey = sessionKeyOf(delegator);
    const delegatorProvider = providerOf(delegator);
    let limit;
    if (current.triggers.length > 0) {
      limit = delegatorProvider === undefined ? undefined : triggerLimits().get(delegatorProvider);
      if (limit === undefined) {
        debug('task %s runs on %s, which is not whitelisted; children keep their route', delegatorKey, delegatorProvider ?? '?');
        return resolved;
      }
      pool.setBudget(delegatorKey, limit);
      refreshSection(delegator);
    }
    // Record the delegation once, for two later questions: which task budget this
    // child's calls are charged to, and what the task itself runs on (so a child
    // calling the task's own route does not take a second slot on its machine).
    if (isSubagentChild(agent)) {
      const own = pool.endpointForRoute(delegatorProvider);
      pool.bindDelegation(sessionKeyOf(agent), {
        taskKey: delegatorKey,
        taskRoute: { provider: own?.provider, model: own?.model },
        label: delegatorProvider,
      });
    }

    // `agent/request` can run more than once for one request (this plugin's
    // safety-net listener plus the agent's own scoped listener), so recognize
    // our own previous decision first: an agent that already sits on a usable
    // assigned endpoint is placed, and re-routing it would move it.
    const assigned = pool.assignmentFor(sessionKeyOf(agent));
    if (assigned !== undefined && sameRoute(resolved, assigned)) return resolved;

    // A route that already names a healthy pooled endpoint is either the
    // operator's explicit choice or this agent's previous assignment: keep it.
    const existing = pool.endpointForRoute(resolved.provider, resolved.model);
    if (current.respectExplicitRoute && existing !== undefined && pool.isUsableEndpoint(existing)) return resolved;

    // Place the agent on a machine that has room. A task's own request holds a
    // slot on its machine for as long as it runs (`llm/stream` below), so a
    // single-slot machine stays with the task and its children go elsewhere.
    const endpoint = pool.route(sessionKeyOf(agent));
    if (endpoint === undefined) {
      debug('no usable endpoint for agent %s; keeping %s/%s', agent?.id, resolved.provider, resolved.model);
      return resolved;
    }
    if (sameRoute(resolved, endpoint)) return resolved;
    if (sameRoute(resolved, endpoint)) return resolved;
    debug(
      'agent %s -> %s (%s/%s)%s',
      agent?.id,
      endpoint.id,
      endpoint.provider,
      endpoint.model,
      limit === undefined ? '' : ` within a ${limit}-subagent task budget`,
    );
    return rewriteCallConfig(resolved, endpoint);
  };

  // Per-agent registration is the documented pattern: it is removed with the
  // agent and never leaks a listener. The root-level listener is a safety net
  // for agents that already exist (plugin installed mid-session) and for
  // children whose creation event arrives after their first request; both
  // listeners are idempotent, so a request is routed exactly once.
  const scopedDisposers = new Map();
  ctx.on('agent/created', ({ agent }) => {
    knownAgents.add(agent);
    // A task that is already whitelisted learns its subagent budget right away,
    // before it delegates anything.
    refreshSection(agent);
    if (!isRoutingTarget(agent, current.applyTo)) return;
    if (scopedDisposers.has(agent)) return;
    scopedDisposers.set(agent, agent.ctx.on('agent/request', routeAgentRequest));
  });
  ctx.on('agent/disposed', ({ agent }) => {
    knownAgents.delete(agent);
    const dispose = scopedDisposers.get(agent);
    if (dispose !== undefined) {
      scopedDisposers.delete(agent);
      dispose();
    }
    const sectionDispose = sectionDisposers.get(agent);
    if (sectionDispose !== undefined) {
      sectionDisposers.delete(agent);
      sectionDispose();
    }
    pool.forget(sessionKeyOf(agent));
    pool.forgetDelegation(sessionKeyOf(agent));
  });
  ctx.on('agent/request', routeAgentRequest);
  ctx.effect(() => () => {
    for (const dispose of scopedDisposers.values()) dispose();
    scopedDisposers.clear();
  });

  // ---------------------------------------------------------------------------
  // Admission control: at most `concurrency` streams per endpoint.
  // ---------------------------------------------------------------------------
  ctx.on('llm/stream', (options, next) => {
    if (!current.enabled) return next();
    const endpoint = pool.endpointForRoute(options?.provider, options?.model);
    if (endpoint === undefined) return next();
    // One machine, one `concurrency`: a task's own request holds a slot exactly
    // like a child's does. Without this the pool would route a child onto a
    // single-slot machine that the task itself is already using.
    const ownTaskCall = pool.isOwnTaskRoute(options?.sessionId, options?.provider, options?.model);
    const releaseHold = ownTaskCall ? undefined : pool.hold(options?.provider, options?.model);
    const source = next();
    return (async function* gated() {
      let release;
      try {
        // A child call also consumes one slot of its delegating task's budget,
        // so the whitelist's number is a real cap, not just advice.
        const budgetKey = pool.parentOfChild(options?.sessionId);
        release = await pool.acquire(endpoint, { signal: options?.signal, budgetKey });
      } catch (error) {
        // Admission failures become the stream's terminal chunk, so the agent
        // step keeps its normal model-failure path instead of a thrown
        // middleware error. A cancelled wait is an abort, not an endpoint fault.
        const aborted = error?.code === 'ABORTED' || options?.signal?.aborted === true;
        releaseHold?.();
        yield {
          type: 'finish',
          reason: {
            kind: aborted ? 'aborted' : 'error',
            failure: { code: error?.code ?? 'POOL_ADMISSION_FAILED', message: describeError(error) },
          },
        };
        return;
      }
      try {
        for await (const chunk of source) {
          const outcome = outcomeOf(chunk);
          if (outcome === 'failed') pool.noteFailure(endpoint, failureCodeOf(chunk));
          else if (outcome === 'ok') pool.noteSuccess(endpoint);
          yield chunk;
        }
      } catch (error) {
        pool.noteFailure(endpoint, error?.code);
        throw error;
      } finally {
        release();
        releaseHold?.();
      }
    })();
  }, { global: true });

  // ---------------------------------------------------------------------------
  // Optional model-facing status tool.
  // ---------------------------------------------------------------------------
  if (current.tool.enabled) {
    const toolName = current.tool.name;
    ctx.inject(['tools'], (toolCtx) => {
      toolCtx.tools.register(buildPoolTool({
        name: toolName,
        getPool: () => pool,
        getEndpoints: () => current.endpoints,
        getBudgets: () => pool.budgetSnapshot(),
        refresh: refreshCatalogs,
      }));
    });
  }

  info(
    'armed: %d endpoint(s), applyTo=%s, strategy=%s, settings=%s',
    current.endpoints.length,
    current.applyTo,
    current.strategy,
    Config === undefined ? 'unavailable (no schemastery)' : 'available',
  );
  if (current.enabled && !hasEndpoint()) warnNoEndpoint();
  void refreshCatalogs();
}
