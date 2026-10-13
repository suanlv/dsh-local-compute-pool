/**
 * Configuration normalization for the Local compute pool bundle.
 *
 * The bundle row's `config` is user-editable YAML, so every field is validated
 * here with one actionable message per problem, and every default lives in one
 * place. The plugin deliberately ships no schemastery `Config`: the module
 * imports nothing outside Node's standard library, so it also loads in a
 * profile where only the harness itself provides that package.
 * @module dsh-local-compute-pool/config
 */

/**
 * Routing policies understood by the pool.
 *
 * `round-robin` is deliberately not a choice any more: `least-busy` already
 * rotates among equally idle endpoints, and on a single-endpoint pool all three
 * policies are identical. Configs that still say `round-robin` are mapped to
 * `least-busy` below, so an existing profile keeps loading.
 */
export const STRATEGIES = ['least-busy', 'fixed'];

/** Policies accepted from older configs, mapped onto {@link STRATEGIES}. */
const LEGACY_STRATEGIES = { 'round-robin': 'least-busy' };

/** Where routing applies. */
export const APPLY_TO = ['children', 'all'];

/** Validation failure with an operator-facing message. */
export class LocalComputePoolConfigError extends Error {
  constructor(message) {
    super(`local-compute-pool: ${message}`);
    this.name = 'LocalComputePoolConfigError';
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integer(value, { field, min, fallback }) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new LocalComputePoolConfigError(`\`${field}\` must be an integer >= ${min} (got ${JSON.stringify(value)})`);
  }
  return value;
}

function number(value, { field, min, fallback }) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new LocalComputePoolConfigError(`\`${field}\` must be a finite number >= ${min} (got ${JSON.stringify(value)})`);
  }
  return value;
}

function boolean(value, { field, fallback }) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new LocalComputePoolConfigError(`\`${field}\` must be a boolean (got ${JSON.stringify(value)})`);
  }
  return value;
}

function nonEmptyString(value, { field }) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new LocalComputePoolConfigError(`\`${field}\` must be a non-empty string (got ${JSON.stringify(value)})`);
  }
  return value.trim();
}

function optionalString(value, { field }) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new LocalComputePoolConfigError(`\`${field}\` must be a non-empty string when present (got ${JSON.stringify(value)})`);
  }
  return value.trim();
}

function enumValue(value, { field, allowed, fallback }) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new LocalComputePoolConfigError(`\`${field}\` must be one of ${allowed.map((v) => JSON.stringify(v)).join(', ')} (got ${JSON.stringify(value)})`);
  }
  return value;
}

function stringArray(value, { field, fallback }) {
  if (value === undefined || value === null) return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    throw new LocalComputePoolConfigError(`\`${field}\` must be an array of non-empty strings (got ${JSON.stringify(value)})`);
  }
  return value.map((item) => item.trim());
}

/** Endpoint models meaning "use the first model the provider advertises". */
export const AUTO_MODEL = 'auto';

function normalizeEndpoint(raw, index) {
  if (!isPlainObject(raw)) {
    throw new LocalComputePoolConfigError(`\`endpoints[${index}]\` must be a mapping (got ${JSON.stringify(raw)})`);
  }
  const provider = nonEmptyString(raw.provider, { field: `endpoints[${index}].provider` });
  const id = raw.id === undefined || raw.id === null
    ? provider
    : nonEmptyString(raw.id, { field: `endpoints[${index}].id` });
  const model = raw.model === undefined || raw.model === null
    ? AUTO_MODEL
    : nonEmptyString(raw.model, { field: `endpoints[${index}].model` });
  const concurrency = integer(raw.concurrency, { field: `endpoints[${index}].concurrency`, min: 1, fallback: 1 });
  const maxTokens = raw.maxTokens === undefined || raw.maxTokens === null
    ? undefined
    : integer(raw.maxTokens, { field: `endpoints[${index}].maxTokens`, min: 1, fallback: undefined });
  const reasoningEffort = optionalString(raw.reasoningEffort, { field: `endpoints[${index}].reasoningEffort` });
  const temperature = raw.temperature === undefined || raw.temperature === null
    ? undefined
    : number(raw.temperature, { field: `endpoints[${index}].temperature`, min: 0, fallback: undefined });
  const baseURL = optionalString(raw.baseURL, { field: `endpoints[${index}].baseURL` });
  const apiKeyEnv = optionalString(raw.apiKeyEnv, { field: `endpoints[${index}].apiKeyEnv` });
  return {
    id,
    provider,
    model,
    concurrency,
    label: optionalString(raw.label, { field: `endpoints[${index}].label` }) ?? id,
    enabled: boolean(raw.enabled, { field: `endpoints[${index}].enabled`, fallback: true }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
  };
}

/**
 * Normalize one whitelist row: a provider whose tasks may delegate to the
 * local pool, plus how many local subagents those tasks may run at once.
 * @param raw - one `triggers[]` entry.
 * @param index - its position, for messages.
 * @returns the normalized trigger.
 */
function normalizeTrigger(raw, index) {
  if (!isPlainObject(raw)) {
    throw new LocalComputePoolConfigError(`\`triggers[${index}]\` must be a mapping (got ${JSON.stringify(raw)})`);
  }
  const provider = nonEmptyString(raw.provider, { field: `triggers[${index}].provider` });
  const concurrency = integer(raw.concurrency, { field: `triggers[${index}].concurrency`, min: 1, fallback: 1 });
  return { provider, concurrency };
}

/**
 * Validate and default one bundle row's configuration.
 * @param raw - the row's `config` value, or undefined for an all-defaults row.
 * @returns a frozen, fully-defaulted configuration object.
 * @throws {LocalComputePoolConfigError} on the first malformed field.
 */
export function normalizeConfig(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (!isPlainObject(raw)) {
    throw new LocalComputePoolConfigError(`config must be a mapping (got ${JSON.stringify(raw)})`);
  }
  const enabled = boolean(raw.enabled, { field: 'enabled', fallback: true });
  const applyTo = enumValue(raw.applyTo, { field: 'applyTo', allowed: APPLY_TO, fallback: 'children' });
  // Older configs may still carry `round-robin`; accept it and land on the
  // policy that already means the same thing on an idle pool.
  const requestedStrategy = raw.strategy === undefined || raw.strategy === null
    ? undefined
    : LEGACY_STRATEGIES[raw.strategy] ?? raw.strategy;
  const strategy = enumValue(requestedStrategy, { field: 'strategy', allowed: STRATEGIES, fallback: 'least-busy' });
  const respectExplicitRoute = boolean(raw.respectExplicitRoute, { field: 'respectExplicitRoute', fallback: true });
  const requireRegisteredRoute = boolean(raw.requireRegisteredRoute, { field: 'requireRegisteredRoute', fallback: true });

  const rawTriggers = raw.triggers ?? [];
  if (!Array.isArray(rawTriggers)) {
    throw new LocalComputePoolConfigError(`\`triggers\` must be an array (got ${JSON.stringify(rawTriggers)})`);
  }
  const triggers = rawTriggers.map(normalizeTrigger);
  const seenProviders = new Set();
  for (const trigger of triggers) {
    if (seenProviders.has(trigger.provider)) {
      throw new LocalComputePoolConfigError(`duplicate trigger provider ${JSON.stringify(trigger.provider)}: list it once`);
    }
    seenProviders.add(trigger.provider);
  }

  const rawEndpoints = raw.endpoints ?? [];
  if (!Array.isArray(rawEndpoints)) {
    throw new LocalComputePoolConfigError(`\`endpoints\` must be an array (got ${JSON.stringify(rawEndpoints)})`);
  }
  const endpoints = rawEndpoints.map(normalizeEndpoint);
  const seen = new Set();
  for (const endpoint of endpoints) {
    if (seen.has(endpoint.id)) {
      throw new LocalComputePoolConfigError(`duplicate endpoint id ${JSON.stringify(endpoint.id)}: endpoint ids must be unique`);
    }
    seen.add(endpoint.id);
  }

  const rawQueue = raw.queue ?? {};
  if (!isPlainObject(rawQueue)) {
    throw new LocalComputePoolConfigError(`\`queue\` must be a mapping (got ${JSON.stringify(rawQueue)})`);
  }
  const queue = {
    maxWaiting: integer(rawQueue.maxWaiting, { field: 'queue.maxWaiting', min: 0, fallback: 32 }),
    timeoutMs: integer(rawQueue.timeoutMs, { field: 'queue.timeoutMs', min: 1, fallback: 600_000 }),
  };

  const rawHealth = raw.health ?? {};
  if (!isPlainObject(rawHealth)) {
    throw new LocalComputePoolConfigError(`\`health\` must be a mapping (got ${JSON.stringify(rawHealth)})`);
  }
  const health = {
    failureThreshold: integer(rawHealth.failureThreshold, { field: 'health.failureThreshold', min: 1, fallback: 2 }),
    cooldownMs: integer(rawHealth.cooldownMs, { field: 'health.cooldownMs', min: 0, fallback: 120_000 }),
    ignoreCodes: stringArray(rawHealth.ignoreCodes, {
      field: 'health.ignoreCodes',
      fallback: ['ABORTED', 'CONTEXT_WINDOW_EXCEEDED', 'IMAGE_OFFLOAD_REQUIRED', 'EMPTY_RESPONSE'],
    }),
  };

  const rawTool = raw.tool ?? {};
  if (!isPlainObject(rawTool)) {
    throw new LocalComputePoolConfigError(`\`tool\` must be a mapping (got ${JSON.stringify(rawTool)})`);
  }
  const tool = {
    enabled: boolean(rawTool.enabled, { field: 'tool.enabled', fallback: true }),
    name: rawTool.name === undefined || rawTool.name === null
      ? 'local_pool'
      : nonEmptyString(rawTool.name, { field: 'tool.name' }),
  };

  const logging = { verbose: boolean((raw.logging ?? {}).verbose, { field: 'logging.verbose', fallback: false }) };

  // An empty list is a valid starting point: the settings page adds endpoints,
  // and the plugin simply routes nothing until one exists. Activation logs that
  // state instead of refusing to load, so the page stays reachable to fix it.

  return Object.freeze({
    enabled,
    applyTo,
    strategy,
    respectExplicitRoute,
    requireRegisteredRoute,
    triggers: Object.freeze(triggers.map((trigger) => Object.freeze(trigger))),
    endpoints: Object.freeze(endpoints.map((endpoint) => Object.freeze(endpoint))),
    queue: Object.freeze(queue),
    health: Object.freeze(health),
    tool: Object.freeze(tool),
    logging: Object.freeze(logging),
  });
}
