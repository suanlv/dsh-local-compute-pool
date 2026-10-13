/**
 * The plugin's declared configuration schema.
 *
 * Declaring a `Config` is what makes the Loader entry's settings namespace
 * exist: the Settings service projects the volatile fields of an active entry
 * and the Plugins page hands that entry's form to a row page. Every top-level
 * field is volatile, so a settings write updates this plugin's values live
 * instead of remounting it — the plugin rebuilds its pool when that happens.
 *
 * Defaults here mirror {@link normalizeConfig}, which remains the single
 * validator: this schema only has to accept what the row may contain.
 * @module dsh-local-compute-pool/schema
 */

/**
 * Build the schema from a schemastery instance.
 * @param z - the schemastery `Schema` factory.
 * @returns the Config schema, or undefined when the instance is unusable.
 */
export function buildConfigSchema(z) {
  try {
    return z.object({
      // `sticky` is no longer a setting: stickiness is a design constraint of
      // the pool (one subagent stays on one machine), not a preference.
      // `enabled` stays, scoped to "take over subagents"; the Plugins card owns
      // disabling the whole plugin.
      enabled: z.boolean().default(true).volatile()
        .description('是否接管子代理；彻底停用整个插件请用卡片上的开关'),
      applyTo: z.union([z.const('children'), z.const('all')]).default('children').volatile()
        .description('children 只管子代理；all 连主代理一起走本地（主代理整段对话都会落到本地模型）'),
      strategy: z.union([z.const('least-busy'), z.const('fixed')]).default('least-busy').volatile()
        .description('端点选择策略：按负载铺开，或固定第一台'),
      respectExplicitRoute: z.boolean().default(true).volatile()
        .description('已经是池内健康线路时不再改动'),
      requireRegisteredRoute: z.boolean().default(true).volatile()
        .description('启动时校验 provider 已注册、model 在目录中'),
      triggers: z.array(z.object({
        provider: z.string().required(),
        concurrency: z.number().step(1).min(1).default(1),
      })).default([]).volatile()
        .description('白名单：使用这些 provider 的任务才启用本地并行；concurrency 是该任务的子代理并行上限'),
      endpoints: z.array(z.object({
        id: z.string(),
        label: z.string(),
        provider: z.string().required(),
        model: z.string().default('auto'),
        concurrency: z.number().step(1).min(1).default(1),
        enabled: z.boolean().default(true),
        maxTokens: z.number().step(1).min(1),
        reasoningEffort: z.string(),
        temperature: z.number().min(0),
        baseURL: z.string(),
        apiKeyEnv: z.string(),
      })).default([]).volatile().description('本地端点列表'),
      queue: z.object({
        maxWaiting: z.number().step(1).min(0).default(32),
        timeoutMs: z.number().step(1).min(1).default(600_000),
      }).default({}).volatile().description('排队准入'),
      health: z.object({
        failureThreshold: z.number().step(1).min(1).default(2),
        cooldownMs: z.number().step(1).min(0).default(120_000),
        ignoreCodes: z.array(z.string()).default([
          'ABORTED',
          'CONTEXT_WINDOW_EXCEEDED',
          'IMAGE_OFFLOAD_REQUIRED',
          'EMPTY_RESPONSE',
        ]),
      }).default({}).volatile().description('失败冷却'),
      tool: z.object({
        enabled: z.boolean().default(true),
        name: z.string().default('local_pool'),
      }).default({}).volatile().description('local_pool 工具'),
      logging: z.object({
        verbose: z.boolean().default(false),
      }).default({}).volatile().description('调试日志'),
    });
  } catch {
    return undefined;
  }
}
