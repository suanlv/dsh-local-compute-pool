---
description: "把多个本地推理端点并成一个算力池：子代理按负载铺开、每端点并发闸门与排队、失败冷却换机。完整的使用与字段说明。"
kind: "package-reference"
---

# 本地算力池 (dsh-local-compute-pool)

[English](README.en.md) | 中文

一个 DeepSeek Harness 插件：**把子代理（subagent）的模型调用自动分配到多台机器的本地推理服务上**，
并按每台机器的并发能力排队，让两台电脑的算力真正叠加在同一个任务上。

本地部署的模型有三个现实约束，本插件针对它们设计：

| 现实约束 | 本插件的做法 |
| --- | --- |
| 显存/内存有限，通常只能跑一个会话 | 每个端点有独立的**并发闸门**（默认 1），同时最多只放行 `concurrency` 个请求，其余排队 |
| 上下文缓存能力有限 | 每个子代理**黏在**一台机器上（终身不来回切换），避免前缀缓存反复失效 |
| 不擅长多发并行 | 用 `least-busy` 策略把子代理铺开到不同机器，而不是堆在一台上排队 |

主代理（你正在对话的模型，例如云端 `deepseek-flash`）保持不变；**只有被委派的子代理**会落到本地端点。
如果你想让主代理也走本地，把 `applyTo` 改成 `all`。

---

## 工作原理

插件挂载两个 Harness 官方扩展点（均为 waterfall 事件）：

```
主代理 ── subagent / workflow 委派 ──▶ 子代理会话
                                          │
                              agent/request（每个模型请求前）
                                          │  ① 判定这是子代理
                                          │  ② 选一台机器（按负载 / 固定第一台）
                                          │  ③ 改写 provider+model（保留 temperature/maxTokens）
                                          ▼
                                  llm/stream（真正发起请求）
                                          │  ④ 取得该端点的一个名额（否则排队等待）
                                          │  ⑤ 流结束后释放名额；失败则记入健康度
                                          ▼
                              本机 :8888  或  另一台电脑 :8080
```

* 端点的 `provider` 就是你在 `llm-pi-ai` 里已经配好的 provider id（本机 `local`、另一台 `local-strata`）。
  插件不自己发 HTTP，也不重复配置 API 地址，只负责"选谁 + 排队"。
* 路由是**按请求**决定的，但通过**子代理黏性**保持稳定：一个子代理整个生命周期都在同一台机器上。
* 失败会累计；达到 `health.failureThreshold` 后该端点进入 `cooldownMs` 冷却，黏性绑定被清除，
  下一次重试/下一个子代理会自动换到另一台。
* 所有端点都不可用时，子代理**保持父代理原本的线路**继续跑，任务不会因为本地服务没开而中断。

---

## 安装

在 Harness 里用插件管理器安装这个目录（绝对路径），或让助手代劳：

```
plugin_manager  action: install_bundle
                target: <克隆下来的仓库目录>\plugin
```

安装后：

* 包会被加入 profile 的 `dsh.profile.bundles`，本目录的 `cordis.patch.yml` 作为一层 patch 插入插件行。
* **新装的 bundle 可以热生效**；若提示 `restart-required`，重启 Harness 桌面端即可。
* 之后修改 `cordis.patch.yml` 里的 `config` 属于配置层修改，会被 HMR 实时重载；替换包内容（改 JS）需要重启。

卸载：`plugin_manager action: remove_bundle target: dsh-local-compute-pool`。

---

## 设置页面（Web UI）

插件自带一个浏览器半边：**打开「插件」页里这张卡片，页面主体就是它的设置表单**，
位置和官方的「语音输入」等 bundle 一样——在描述下方、组件列表上方。

> 侧栏 **插件(Plugins)** → 卡片 **本地算力池** → 直接就是设置页

页面里可以直接改（不需要再手编 YAML），核心是**两个列表**：

**① 触发白名单（列表 1）** —— 列出目录里**所有已录入的 provider**，勾选即把它加入白名单：

* 只有**任务自身的模型**跑在白名单 provider 上时，该任务才会把子代理交给本地端点并行执行；
  没勾选的 provider 跑任务时，插件完全不接管（子代理保持原样）。
* 每一项旁边的**并行上限**＝该 provider 的任务**最多同时运行几个本地子代理**。
* 白名单为空（当前默认）＝不做白名单限制：凡是子代理都按下方的池子分配（等价旧行为）。
* 已配置但目录中已消失的 provider 会以「（配置里有，但目录中已不存在）」保留，仍可取消勾选。

**② 子代理模型池（列表 2）** —— 子代理用哪些 provider/模型：

* 「＋ 添加本地端点」新增、每条「删除」移除；`provider` 与**模型都是下拉**，
  选项来自实时目录（`remote.session.modelCatalog()`，与官方 Subagent 设置页同源），
  模型下拉是 `auto` + 该 provider 广告的模型；已配置但目录里没有的值会保留并标注；
* **改了 provider 立刻就能选它的模型**，不需要先保存：provider 与"重置为 auto 的模型"是同一笔数组写入，
  行内只有一个数据源，所以不会再出现"先选 provider、保存后才拿到该 provider 的模型"，
  也不会把上一个 provider 的模型 id 带过来（那会显示成"已配置但目录里没有"）；
* **名称可改**：每行「名称」只影响显示（行头与 `local_pool` 里的 `label`），路由与端点 `id` 不受影响；留空则回退显示 `id`；
* 每条的**并发**＝该端点能同时服务的请求数（本机单会话模型填 1）。
* 增删/改都写**整个数组**，一次原子保存，不会错位。

其余仍在同一页：路由（启用/作用范围/策略）、失败与冷却、排队准入、`local_pool` 工具开关。

所有开关（启用路由、白名单勾选、端点「参与分配」、`local_pool` 工具）都是**与官方插件设置页一致的开关样式**：
36×20 的轨道 + 圆钮，颜色取自同一套主题变量，因此跟随明暗主题；底层仍是原生 checkbox，
所以键盘（Tab + 空格）与读屏都正常。只读连接下开关呈禁用态（半透明），但仍显示已保存的值。

行为要点：

* **提示词标注**：任务跑在白名单 provider 上时，插件会给**该任务**注册一段系统提示词
  （位置紧跟 subagent 工具说明之后），写明「本任务最多同时运行 N 个本地子代理」以及可用端点与各自并发，
  让模型知道该把工作拆成多宽。提示词是**动态求值**的，改设置立刻反映；取消勾选则该段自动撤除。
* **上限是真的**：白名单里的 N 会作为**任务级并发预算**在 `llm/stream` 上强制执行——
  即使两个子代理落在两台不同机器上，同一任务同时也只有 N 个本地子代理在跑，超出的排队
  （超时/取消沿用 `queue` 的配置）。
* **任务自己的机器归任务**：任务自身跑在池内某端点时，它这次请求会**占住该端点的一个名额**
  （白名单与算力池重叠时最明显）。于是：
  * `concurrency: 1` 的机器只服务任务本身，它的子代理被分到别的端点；
  * 若池里只有这一台，子代理保持继承线路、与任务在同一台机器上**由服务端串行**，而不是被塞进一个并不存在的第二名额；
  * 任务这次请求结束后名额立刻释放，该端点重新参与分配。
  `local_pool` 里这一项显示为 `N slot(s) held by a task running on it`。
* 保存是一次**原子写入**，按读取时的 revision 做冲突保护；写入落在 profile 的
  `cordis.patch.yml`（也就是下面的 `config:`），并且**立即生效**——宿主半边收到
  `loader/volatile-update` 后重建端点池与白名单，不需要重启，也不会中断正在跑的会话。
* provider/模型下拉在适配器变化、设置文档变化、重连后自动刷新；读取失败会就地给出「重试」。
* 页面只显示**配置**；"在跑几个 / 排队几个 / 哪台冷却中"属于运行时状态，让模型调用
  `local_pool` 工具查看（页面底部也写了这句提示）。
* 页面用宿主主题 token 渲染，跟随明暗主题；文案走 Client 的 locale 服务（zh/en）。
* 页面通过 `plugins.bundle.config`（键＝包名）注册，并用 `ctx.configForms.whileServed` 跟随自己的
  settings 命名空间：宿主半边没装/没激活时，这个页面**根本不出现**，不会留半个空壳。

### 端点列表为空是合法状态

`endpoints: []` 是允许的（全新安装的默认值就是空）：此时插件不路由任何东西，
被委派的子代理保持父代理原本的线路，日志里会提示一次"还没有配置本地端点"。
在页面上添加第一条端点并保存后即可开始工作。

> 本机当前 `config` 里保留了你原有的两条端点（`machine-a` / `machine-b`），
> 这样升级过程不会中断路由。想要空列表：在页面上把两条删掉并保存即可。

> 浏览器半边是随包提供的静态文件，**改完刷新一次页面**即可生效；
> 宿主半边（`index.js` / `lib/*.js`）因模块缓存需要**重启 Harness 桌面端**才会换新世代。

> **关于白名单**：它是这一版新加的字段。运行中的宿主世代还没有它，所以在重启之前
> 勾选白名单再保存会被设置服务拒绝（页面会显示拒绝原因，不会静默失败）；
> **重启之后**勾选/取消、改并行上限都会正常写入并立即生效。子代理池（列表 2）不受影响，现在就能用。

---

## 配置

配置就写在 `plugin/cordis.patch.yml` 的 `config:` 下（安装后即成为 profile 的一层），
修改后 HMR 会重载。完整字段：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭时不注册任何监听器，子代理完全保持原样 |
| `applyTo` | `children` | `children` 只管子代理；`all` 连主代理一起走本地 |
| `strategy` | `least-busy` | `least-busy`（按负载+已服务次数铺开）、`fixed`（永远第一台）。旧配置里的 `round-robin` 会被映射为 `least-busy`：有空闲端点时二者等价，已不再单独提供 |
| ~~`sticky`~~ | 固定为开 | **不再是配置项**：池始终保证同一个子代理留在最先分到的那台机器上（前缀缓存与工具调用方言稳定）。旧配置里的 `sticky:` 会被忽略；关掉它会让同一子代理每次请求都重新选机器 |
| `enabled` | `true` | **保留，但职责收窄为"是否接管子代理"**：关闭后子代理保持 harness 原线路，其余设置不动；要彻底停用整个插件请用卡片右上角的开关（它同时停止加载） |
| `respectExplicitRoute` | `true` | 请求已经指向池内某个端点（且该端点健康）时不再改动 |
| `requireRegisteredRoute` | `true` | 启动时校验 provider 已注册、model 在目录中；不通过则跳过该端点并告警 |
| `endpoints[]` | — | 至少一个，见下 |
| `queue.maxWaiting` | `32` | 单端点最多排队数，超出直接返回 `QUEUE_FULL` |
| `queue.timeoutMs` | `600000` | 排队超时（10 分钟），超时返回 `QUEUE_TIMEOUT` |
| `health.failureThreshold` | `2` | 连续失败几次后停用该端点。注意它同时决定**换机器前的重试次数**：健康检查是"被动"的，失败 1 次不会立刻搬走会话；想最快切换就设为 `1` |
| `health.cooldownMs` | `120000` | 停用（冷却）时长；某台机器经常关机就把它调大 |
| `health.ignoreCodes` | `ABORTED, CONTEXT_WINDOW_EXCEEDED, IMAGE_OFFLOAD_REQUIRED, EMPTY_RESPONSE` | 这些失败不算端点不健康 |
| `tool.enabled` | `true` | 是否注册 `local_pool` 状态工具 |
| `tool.name` | `local_pool` | 工具名 |
| `logging.verbose` | `false` | 打开后每个请求的路由决策写 debug 日志 |

端点字段：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `id` | `provider` | 端点标识（需唯一），出现在日志与工具输出里 |
| `provider` | 必填 | `llm-pi-ai` 里配置的 provider id，例如 `local`、`local-strata` |
| `model` | `auto` | 精确模型 id，或 `auto`＝取该 provider 广告的**第一个**模型 |
| `concurrency` | `1` | 该机器同时可服务的模型请求数（显存够、服务端支持批处理时才调大） |
| `maxTokens` | — | 覆盖该端点的输出上限（本地模型上下文小的时候很有用） |
| `reasoningEffort` | — | 覆盖思考档位；不写则切到该端点时清空继承的档位 |
| `temperature` | — | 覆盖采样温度 |
| `baseURL` / `apiKeyEnv` | — | 仅用于 `local_pool` 的 `probe` 探活，不影响真实请求路由 |
| `label` | `id` | 展示名 |
| `enabled` | `true` | 临时摘掉某台机器 |

**出厂端点是空的**（`endpoints: []`）：一个指向别人机器上不存在服务的端点只会失败，所以本插件不预设任何端点。
在设置页「＋ 添加本地端点」里加你自己的：`provider` 从实时目录里选（`local`、`local-strata` 等，取决于你在
`llm-pi-ai` 里配了什么），`model` 选 `auto` 或精确 id，`并发` 按该机器能同时服务几个请求填（单会话本地服务填 1）。

### 只让子代理走本地，主代理不动

默认即是。`agent-default-model`（你当前的 `deepseek-account/deepseek-flash`）不受影响。

### 主代理也走本地（省云端额度）

```yaml
applyTo: all
```

注意：此时主代理的整段对话也会落到本地模型，工具调用能力取决于本地模型本身。

---

## 怎么用起来

1. **一次消息里并发起多个子代理**——路由会把它们分到不同机器上：

   > 用两个 subagent 分别调研 A 和 B，再汇总。

2. **用 workflow 扇出**（`agent(prompt, opts)` 不指定 `provider`/`model` 时会继承父代理的线路，插件会接管）：

   ```
   让 workflow 起 4 个子代理，每个审一个文件，最后汇总。
   ```

3. **先看容量再决定扇出宽度**：让模型调用 `local_pool`（可带 `probe: true` 探活），
   它会报告每台机器 `ready/parked`、在跑几个、排队几个、已服务多少、以及有几台的名额被"任务自身"占着；
   **每个当前持有预算的任务也会单独列一行**（`task <provider>: 1/2 local subagent(s) running, 1 queued`），
   这是设置页看不到的任务级并行情况；
   带上 `probe: true` 时还会对 `baseURL` 发一次短请求，直接告诉你"空闲"还是"没开机"。

### 改动生效范围

* 改 `plugin/cordis.patch.yml` 的 `config` → profile 重载，**实时生效**（无需重启）。
* 在**设置页面**里改（等价于写上面那个 `config`）→ 立即生效，并持久化到 profile patch。
* 改 `plugin/index.js` / `plugin/lib/*` / `plugin/client.js` → 已装包是 `link:`，但模块 HMR 默认关闭，
  **需要重启 Harness 桌面端**（浏览器半边另外还需要刷新一次页面）。
* 卸载/重装 bundle 用 `plugin_manager`，不要手改 profile 的 `package.json`。

已实测的运行结果（含失败回退路径）记录在 [VERIFICATION.md](VERIFICATION.md)。

4. **手动钉到某一台机器**：在 `subagent` 里选一个池内的 provider/model（需要
   `modelSelectionSettings` 打开），插件会尊重这个选择不再改动。

---

## 排错

* **子代理没走本地**：看日志里有没有 `local-compute-pool: armed ...` 与
  `…/… endpoints ready [...]`。若端点是 `unavailable`，日志会给出原因
  （provider 未注册 / model 不在目录中）。
* **`local_pool` 显示 `parked`**：该机器连续失败达到阈值，正在冷却；把本地服务起起来后等冷却结束，
  或把 `health.failureThreshold` 调大。
* **`QUEUE_TIMEOUT`**：两台机器都在满负荷且任务太大；调大 `queue.timeoutMs`，
  或把 `concurrency` 调大（确认服务端支持）、增加端点。
* **子代理报 `UNKNOWN_MODEL`**：`model` 写错了。用 `model: auto` 或从
  `llm-pi-ai` 的 `models[]` 里复制精确 id（插件的启动校验默认会拦住这种配置并告警）。

---

## 已知限制

* 只负责"选端点 + 排队"，不做请求重试策略——重试仍由 `dsh-llm-retry` 在 `agent/request-error` 上执行。
* 落盘（会话日志）记录的是最终 provider/model，因此路由对复盘是可见的；但插件不新增任何 Session 事件。
* 路由在 `agent/request` 上按"每次模型尝试"生效，重试会重新经过它（这正是失败后能换机器的原因）。
* 若本地服务端真的支持并发（vLLM 等），请显式把 `concurrency` 调大，插件的默认值偏保守。

---

## 开发与测试

```powershell
# 单元/接线测试（沙箱里 node --test 的子进程会被拦，直接跑文件）
node plugin\test\pool.test.mjs          # 23
node plugin\test\plugin.test.mjs        # 25
node plugin\test\client-page.test.mjs   # 21（浏览器半边）
```

测试包含：配置校验、负载分配与黏性、并发闸门与排队超时、失败冷却与回退、
**任务自身占位（白名单与池重叠时不给自己派子代理）**、
`agent/request` 的六字段改写规则、`llm/stream` 的串行化与直通、白名单与任务级预算、
状态工具输出、以及设置页的注册键与读写路径（含"改 provider 立即换模型列表"与可编辑名称）。

> 改名记录：本插件原名「更好的本地推理支持 / `dsh-better-local-support`」，
> 2026-10-12 起更名为「本地算力池 / `dsh-local-compute-pool`」（版本沿革见仓库根的
> [CHANGELOG.md](../CHANGELOG.md)）。改名同时修好了一个此前一直没生效的问题：卡片标题现在真的会显示
> 中文（`locale/*.json` 必须写成 `{"meta": {"title": …}}` 信封，官方加载器只读这一层）。

`plugin/lib/` 只依赖 Node 标准库，没有第三方依赖，也不需要构建步骤。
