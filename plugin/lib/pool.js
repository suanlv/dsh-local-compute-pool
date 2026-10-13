/**
 * The endpoint pool: route selection, per-endpoint admission control, and
 * passive health tracking for a set of local model endpoints.
 *
 * Pure logic — no harness imports, no I/O, no timers except the queue's own
 * timeout, so it is fully unit-testable. The plugin wires it to the harness.
 *
 * Why a queue at all: a locally served model (llama.cpp / LM Studio / vLLM with
 * one slot) answers one conversation at a time. DSH has no request-level
 * concurrency control for model calls, so two parallel subagents pointed at the
 * same machine degrade into swap thrash or a hard error. This pool keeps at most
 * `concurrency` requests in flight per endpoint and makes the rest wait.
 * @module dsh-local-compute-pool/pool
 */

/** Failure of the admission queue itself (never an endpoint failure). */
export class PoolQueueError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PoolQueueError';
    this.code = code;
  }
}

/** @returns a stable key for one exact provider/model route. */
function routeKey(provider, model) {
  return `${provider}\u0000${model}`;
}

/**
 * One pool over a fixed endpoint list.
 *
 * Endpoint records are private to the pool; callers read detached snapshots.
 */
export class LocalPool {
  #endpoints;
  #byId = new Map();
  #byRoute = new Map();
  #byProvider = new Map();
  #strategy;
  #sticky;
  #queueConfig;
  #health;
  #now;
  #assignments = new Map();
  #delegations = new Map();
  #budgets = new Map();
  #cursor = 0;

  /**
   * @param endpoints - normalized endpoints from {@link normalizeConfig}.
   * @param options - strategy, stickiness, queue and health policy, clock.
   */
  constructor(endpoints, { strategy, sticky, queue, health, now = () => Date.now() }) {
    this.#strategy = strategy;
    this.#sticky = sticky;
    this.#queueConfig = queue;
    this.#health = health;
    this.#now = now;
    this.#endpoints = endpoints.map((endpoint) => ({
      id: endpoint.id,
      label: endpoint.label,
      provider: endpoint.provider,
      model: endpoint.model,
      modelSource: endpoint.model === 'auto' ? 'pending' : 'config',
      concurrency: endpoint.concurrency,
      enabled: endpoint.enabled,
      ...(endpoint.maxTokens === undefined ? {} : { maxTokens: endpoint.maxTokens }),
      ...(endpoint.reasoningEffort === undefined ? {} : { reasoningEffort: endpoint.reasoningEffort }),
      ...(endpoint.temperature === undefined ? {} : { temperature: endpoint.temperature }),
      ...(endpoint.baseURL === undefined ? {} : { baseURL: endpoint.baseURL }),
      ...(endpoint.apiKeyEnv === undefined ? {} : { apiKeyEnv: endpoint.apiKeyEnv }),
      available: true,
      unavailableReason: undefined,
      active: 0,
      reserved: 0,
      waiting: 0,
      served: 0,
      failures: 0,
      cooldownUntil: 0,
      lastError: undefined,
      lastStartedAt: undefined,
      queue: [],
    }));
    for (const endpoint of this.#endpoints) {
      this.#byId.set(endpoint.id, endpoint);
      if (!this.#byProvider.has(endpoint.provider)) this.#byProvider.set(endpoint.provider, []);
      this.#byProvider.get(endpoint.provider).push(endpoint);
      if (endpoint.model !== 'auto') this.#byRoute.set(routeKey(endpoint.provider, endpoint.model), endpoint);
    }
  }

  /** @returns every endpoint id in configuration order. */
  get ids() {
    return this.#endpoints.map((endpoint) => endpoint.id);
  }

  /** @returns the endpoint record for one id, or undefined. */
  endpointById(id) {
    return this.#byId.get(id);
  }

  /**
   * Find the endpoint a stream belongs to; used by the admission gate.
   * An exact provider+model match wins, then a unique provider match.
   * @param provider - the request's provider route.
   * @param model - the request's model id.
   * @returns the matching endpoint, or undefined when this route is not pooled.
   */
  endpointForRoute(provider, model) {
    const exact = this.#byRoute.get(routeKey(provider, model));
    if (exact !== undefined) return exact;
    const candidates = this.#byProvider.get(provider);
    if (candidates === undefined) return undefined;
    if (candidates.length === 1) return candidates[0];
    // Several endpoints share one provider and the model is unresolved: gate the
    // least loaded one so the request still cannot exceed that machine's slot.
    return candidates.reduce((best, candidate) => (candidate.active < best.active ? candidate : best));
  }

  /**
   * Publish the model a `model: auto` endpoint resolved to.
   * @param id - endpoint id.
   * @param model - the resolved exact model id.
   */
  setResolvedModel(id, model) {
    const endpoint = this.#byId.get(id);
    if (endpoint === undefined || endpoint.model === model) return;
    if (endpoint.model !== 'auto') this.#byRoute.delete(routeKey(endpoint.provider, endpoint.model));
    endpoint.model = model;
    endpoint.modelSource = 'auto';
    this.#byRoute.set(routeKey(endpoint.provider, model), endpoint);
    this.#clearStickyFor(id);
  }

  /**
   * Clear every derived availability verdict, so a catalog refresh starts from
   * a clean slate. Cooldowns and failure counters are deliberately untouched.
   */
  resetAvailability() {
    for (const endpoint of this.#endpoints) {
      endpoint.available = true;
      endpoint.unavailableReason = undefined;
    }
  }

  /**
   * Mark an endpoint unusable (unknown provider/model, failed discovery).
   * @param id - endpoint id.
   * @param reason - operator-facing explanation.
   */
  setUnavailable(id, reason) {
    const endpoint = this.#byId.get(id);
    if (endpoint === undefined) return;
    endpoint.available = false;
    endpoint.unavailableReason = reason;
    this.#clearStickyFor(id);
  }

  /**
   * @returns whether one endpoint may receive new work right now, which needs a
   * free slot: `reserved` counts the delegating task's own requests to it.
   */
  #usable(endpoint, now) {
    return this.#inService(endpoint, now) && endpoint.active + endpoint.reserved < endpoint.concurrency;
  }

  /**
   * @returns whether one endpoint is in service at all — enabled, reachable and
   * not cooling down — regardless of how full it is. Stickiness uses this: a
   * session that is already placed must not be moved just because its machine
   * is busy, or its own queue would be split across machines.
   */
  #inService(endpoint, now) {
    return endpoint.enabled
      && endpoint.available
      && endpoint.model !== 'auto'
      && endpoint.cooldownUntil <= now;
  }

  /** @returns the currently usable endpoints. */
  usableEndpoints() {
    const now = this.#now();
    return this.#endpoints.filter((endpoint) => this.#usable(endpoint, now));
  }

  /**
   * Usability check for one endpoint record this pool handed out.
   * @param endpoint - an endpoint record, or undefined.
   * @returns whether it may receive new work right now.
   */
  isUsableEndpoint(endpoint) {
    return endpoint !== undefined && endpoint !== null && this.#usable(endpoint, this.#now());
  }

  /** @returns the endpoint serving one session, when still usable. */
  #assigned(sessionKey) {
    if (!this.#sticky || sessionKey === undefined) return undefined;
    const id = this.#assignments.get(sessionKey);
    if (id === undefined) return undefined;
    const endpoint = this.#byId.get(id);
    if (endpoint === undefined || !this.#inService(endpoint, this.#now())) return undefined;
    return endpoint;
  }

  /**
   * The endpoint this session is currently pinned to, usable or not.
   *
   * `agent/request` can run more than once for one request — a per-agent
   * listener plus the plugin's safety-net listener — so the router must
   * recognize its own previous decision. A usable assignment is that decision;
   * re-routing it would move an agent that is already placed.
   * @param sessionKey - stable per-agent key.
   * @returns the assigned endpoint, when one exists and is usable.
   */
  assignmentFor(sessionKey) {
    return this.#assigned(sessionKey);
  }

  /**
   * Hold one slot on an endpoint for a delegating task's own request.
   *
   * A task whose model is served by a pool endpoint competes for exactly the
   * same slot as the subagents it delegates — the operator configured one
   * `concurrency` for that machine. Reserving the slot for the request's
   * lifetime makes routing treat the machine as full, so a single-slot machine
   * stays with the task that is already on it instead of also being handed a
   * child. The returned release is idempotent and must run in a `finally`.
   * @param provider - the request's provider.
   * @param model - the request's model id.
   * @returns a release function, or undefined when this route is not pooled.
   */
  hold(provider, model) {
    const endpoint = this.endpointForRoute(provider, model);
    if (endpoint === undefined) return undefined;
    endpoint.reserved += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      endpoint.reserved = Math.max(0, endpoint.reserved - 1);
    };
  }

  /**
   * Remember which task a child session is delegating for, and what that task
   * itself runs on.
   *
   * One record answers both questions the plugin asks later: which task budget
   * this child's calls are charged to (`parentOfChild`, used by the stream gate),
   * and whether a call is the task calling its own route (`isOwnTaskRoute`, used
   * to keep a single-slot machine to the task that is already on it).
   * @param childKey - the child session key.
   * @param options - `{ taskKey, taskRoute, label }`: the delegating task's session
   *   key, its own resolved `{ provider, model }`, and a short provider label used
   *   for the budget status output.
   */
  bindDelegation(childKey, { taskKey, taskRoute, label }) {
    if (childKey === undefined || childKey === null) return;
    this.#delegations.set(childKey, { taskKey, taskRoute });
    if (this.#delegations.size > 512) {
      const oldest = this.#delegations.keys().next().value;
      this.#delegations.delete(oldest);
    }
    // The budget row is created when the task is first routed; label it once we
    // know which task this child belongs to.
    const budget = taskKey === undefined ? undefined : this.#budgets.get(taskKey);
    if (budget !== undefined && label !== undefined) budget.label = label;
  }

  /** @returns the delegating task's session key for one child, or undefined. */
  parentOfChild(childKey) {
    return this.#delegations.get(childKey)?.taskKey;
  }

  /** @returns whether this call is a child calling its own delegating task's route. */
  isOwnTaskRoute(sessionKey, provider, model) {
    const route = this.#delegations.get(sessionKey)?.taskRoute;
    return route !== undefined && route.provider === provider && route.model === model;
  }

  /** Drop one session's delegation record (agent disposal). */
  forgetDelegation(sessionKey) {
    if (sessionKey === undefined) return;
    this.#delegations.delete(sessionKey);
  }

  #remember(sessionKey, endpoint) {
    if (!this.#sticky || sessionKey === undefined || sessionKey === null) return;
    this.#assignments.set(sessionKey, endpoint.id);
    // Bound the map: sticky entries are per session, and long-lived hosts see many.
    if (this.#assignments.size > 512) {
      const oldest = this.#assignments.keys().next().value;
      this.#assignments.delete(oldest);
    }
  }

  /** Drop one session's sticky assignment (agent disposal). */
  forget(sessionKey) {
    if (sessionKey === undefined) return;
    this.#assignments.delete(sessionKey);
  }

  #clearStickyFor(endpointId) {
    for (const [sessionKey, id] of this.#assignments) {
      if (id === endpointId) this.#assignments.delete(sessionKey);
    }
  }

  /**
   * Choose the endpoint for one session's next request.
   *
   * Only endpoints with a free slot are candidates: a machine whose slots are
   * all taken — by children, or by the delegating task's own request, which
   * holds one for as long as it runs — is skipped rather than handed a second
   * caller it cannot serve. When nothing has room the caller keeps the route the
   * harness resolved, so the work still runs and that server serializes it.
   * @param sessionKey - stable per-agent key for stickiness.
   * @returns the chosen endpoint, or undefined when nothing has room.
   */
  route(sessionKey) {
    const assigned = this.#assigned(sessionKey);
    if (assigned !== undefined) return assigned;
    const candidates = this.usableEndpoints();
    if (candidates.length === 0) return undefined;
    const chosen = this.#select(candidates);
    if (chosen === undefined) return undefined;
    this.#remember(sessionKey, chosen);
    return chosen;
  }

  /** @returns the chosen endpoint for a candidate set under the active strategy. */
  #select(candidates) {
    if (this.#strategy === 'fixed') return candidates[0];
    if (this.#strategy === 'round-robin') {
      const chosen = candidates[this.#cursor % candidates.length];
      this.#cursor = (this.#cursor + 1) % 1_000_000_007;
      return chosen;
    }
    // least-busy: normalized in-flight load, then a small queue penalty, then
    // fewest served requests, with a rotating tie-break so equal endpoints
    // alternate instead of always resolving to the first row.
    const rotation = this.#cursor++ % candidates.length;
    const ordered = [...candidates.slice(rotation), ...candidates.slice(0, rotation)];
    let best = ordered[0];
    let bestScore = Number.POSITIVE_INFINITY;
    for (const candidate of ordered) {
      const load = candidate.active / candidate.concurrency;
      const pressure = load + candidate.waiting * 0.25;
      const score = pressure * 1e6 + candidate.served;
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  }

  /**
   * Declare (or clear) the parallel budget of one delegating task.
   *
   * A budget bounds how many of that task's local subagent model calls run at
   * once — the whitelist's number, independent of how many machines serve it.
   * Raising a limit admits queued waiters immediately.
   * @param key - the delegating session key; undefined clears nothing.
   * @param limit - positive integer, or undefined to drop the budget.
   */
  setBudget(key, limit) {
    if (key === undefined || key === null) return;
    if (limit === undefined) {
      this.#budgets.delete(key);
      return;
    }
    const existing = this.#budgets.get(key);
    if (existing === undefined) {
      this.#budgets.set(key, { limit, label: undefined, active: 0, queue: [] });
      return;
    }
    existing.limit = limit;
    this.#drainBudget(existing);
  }

  /** @returns detached budget rows for status output. */
  budgetSnapshot() {
    return [...this.#budgets.entries()].map(([key, budget]) => ({
      key,
      label: budget.label ?? key,
      limit: budget.limit,
      active: budget.active,
      waiting: budget.queue.length,
    }));
  }

  /** Admit queued budget waiters while capacity remains. */
  #drainBudget(budget) {
    while (budget.queue.length > 0 && budget.active < budget.limit) {
      const waiter = budget.queue.shift();
      if (waiter.signal?.aborted) {
        this.#clearWaiter(waiter);
        waiter.reject(new PoolQueueError('local pool: request was cancelled while queued for a task slot', 'ABORTED'));
        continue;
      }
      this.#clearWaiter(waiter);
      budget.active += 1;
      waiter.resolve(this.#budgetRelease(budget));
    }
  }

  /** @returns the idempotent release for one budget slot. */
  #budgetRelease(budget) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      budget.active = Math.max(0, budget.active - 1);
      this.#drainBudget(budget);
    };
  }

  /** Wait for one slot of a delegating task's budget. */
  #acquireBudget(key, signal) {
    const budget = this.#budgets.get(key);
    if (budget === undefined) return Promise.resolve(() => {});
    if (budget.active < budget.limit) {
      budget.active += 1;
      return Promise.resolve(this.#budgetRelease(budget));
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: undefined, onAbort: undefined, signal };
      waiter.timer = setTimeout(() => {
        this.#dropBudgetWaiter(budget, waiter);
        reject(new PoolQueueError(
          `local pool: waited ${this.#queueConfig.timeoutMs}ms for a task slot (limit ${budget.limit}); raise that provider's parallel limit or wait for a running subagent to finish`,
          'QUEUE_TIMEOUT',
        ));
      }, this.#queueConfig.timeoutMs);
      waiter.timer.unref?.();
      if (signal !== undefined) {
        waiter.onAbort = () => {
          this.#dropBudgetWaiter(budget, waiter);
          reject(new PoolQueueError('local pool: request was cancelled while queued for a task slot', 'ABORTED'));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      budget.queue.push(waiter);
    });
  }

  /** Remove one budget waiter and its listeners. */
  #dropBudgetWaiter(budget, waiter) {
    const index = budget.queue.indexOf(waiter);
    if (index >= 0) budget.queue.splice(index, 1);
    this.#clearWaiter(waiter);
  }

  /** @returns the idempotent release for one admitted budget slot. */
  #clearWaiter(waiter) {
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    if (waiter.onAbort !== undefined) waiter.signal?.removeEventListener('abort', waiter.onAbort);
  }

  /**
   * Wait for a free slot on one endpoint.
   *
   * Resolves with the release function the caller must invoke exactly once when
   * its stream settles (including cancellation), so the slot can be handed to
   * the next waiter.
   * @param endpoint - the endpoint to admit into.
   * @param options - abort signal, plus the delegating task whose budget this
   *   request must also fit into.
   * @returns a promise for the release function.
   */
  async acquire(endpoint, { signal, budgetKey } = {}) {
    const releaseBudget = budgetKey === undefined ? undefined : await this.#acquireBudget(budgetKey, signal);
    try {
      return this.#acquireEndpoint(endpoint, signal, releaseBudget);
    } catch (error) {
      releaseBudget?.();
      throw error;
    }
  }

  /**
   * Wait for one endpoint slot, releasing the budget slot when admission fails.
   * @returns a promise for the combined release function.
   */
  #acquireEndpoint(endpoint, signal, releaseBudget) {
    if (signal?.aborted) {
      return Promise.reject(new PoolQueueError(`local pool: request to "${endpoint.id}" was cancelled before admission`, 'ABORTED'));
    }
    if (endpoint.active < endpoint.concurrency) {
      this.#start(endpoint);
      return Promise.resolve(this.#releaseFor(endpoint, releaseBudget));
    }
    if (endpoint.waiting >= this.#queueConfig.maxWaiting) {
      return Promise.reject(new PoolQueueError(
        `local pool: endpoint "${endpoint.id}" already has ${endpoint.waiting} queued requests (queue.maxWaiting=${this.#queueConfig.maxWaiting}); raise queue.maxWaiting, add another endpoint, or lower the fan-out`,
        'QUEUE_FULL',
      ));
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          this.#start(endpoint);
          resolve(this.#releaseFor(endpoint, releaseBudget));
        },
        reject,
        timer: undefined,
        onAbort: undefined,
        signal,
      };
      waiter.timer = setTimeout(() => {
        this.#dropWaiter(endpoint, waiter);
        reject(new PoolQueueError(
          `local pool: waited ${this.#queueConfig.timeoutMs}ms for a free slot on "${endpoint.id}" (concurrency=${endpoint.concurrency}); raise queue.timeoutMs, raise concurrency if the server supports batching, or spread work over more endpoints`,
          'QUEUE_TIMEOUT',
        ));
      }, this.#queueConfig.timeoutMs);
      waiter.timer.unref?.();
      if (signal !== undefined) {
        waiter.onAbort = () => {
          this.#dropWaiter(endpoint, waiter);
          reject(new PoolQueueError(`local pool: request to "${endpoint.id}" was cancelled while queued`, 'ABORTED'));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      endpoint.queue.push(waiter);
      endpoint.waiting = endpoint.queue.length;
    });
  }

  /** Remove one queued waiter and its listeners. */
  #dropWaiter(endpoint, waiter) {
    const index = endpoint.queue.indexOf(waiter);
    if (index >= 0) endpoint.queue.splice(index, 1);
    endpoint.waiting = endpoint.queue.length;
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    if (waiter.onAbort !== undefined) waiter.signal?.removeEventListener('abort', waiter.onAbort);
  }

  /** Count one admitted request and reset nothing else. */
  #start(endpoint) {
    endpoint.active++;
    endpoint.served++;
    endpoint.lastStartedAt = this.#now();
  }

  /** @returns the idempotent release function for one admitted request. */
  #releaseFor(endpoint, releaseBudget) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      endpoint.active = Math.max(0, endpoint.active - 1);
      const next = endpoint.queue.shift();
      if (next === undefined) {
        endpoint.waiting = 0;
        releaseBudget?.();
        return;
      }
      endpoint.waiting = endpoint.queue.length;
      if (next.timer !== undefined) clearTimeout(next.timer);
      if (next.onAbort !== undefined) next.signal?.removeEventListener('abort', next.onAbort);
      if (next.signal?.aborted) {
        // The waiter abandoned while queued; free the slot for the next one.
        next.reject(new PoolQueueError(`local pool: request to "${endpoint.id}" was cancelled while queued`, 'ABORTED'));
        this.#releaseFor(endpoint, releaseBudget)();
        return;
      }
      // This request is finished, so its task slot is free; the next one holds
      // its own task slot and releases it when it settles.
      releaseBudget?.();
      next.resolve();
    };
  }

  /** Record a completed request. */
  noteSuccess(endpoint) {
    endpoint.failures = 0;
    endpoint.lastError = undefined;
    endpoint.cooldownUntil = 0;
  }

  /**
   * Record a failed request and park the endpoint once it crosses the threshold.
   *
   * A failure also releases every sticky assignment pointing at that endpoint,
   * so a retry or a follow-up step fails over to another machine instead of
   * walking back into the same wall.
   * @param endpoint - the endpoint that failed.
   * @param code - provider-neutral failure code, when one is available.
   */
  noteFailure(endpoint, code) {
    if (code !== undefined && this.#health.ignoreCodes.includes(code)) return;
    endpoint.failures++;
    endpoint.lastError = { code: code ?? 'UNKNOWN', at: this.#now() };
    this.#clearStickyFor(endpoint.id);
    if (endpoint.failures >= this.#health.failureThreshold) {
      endpoint.cooldownUntil = this.#now() + this.#health.cooldownMs;
    }
  }

  /** @returns total in-flight requests across the pool. */
  inFlight() {
    return this.#endpoints.reduce((sum, endpoint) => sum + endpoint.active, 0);
  }

  /** @returns total queued requests across the pool. */
  queued() {
    return this.#endpoints.reduce((sum, endpoint) => sum + endpoint.waiting, 0);
  }

  /**
   * Detached status for the model-facing tool and for operator logs.
   * @returns one plain object per endpoint plus pool totals.
   */
  snapshot() {
    const now = this.#now();
    const endpoints = this.#endpoints.map((endpoint) => {
      const cooling = endpoint.cooldownUntil > now;
      const state = !endpoint.enabled
        ? 'disabled'
        : !endpoint.available
          ? 'unavailable'
          : endpoint.model === 'auto'
            ? 'resolving'
            : cooling
              ? 'parked'
              : 'ready';
      return {
        id: endpoint.id,
        label: endpoint.label,
        provider: endpoint.provider,
        model: endpoint.model,
        modelSource: endpoint.modelSource,
        state,
        ...(endpoint.unavailableReason === undefined ? {} : { reason: endpoint.unavailableReason }),
        active: endpoint.active,
        reserved: endpoint.reserved,
        waiting: endpoint.waiting,
        concurrency: endpoint.concurrency,
        served: endpoint.served,
        failures: endpoint.failures,
        cooldownRemainingMs: cooling ? endpoint.cooldownUntil - now : 0,
        ...(endpoint.lastError === undefined ? {} : { lastError: endpoint.lastError.code }),
      };
    });
    return {
      endpoints,
      totals: {
        endpoints: endpoints.length,
        ready: endpoints.filter((endpoint) => endpoint.state === 'ready').length,
        active: this.inFlight(),
        waiting: this.queued(),
      },
    };
  }
}
