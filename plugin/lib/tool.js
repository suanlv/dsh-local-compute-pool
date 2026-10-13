/**
 * The optional model-facing `local_pool` tool: a read-only window into the
 * endpoint pool, so an agent can check spare capacity before fanning out
 * subagents and can tell "idle machine" from "machine that is not running".
 * @module dsh-local-compute-pool/tool
 */

/** Bound one probe so a dead endpoint cannot hold the tool call open. */
const PROBE_TIMEOUT_MS = 4_000;

/** @returns a one-line human summary of one endpoint. */
function describeEndpoint(endpoint) {
  const load = `${endpoint.active}/${endpoint.concurrency} in flight`;
  // A reserving task's own request holds a slot without being a pooled call.
  const reserved = endpoint.reserved > 0 ? `, ${endpoint.reserved} slot(s) held by a task running on it` : '';
  const queued = endpoint.waiting > 0 ? `, ${endpoint.waiting} queued` : '';
  const served = `, ${endpoint.served} served`;
  const parked = endpoint.state === 'parked'
    ? ` — parked for ${Math.round(endpoint.cooldownRemainingMs / 1000)}s after ${endpoint.failures} failures${endpoint.lastError === undefined ? '' : ` (last: ${endpoint.lastError})`}`
    : '';
  const reason = endpoint.reason === undefined ? '' : ` — ${endpoint.reason}`;
  const probe = endpoint.probe === undefined
    ? ''
    : endpoint.probe.reachable
      ? ` — probe: reachable${endpoint.probe.status === undefined ? '' : ` (HTTP ${endpoint.probe.status})`}`
      : ` — probe: unreachable${endpoint.probe.detail === undefined ? '' : ` (${endpoint.probe.detail})`}`;
  return `- ${endpoint.id} (${endpoint.provider} / ${endpoint.model}): ${endpoint.state}, ${load}${reserved}${queued}${served}${parked}${reason}${probe}`;
}

/** @returns the rendered line for one delegating task's subagent budget. */
function describeBudget(budget) {
  const waiting = budget.waiting > 0 ? `, ${budget.waiting} queued` : '';
  return `- task ${budget.label}: ${budget.active}/${budget.limit} local subagent(s) running${waiting}`;
}

/** @returns the rendered text for one status snapshot. */
export function renderStatus(value) {
  const lines = [
    `Local inference pool: ${value.totals.ready}/${value.totals.endpoints} endpoint(s) ready, ${value.totals.active} in flight, ${value.totals.waiting} queued.`,
  ];
  for (const endpoint of value.endpoints) lines.push(describeEndpoint(endpoint));
  // Only tasks that currently hold a budget appear: an empty list means no
  // whitelisted task has been routed yet, not "no limit".
  if (Array.isArray(value.budgets) && value.budgets.length > 0) {
    lines.push('Task subagent budgets:');
    for (const budget of value.budgets) lines.push(describeBudget(budget));
  }
  return lines.join('\n');
}

/**
 * Probe one endpoint's OpenAI-compatible `/models` route.
 * @param endpoint - the endpoint snapshot carrying `baseURL`/`apiKeyEnv`, when configured.
 * @returns a detached probe result.
 */
async function probeEndpoint(endpoint) {
  if (endpoint.baseURL === undefined) return { reachable: false, detail: 'no baseURL configured for probing' };
  const url = `${String(endpoint.baseURL).replace(/\/+$/, '')}/models`;
  const headers = {};
  const token = endpoint.apiKeyEnv === undefined ? undefined : process.env[endpoint.apiKeyEnv];
  if (token !== undefined && token.length > 0) headers.Authorization = `Bearer ${token}`;
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return {
      reachable: response.ok,
      status: response.status,
      ...(response.ok ? {} : { detail: `HTTP ${response.status}` }),
    };
  } catch (error) {
    return { reachable: false, detail: error?.message ?? String(error) };
  }
}

/**
 * Build the `local_pool` tool definition.
 * @param options - tool name, accessors for the live pool and its endpoints, and a catalog refresh hook.
 * @returns a `ToolDefinition` for `ctx.tools.register`.
 */
export function buildPoolTool({ name, getPool, getEndpoints, getBudgets, refresh }) {
  return {
    name,
    description:
      'Report the local inference pool used for delegated subagents: each configured machine, how many model calls are '
      + 'in flight or queued on it, how many of its slots a task running on it holds for itself, and whether an endpoint '
      + 'was parked after repeated failures. Also reports the subagent budget of every task that currently holds one, so '
      + 'you can see how wide each delegating task is allowed to fan out and how many of those slots are in use. Call it '
      + 'before starting several subagents at once to check spare capacity, and after a delegated child failed to see '
      + 'whether the local server is the cause. Set `probe` to also test each endpoint\'s HTTP route.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        probe: {
          type: 'boolean',
          description: 'Also send a short HTTP request to each endpoint that declares a baseURL, to distinguish an idle machine from one that is not running.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['endpoints', 'totals', 'budgets'],
        properties: {
          budgets: {
            type: 'array',
            description: 'One row per delegating task that currently holds a subagent budget.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['label', 'limit', 'active', 'waiting'],
              properties: {
                label: { type: 'string' },
                limit: { type: 'integer' },
                active: { type: 'integer' },
                waiting: { type: 'integer' },
              },
            },
          },
          endpoints: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'label', 'provider', 'model', 'state', 'active', 'reserved', 'waiting', 'concurrency', 'served', 'failures', 'cooldownRemainingMs'],
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                provider: { type: 'string' },
                model: { type: 'string' },
                modelSource: { type: 'string', enum: ['config', 'auto', 'pending'] },
                state: { type: 'string', enum: ['ready', 'parked', 'unavailable', 'disabled', 'resolving'] },
                reason: { type: 'string' },
                active: { type: 'integer' },
                reserved: { type: 'integer' },
                waiting: { type: 'integer' },
                concurrency: { type: 'integer' },
                served: { type: 'integer' },
                failures: { type: 'integer' },
                cooldownRemainingMs: { type: 'integer' },
                lastError: { type: 'string' },
                probe: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['reachable'],
                  properties: {
                    reachable: { type: 'boolean' },
                    status: { type: 'integer' },
                    detail: { type: 'string' },
                  },
                },
              },
            },
          },
          totals: {
            type: 'object',
            additionalProperties: false,
            required: ['endpoints', 'ready', 'active', 'waiting'],
            properties: {
              endpoints: { type: 'integer' },
              ready: { type: 'integer' },
              active: { type: 'integer' },
              waiting: { type: 'integer' },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderStatus(value) }],
    },
    async execute(args) {
      // Re-read the live catalog first: an endpoint may have become serviceable
      // (or unusable) since the last adapter update. The accessors keep this
      // tool bound to the pool a settings change may have replaced.
      await refresh();
      const pool = getPool();
      // Budgets are read through their own accessor so this tool keeps working
      // with a pool built before the field existed.
      const budgets = typeof getBudgets === 'function' ? getBudgets() : [];
      const snapshot = { ...pool.snapshot(), budgets };
      if (args?.probe !== true) return snapshot;
      const byId = new Map(getEndpoints().map((endpoint) => [endpoint.id, endpoint]));
      const probed = await Promise.all(snapshot.endpoints.map(async (endpoint) => ({
        ...endpoint,
        probe: await probeEndpoint(byId.get(endpoint.id) ?? {}),
      })));
      return { ...snapshot, endpoints: probed };
    },
  };
}
