/**
 * Agent-side helpers: is this agent a delegated child, and how do we rewrite
 * one resolved call configuration onto a pool endpoint's route?
 * @module dsh-local-compute-pool/agent
 */

/**
 * Stable per-agent key for sticky routing.
 * @param agent - the agent whose requests are being routed.
 * @returns its session id when available, else its agent id.
 */
export function sessionKeyOf(agent) {
  return agent?.session?.id ?? agent?.id;
}

/**
 * Read an agent's delegation depth.
 *
 * Mirrors the harness rule (`dsh-subagent/depth`): the persisted session header
 * is the monotone floor and runtime options may only deepen it.
 * @param agent - the agent to inspect.
 * @returns its non-negative depth, 0 for a top-level agent.
 */
export function delegationDepth(agent) {
  const header = agent?.session?.header?.delegationDepth;
  const runtime = agent?.options?.subagentDepth;
  const headerDepth = typeof header === 'number' && Number.isSafeInteger(header) && header >= 0 ? header : 0;
  const runtimeDepth = typeof runtime === 'number' && Number.isSafeInteger(runtime) && runtime >= 0 ? runtime : 0;
  return Math.max(headerDepth, runtimeDepth);
}

/**
 * Decide whether one agent is a delegated child.
 * @param agent - the agent to inspect.
 * @returns true for a subagent child session.
 */
export function isSubagentChild(agent) {
  const header = agent?.session?.header;
  if (header?.origin === 'subagent') return true;
  if (header?.parentSession !== undefined) return true;
  return delegationDepth(agent) >= 1;
}

/**
 * Decide whether this agent's model calls belong to the pool.
 * @param agent - the agent being composed.
 * @param applyTo - `'children'` (delegated agents only) or `'all'`.
 * @returns true when the pool should pick this agent's route.
 */
export function isRoutingTarget(agent, applyTo) {
  if (agent === undefined || agent === null) return false;
  if (applyTo === 'all') return true;
  return isSubagentChild(agent);
}

/**
 * Whether one call configuration already names an endpoint's exact route.
 * @param config - resolved call configuration.
 * @param endpoint - candidate endpoint.
 * @returns true when provider and model already match.
 */
export function sameRoute(config, endpoint) {
  return config?.provider === endpoint.provider && config?.model === endpoint.model;
}

/**
 * Rewrite a resolved call configuration onto one endpoint's route.
 *
 * `LlmCallConfig` has exactly six fields, and the harness persists whatever the
 * listener returns into the session's request header, so this function never
 * adds a key that was not already there and never leaves a key undefined.
 *
 * The inherited `reasoningEffort` is always dropped: it belongs to the previous
 * route, and a new route rejects an effort it does not advertise.
 * @param config - the config an inner listener resolved.
 * @param endpoint - the endpoint to switch to.
 * @returns the replacement config (or the input, when it already matches).
 */
export function rewriteCallConfig(config, endpoint) {
  const { reasoningEffort: _inheritedEffort, ...rest } = config;
  const next = { ...rest, provider: endpoint.provider, model: endpoint.model };
  if (endpoint.reasoningEffort !== undefined) next.reasoningEffort = endpoint.reasoningEffort;
  if (endpoint.maxTokens !== undefined) next.maxTokens = endpoint.maxTokens;
  if (endpoint.temperature !== undefined) next.temperature = endpoint.temperature;
  return next;
}

/**
 * Read the provider-neutral failure code a terminal stream chunk carries.
 * @param chunk - one stream chunk.
 * @returns the failure code for an error/aborted finish chunk, else undefined.
 */
export function failureCodeOf(chunk) {
  if (chunk?.type !== 'finish') return undefined;
  const reason = chunk.reason;
  if (reason === undefined || reason === null) return undefined;
  if (reason.kind !== 'error' && reason.kind !== 'aborted') return undefined;
  return reason.failure?.code ?? (reason.kind === 'aborted' ? 'ABORTED' : 'UNKNOWN');
}

/**
 * Read the terminal outcome of one stream chunk.
 * @param chunk - one stream chunk.
 * @returns `'ok'`, `'failed'`, or undefined for a non-terminal chunk.
 */
export function outcomeOf(chunk) {
  if (chunk?.type !== 'finish') return undefined;
  const kind = chunk.reason?.kind;
  if (kind === undefined || kind === null) return undefined;
  return kind === 'error' || kind === 'aborted' ? 'failed' : 'ok';
}
