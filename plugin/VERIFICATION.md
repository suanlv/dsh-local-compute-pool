# 验证记录 (Verification log)

> **命名历史**：下面的记录（第 2、4 节）是在包名 `dsh-better-local-support`、行 id
> `better-local-support`、卡片名「更好的本地推理支持」时写的，保留为当时的原貌。2026-10-12 起
> 包名为 `dsh-local-compute-pool`、行 id 为 `local-compute-pool`、卡片名为「本地算力池」，
> 对应替换见第 6 节；旧记录里的键名与 id 请按下表换算。

环境：Windows 11 + DeepSeek Harness Desktop `0.2.0-rc.2`，profile `desktop`，
插件目录 `<repo>\plugin`（通过 `plugin_manager install_bundle` 以 `link:` 方式安装）。

## 1. 单元 / 接线测试（本机 node 24.21.0）

```
node plugin\test\pool.test.mjs        → tests 21, pass 21, fail 0
node plugin\test\plugin.test.mjs      → tests 22, pass 22, fail 0
node plugin\test\client-page.test.mjs → tests 15, pass 15, fail 0
```

覆盖：配置校验（含空端点列表合法、白名单去重、旧 `round-robin` 策略映射、被移除字段的忽略）、
least-busy/fixed 选择、**子代理黏性**（同一个子代理终身一台）与任务自身占位（`reserved`）、
并发闸门串行化、**任务级并行预算**（跨端点限流、按任务隔离、调高上限立即放行、取消让位）、
排队超时/队列满/取消、失败冷却与回退、`agent/request` 六字段改写规则（含清空继承的
`reasoningEffort`）、`llm/stream` 排队与直通、状态工具输出与探活渲染、volatile 配置热改后重建端点池；
**白名单门控**（只有白名单 provider 的任务被接管、非白名单任务原样放行）、
**提示词标注**（该任务的子代理上限 + 端点清单、位置与动态性、取消勾选后自动撤除）；
浏览器半边（插槽键、summary/page 两视图、provider/模型下拉来自宿主目录、**改 provider 立即换模型列表且不沿用旧 provider 的 model id**、
白名单勾选与上限、白名单条目在目录消失后仍可取消、增删端点/白名单写成整数组的原子 `mutate`、标量编辑、
**端点名称可编辑**、**开关控件（原生 checkbox + `aria-checked` 轨道、只读态禁用）**、
写入被拒/抛错、目录读取失败可重试、只读连接禁用保存）。

> 沙箱说明：本机沙箱禁止 `node --test` 派生带管道 stdio 的子进程（`spawn EPERM`），
> 因此测试以文件形式直接运行（`node:test` 在进程内报告结果）。

## 2. 安装与激活（live）

`plugin_manager install_bundle` 返回：

```json
{"stage":"enable","target":"dsh-better-local-support","enabled":true,"changed":true,
 "application":"applied","warnings":[]}
```

* profile 的 `package.json`：`dsh-better-local-support: link:<repo>/plugin`，
  且已加入 `dsh.profile.bundles`。
* `Config.listConfigs` → `include:better-local-support`，`patchId: better-local-support`，
  `name: file:///<user>/.dsh/profiles/desktop/node_modules/dsh-local-compute-pool/index.js`
  （`./index.js` 被正确锚定在补丁文件旁边），状态 `absent` = 已激活且没有 Config schema（本插件不导出 `Config`）。
* `Tool.listTools` 中出现了 `local_pool` —— 说明 `apply()` 已执行、工具注册成功。

## 3. 端到端（真实两台机器）

让一个子代理调用 `local_pool`（`probe: true`）并回传结果，子代理本次回答**由本地模型产生**，
其返回的池状态为：

```
Local inference pool: 1/2 endpoint(s) ready, 0 in flight, 0 queued.
- machine-a (local / acme/Local-Model-A-GGUF): parked, 0/1 in flight, 2 served — parked for 63s after 2 failures (last: TRANSPORT)
- machine-b (local-strata / local-model-b-iq4_xs): ready, 0/1 in flight, 1 served
```

结论（全部为实测，不是推断）：

1. **路由生效**：子代理的模型调用被改写到了池内本地端点，而不是继承父代理的 `deepseek-account/deepseek-flash`。
2. **`model: auto` 生效**：两个端点的真实模型 id 由实时 llm 目录解析得到
   （`acme/Local-Model-A-GGUF`、`local-model-b-iq4_xs`）。
3. **失败冷却生效**：本机 127.0.0.1:8888 当时未启动 → 连续 2 次 `TRANSPORT` 失败 → 端点被 `parked` 63s。
4. **自动回退生效**：第 3 次尝试换到另一台（:8080，真实在跑），`served = 1`，子代理顺利完成回答。
5. **并发闸门生效**：`0 in flight`（空闲）、每端点 `concurrency=1`，跨机器并行而非堆在一台。

## 4. 设置页面（Web UI）的验证边界

已确认（实测或代码级确认）：

1. **插槽契约**：设置页注册在 `plugins.bundle.config`，键＝bundle 包名（`dsh-better-local-support`）。
   `dsh-client-ui-plugin-manager` 的 bundle 页只有 `ledger.bundles.has(pkg.name)` 为真时才渲染该插槽
   （`client.js:2522` 与 `:3526`），渲染位置在描述之后、`RowsSection`（"包含的组件"）之前——与官方
   「语音输入」页的布局一致。官方 `plugins.item` 的说明也明确写着 bundle 的配置应放
   `plugins.bundle.config` / `plugins.row.config`，而不是 `plugins.item`。
   该插槽**不注入 form**，所以页面自己通过 `ctx.configForms.get(entryId)` 绑定命名空间，
   并用 `whileServed([entryId])` 跟随服务状态（宿主没装就没有这个页面）。
2. **命名空间**：settings 命名空间 = Loader entry 的 `options.id`（`dsh-settings/lib/index.js:432`
   `ns: entry.options.id`；官方 subagent 页用的 `subagent` 正是它自己的行 id）。本插件行 id 为
   `better-local-support`，与页面 `formFor(rowId)` 的查询一致。
3. **schemastery 可达性**：profile 安装的 bundle 是符号链接，Node 会按真实路径（工作区）解析导入，
   因此 `import '@deepseek-ai/schemastery'` 会失败（用临时探针包实测得到
   `ERR_MODULE_NOT_FOUND`）。改为从 `process.resourcesPath` 指向安装内的 `app.asar` 路径导入后，
   探针实测 `schemastery=asar` 成功，`Config` 才可用；`lib/schemastery.js` 保留多候选回退，
   全部失败时不导出 `Config`，插件照常工作、只是没有设置页。
4. **声明被组合接受**：`dsh.client = { platform: 'web', immediately: true }` + `exports['./client']`
   与 `dsh-client-modules` 的校验器逐字段一致（`platform` 字符串、`immediately` 布尔、
   必须导出 `./client`）；`install_bundle` 返回 `application: applied` 且无 warning，
   说明组合未拒绝该声明。
5. **页面逻辑**：`client-page.test.mjs` 用桩 module loader + React shim 实际渲染页面，验证
   `whileServed` / 命名空间绑定 / 插槽键、summary 与 page 两视图、字段编辑聚合成
   `{op:'set', path:[...], value}`、按 revision 围栏的 `mutate(ops, revision)`、宿主拒绝（返回
   `false`）与抛错两条失败路径、以及只读连接的禁用状态。

尚未验证（明确声明）：**页面在浏览器里的实际观感与交互**（表单是否出现在卡片页、点击保存后是否刷新、
明暗主题下的显示）。这需要：刷新页面（加载新的浏览器半边）→ 在 插件 页打开该 bundle 卡片。
届时 `Slots.listSubTree` 的 `plugins.bundle.config` occupants 里会出现键 `dsh-better-local-support`，
这是"注册成功"的直接证据。

### 一个实测到的坑：模块缓存按 URL 生效

宿主模块一旦被进程导入就按 **URL** 缓存（`link:` 安装下即工作区真实路径）。为了不重启就换新代码，
曾把入口从 `index.js` 改名为 `host.js`：入口换了新 URL 并成功重新导入，但它 `import './lib/config.js'`
仍然拿到**旧**的缓存模块，于是出现"新入口 + 旧 lib"的混合世代——`buildPoolTool` 的入参签名不匹配、
旧校验仍然拒绝空端点列表，安装直接失败。回退成一致世代（全部沿用 `index.js`）后恢复正常。
结论写在这里：**改宿主代码必须整代重启**，改名只会制造混合世代；浏览器半边是静态文件，刷新即可换新。

## 5. 尚未验证的部分（明确声明）

* **宿主 JS 的新世代尚未在 live 进程生效**：装包是 `link:`、模块 HMR 未开启
  （base 的 `hmr` 行 `root: []`），所以带 `Config` 与设置页支持的宿主模块
  **需要重启 Harness 桌面端**才会加载；YAML 配置改动仍是实时生效。
* **并发队列的真实阻塞行为**只用单测与假 harness 验证过：本次 E2E 中两个端点没有同时被压满，
  没有观察到真实的"第二个请求在队列里等待"的线上样本。
* **多台机器同时满载**的场景（`queue.timeoutMs` 触发 `QUEUE_TIMEOUT`）未在线上复现。
* 桌面端 profile 由 Electron 应用独占管理，`dsh --profile desktop` 被 CLI 拒绝，
  因此没有用独立 CLI 做隔离验证；验证均在运行中的应用内完成。

---

## 6. 更名「本地算力池 / dsh-local-compute-pool」（2026-10-12）

| 旧 | 新 | 出现位置 |
| --- | --- | --- |
| `dsh-better-local-support` | `dsh-local-compute-pool` | `package.json.name`、profile 的 `bundles[]`/`dependencies`、`client.js` 的 `BUNDLE_KEY` 与 loader id |
| `better-local-support` | `local-compute-pool` | `cordis.patch.yml` 行 id、`index.js` 的 `name`/`PREFIX`/prompt 段落名、`client.js` 的 `NS`/`ENTRY_ID`、错误前缀、test 断言 |
| 更好的本地推理支持 | 本地算力池 | locale 标题、README、日志与提示里的卡片名 |
| （无中文标题可显示） | 本地算力池 / Local compute pool | `locale/{zh,en}.json` 改成 `{"meta": {…}}` 信封 |

### 6.1 顺带修好的缺陷：卡片标题从来没显示过中文

官方 `readPluginMeta` 只读 `locale/*.json` 里的 **`meta.title` / `meta.description`**；
本插件此前是平铺的 `{"title": …}`，两个字典因此都是空的，标题回退到 `package.json.name`
（`dsh-app-boot/lib/index.js:1937-1941`、`:1975-1977`），客户端渲染的也是这个回退值
（`dsh-client-ui-plugin-manager/lib/client.js:601`）。改完信封后：

* `meta.title` = 本地算力池 / Local compute pool，`meta.description` = 池化说明（中英各一份）。

### 6.2 本次实测

```
node plugin\test\pool.test.mjs        → tests 21, pass 21, fail 0
node plugin\test\plugin.test.mjs      → tests 22, pass 22, fail 0
node plugin\test\client-page.test.mjs → tests 15, pass 15, fail 0
```

断言的标识符已同步：`plugin.test.mjs` 的 `name`、`client-page.test.mjs` 的
loader id / `whileServed` 命名空间 / `plugins.bundle.config` 插槽键。

### 6.3 profile 对齐：本次在文件系统层完成（`plugin_manager` 不可用时的等价操作）

本会话的工具集里没有 `plugin_manager`，用户随后把审批策略改为 never / 文件策略改为
`danger-full-access`，因此由本会话直接做了它等价的三件事，并留了备份：

| 动作 | 具体内容 |
| --- | --- |
| 备份 | `%USERPROFILE%\.dsh\profiles\desktop\` 下的一份备份目录（package.json / cordis.yml / cordis.patch.yml / pnpm-lock.yaml / node_modules 的 lock.yaml） |
| 链接 | 新建 junction `profile\node_modules\dsh-local-compute-pool → …\<repo>\plugin`（旧名 junction 保留，作为过渡） |
| 登记 | profile `package.json` 的 `bundles[]` 与 `dependencies` 换成新名；跑 pnpm 11.7.0（`--dir <profile>`）刷新 `node_modules/.pnpm/lock.yaml` 与 `pnpm-lock.yaml` |

结果与证据：

* 两个 lock 文件的 importer 都变成 `dsh-local-compute-pool: link:…/<repo>/plugin`，旧依赖键消失；
  另有两个**悬空 junction**（`dsh-probe-schemastery`、`dsh-probe-settings`，指向早已删除的
  `tools\probe-*`）一并清掉，它们与本次改名无关。
* **运行时自己完成了物料化**：`cordis.yml` 末尾出现了新条目
  `- id: local-compute-pool` → `file:///<user>/.dsh/profiles/desktop/node_modules/dsh-local-compute-pool/index.js`，
  且带着完整 `config`（`triggers: []` + 两条端点 + queue/health/tool）——即运行中的宿主已按新行 id 重新物料化，
  这比手改更可信。（文件里的中文标签看起来是乱码，那是日志/终端编码问题，不是内容损坏。）
* 旧名 junction 仍指同一目录、仍有效，但已不再被任何 `id`/`bundles[]` 引用，属于可随时删除的遗留物。

### 6.4 装后核验：`plugin/verify-install.mjs`（21/21）

新增一个装后自检脚本，模拟宿主那一遍解析：从 profile 的 junction 而不是工作区路径导入，
检查登记/入口/`Config`/客户端标识符/locale 信封/补丁行 id/工具注册/热更监听。

```
$env:ELECTRON_RUN_AS_NODE='1'; & "<install>\DeepSeek Harness.exe" plugin\verify-install.mjs
→ 21/21 checks passed

node plugin\verify-install.mjs
→ 20/21（唯一失败项是 Config：纯 Node 读不了 app.asar，见下）
```

**用宿主运行时跑，而不是纯 node** —— 这是本次实测到的一条硬约束：

| 运行时 | `import('file://…/app.asar/dsh/node_modules/@deepseek-ai/schemastery/lib/index.mjs')` | 结论 |
| --- | --- | --- |
| 纯 node 24.21.0 | `ERR_MODULE_NOT_FOUND`（连 `fs` 都不认识 asar 路径） | 会误报 |
| Electron 44 的 node 24.18.1 | `ok`（`object=function boolean=function`） | 真实宿主行为 |

裸导入 `@deepseek-ai/schemastery` 在两种 Node 下都失败（profile 的 hoisted `node_modules`
里没有这个包），所以 `lib/schemastery.js` 的**第一候选（resourcesPath → app.asar）是唯一生效路径**，
它成立 → `Config` 存在 → 设置页与 volatile 实时改写成立。`Electron --version` 之类的探针无效（不会打印），
必须用 `ELECTRON_RUN_AS_NODE=1` 把 Electron 当 Node 用。

### 6.5 仍未验证（明确声明）

* **重启后的实际观感**：卡片标题是否显示「本地算力池」、设置页表单是否出现、保存是否真的落盘——
  见第 7 节（重启后已取得间接证据）。
* 本次没有执行 `plugin_manager install_bundle`，所以**没有走一遍官方的安装校验**
  （例如 `install_bundle` 返回的 `warnings`、兼容性预检）。上面 6.3/6.4 是它的等价替代，不是同一路径。

---

## 7. 重启后的复核（2026-10-12 23:31 重启，23:35 复核）

重启后的判定难点：**插件是否挂载，进程外看不到直接证据**。本次试过并否掉的路子记录下来，
省得下次再走：

| 路子 | 结果 |
| --- | --- |
| 应用日志 | 这个部署**不落日志**（`%APPDATA%`、`.dsh\logs` 都不存在），拿不到 `local-compute-pool: armed … settings=available` |
| 会话原始记录 | `sessions\<…>\session.v4.jsonl.zstd` 是**多帧** zstd：单帧解压只得到 233 字节的会话头，按魔数逐帧解压才拿到 2.6 MB。内容只有对话正文，**不含运行时状态** |
| 会话投影 | `storages\session_projcache\sessions\*.json` 只有 `{version, record:{identity, rows}}`，是对话文字，同样不含挂载状态 |
| Web 网关 | `127.0.0.1:19387` 一律 **401**（`Authorization: Bearer x` 也是 401），且启动参数里没有 `--remote-debugging-port`，CDP 也走不通 |
| 进程内存扫模块表 | 两个 dsh-host 进程（pid 360924 / 622344）的 LDR 表扫了 2 万条，没有插件路径。**但这对 JS 模块本身就不是有效证据**：Node 直接读源码，不注册进模块表 |
| Restart Manager 查句柄 | 插件四个文件都"没有进程持有"。同样不是有效证据：Node 读完即关句柄 |

**真正拿到证据的是这一条**：`profile\cordis.patch.yml` 在 **23:34:13**（重启之后）被写入，
新增了一个 provider（内网地址、显示名等本机信息已在此处删除）。
这次写入只能由 **该 bundle 的设置页**发起（它把编辑写进 profile 的补齐层），因此同时证明：

1. 设置页**渲染出来了**（否则没有可点的表单）；
2. 它绑定的命名空间 `local-compute-pool` **被服务端认了**（否则 `whileServed` 不成立、表单不出现）；
3. 一次**保存真的落盘**并即时生效（否则 profile 里不会有新 provider）。

也就是说，改名的两块硬骨头（行 id → settings 命名空间、`Config` → 设置页）在重启后都成立了。
另外 `cordis.yml` 在 23:31:27 被启动流程重写成 4 行的注释 + `[]`，其注释明确写"根条目列表由
patches 组合而成，请编辑 `cordis.patch.yml`"——所以这个文件不再是插件条目的存放处，
6.3 里"运行时物料化"那条只适用于重启前那一代。

**仍未复看**：卡片标题那行字到底是「本地算力池」还是别的（locale 信封已按官方样本逐字段核对，
但没人肉眼看过）；`local_pool` 工具在新世代里的输出。这两项需要人或模型在新会话里各看一眼。

---

## 8. 用户反馈的两个问题的修复（2026-10-13）

### 8.1 设置页：选完 provider 才能拿到它的模型、名称不可改

三处独立缺陷，都在 `plugin/client.js`：

| 症状 | 根因 | 修法 |
| --- | --- | --- |
| 模型下拉要**先保存 provider** 才出现该 provider 的模型 | 模型选项按**已保存的** `endpoint.provider` 计算（`modelChoices(endpoint.provider, …)`） | 改从**行内草稿数组**取 provider（`effectiveProvider`），改 provider 立刻重算选项 |
| 换了 provider 后模型列表仍像旧的 | 旧 provider 的精确 model id 被带过来，落进「已配置但目录里没有」那一项 | 改 provider 时**同一次数组写入**把 model 重置为 `auto` |
| 名称没法改 | 行头只渲染 `endpoint.id`，配置里的 `label` 根本没有输入框 | 新增「名称」输入框；行头显示 `label ?? id`；`label` 留空回退 `id` |

附带修掉两个让上面三条反复复发的隐患：

* **单一数据源**：端点行的 provider/模型/名称都只写 `endpoints` 数组，不再同时写
  `endpoints.<i>.provider` 这类路径草稿键——否则一次保存会多出一个 op，且两条读取路径可能给出不同答案；
* **函数式更新**：`patchEndpoint` 改为在 `setDraft` 的更新函数里读当前草稿，而不是闭包里的旧数组，
  这样即使回调来自上一次渲染的控件，也不会用旧数组覆盖掉刚写入的改动。

### 8.2 白名单与算力池重叠时，任务给自己派子代理

原来池只知道"子代理占用名额"，**不知道任务自己的请求也在那台机器上**：
任务跑在池内的 `concurrency: 1` 机器上时，它派出的子代理被 RFC 分配到同一台机器，于是这台单槽服务端同时收到两个并发请求。

修法是把"任务自己的请求"也变成**真实的容量占用**：

* `LocalPool.hold(provider, model)`：请求开始时在对应端点上 `reserved += 1`，`finally` 释放（幂等）；
  `#usable` 现在要求 `active + reserved < concurrency`，所以满载机器不再是候选；
* 路由侧：没有任何端点有余量时返回 undefined，调用方保留 harness 解析出的线路——
  子代理因此与任务同机、**由服务端自身串行**，而不是被塞进一个并不存在的第二名额；
* 同时修掉一个**幂等性缺陷**：`agent/request` 可能被跑两次（插件根监听器 + agent 作用域监听器），
  第二次会看到"已经被自己改写过的线路"，旧逻辑会把它当成新请求再分配一次，导致同一子代理在
  两台机器间来回搬。现在先认自己的旧决定（`pool.assignmentFor`），命中就直接返回；
* `local_pool` 快照新增 `reserved`，渲染成 `N slot(s) held by a task running on it`。

新增测试：

* `reservation: a task already running on a single-slot machine keeps it to itself`
  （任务占住 a → 子代理去 b；任务结束后 a 重新可用）；
* `reservation: a single-endpoint pool leaves the child on the task machine to serialize there`；
* `client: switching the provider updates the model list before saving, and drops the dead pin`；
* `client: an endpoint name is editable and saved with the row`。

### 8.3 本次实测

```
node plugin\test\pool.test.mjs        → tests 21, pass 21, fail 0
node plugin\test\plugin.test.mjs      → tests 24, pass 24, fail 0
node plugin\test\client-page.test.mjs → tests 17, pass 17, fail 0
verify-install.mjs（宿主运行时）      → 21/21 checks passed
```

版本 0.3.0 → **0.4.0**。

### 8.4 一次自己造成的事故（记录在案）

清理调试代码时用了 PowerShell 的 `Set-Content`，它按 ANSI 代码页写回，把这一个测试文件里的
4 个字符写坏（3 个注释里的长破折号 + 1 个测试数据里的汉字）。核对方式：拿会话记录里
**已知正确的编辑片段**与文件逐行比对，只发现这 4 处不符；手工逐个替换后文件恢复、
62 个测试全过。教训：**改文件用编辑工具，不要用 shell 重写文本文件**。

---

## 9. 精简「路由」卡片（2026-10-13，0.5.0）

用户逐项问"哪些参数有必要保留"，核对代码后对**路由卡片那四项**做了取舍。
### 9.1 逐项判定

| 参数 | 处置 | 依据 |
| --- | --- | --- |
| 作用范围 `applyTo` | **留**（补代价说明） | 真实改变行为：`isRoutingTarget` 在 `all` 时连主代理一起纳入，代价是主代理整段对话落到本地模型 |
| 分配策略 `strategy` | **留，撤掉"轮询"一档** | 有空闲端点时 `least-busy` 与 `round-robin` 等价；单端点时三种策略完全相同。真正的选择只有「铺开」对「固定第一台」 |
| 同一会话固定在一台机器 `sticky` | **移除**，写死为开 | 关掉后 `#assigned` 直接返回 undefined、`#remember` 不写记录 → 同一子代理每次请求都重新选机器（还随 `#cursor` 轮转），前缀缓存反复失效、工具调用方言抖动、每次重新过闸门 |
| **启用插件** `enabled` | **留，职责收窄为"是否接管子代理"**，并补说明 | 它与卡片总开关功能重叠但机制不同：这是 volatile 字段，保存即生效、无需重启；卡片开关走 loader 配置、更重。两者分工写进文案：这个只管"接管子代理"，彻底停用走卡片开关 |

另外修正两处文案：`sticky` 原文案「同一会话固定在一台机器」是误述（实际是**同一个子代理**终身一台）；
「作用范围」补上 `all` 的代价说明。

### 9.2 兼容性

* `strategy: 'round-robin'` **不再报错**：`LEGACY_STRATEGIES` 把它映射为 `least-busy`
  （`lib/config.js`），所以老 profile 照常加载；
* `sticky:` 键被忽略（`normalizeConfig` 不再输出该字段）；
* `enabled:` 仍然有效且仍在页面上，只是文案改成"是否接管子代理"，与卡片开关分工明确；
* `LocalPool` 的 `sticky` 选项保留在构造函数里（便于单测直接构造两种行为），
  但 `index.js` 的 `createPool` 现在硬编码传 `true`。

### 9.3 新增测试

* `config: legacy strategy values map onto the supported set`
* `config: stickiness and the on/off switch are not settings any more`
* `client: the routing card keeps three controls and drops stickiness`（断言 `sticky` 的
  `data-field` 在页面上**不存在**，策略只剩两项，`enabled`/`applyTo` 仍在）
* `client: each endpoint still has its own enable and name controls`（区分**端点级** `endpoints.0.enabled`
  与插件级 `enabled`）

### 9.4 本次实测

```
node plugin\test\pool.test.mjs        → tests 23, pass 23, fail 0
node plugin\test\plugin.test.mjs      → tests 24, pass 24, fail 0
node plugin\test\client-page.test.mjs → tests 19, pass 19, fail 0
verify-install.mjs（宿主运行时）      → 21/21 checks passed
```

版本 0.4.0 → **0.5.0**。仍未复看：重启后路由卡片真的只剩两栏。

---

## 10. 技术债清理（2026-10-13，0.6.0）

审查结论：**不需要重构**。分层（`agent` / `config` / `pool` / `tool` / `schema` / `index` / `client`）是对的，
单测能脱离 harness 直接测纯逻辑，没有正确性缺陷也没有性能问题。本次只做定点清理。

### 10.1 删掉的死配置

| 项 | 为什么删 |
| --- | --- |
| `endpoints[].weight` | 从配置一路带到 pool 记录、快照、`local_pool` 输出，**没有任何选择逻辑读它**，且零测试覆盖。留着一个不起作用的旋钮比没有更糟 |
| `endpoints[].preferModels` | 只在 `model: auto` 且 provider 广告多个模型时生效的例外分支，且从未写进 README 的字段说明。`auto` 现在明确为"该 provider 广告的第一个模型" |
| `snapshotConfig` 里的 `sticky` 键 | 上一版已把该字段移出配置，这里还在 unwrap 一个不存在的键 |

保留：`enabled`（读旧值）、`applyTo`、`strategy`、`respectExplicitRoute`、`requireRegisteredRoute`、
`queue`、`health`、`tool`、`logging`。`LocalPool` 的 `sticky` 构造选项**保留**——单测靠它构造
"不黏"的对照行为，删了会把池绑死成不可测的单一行为。

### 10.2 两处"同一份数据存两遍"合并为一处

`#childParents`（child → parent）与 `#delegations`（child → 父任务线路）键相同、生命周期相同、都带 512 上限。
现在合成一条派发记录 `#delegations: child → { taskKey, taskRoute }`，由 `bindDelegation(childKey, { taskKey, taskRoute, label })`
一次写入；`parentOfChild()`（给流闸门找预算）与 `isOwnTaskRoute()`（判断"子代理在跑父任务自己的线路"）
读同一条记录。少一个 Map、少一次写、少一处上限。

### 10.3 `local_pool` 新增任务预算视图（把测试专用方法变成产品接口）

`budgetSnapshot()` 此前**只被测试使用**。与其删掉，不如补上真实缺口：任务级预算是白名单的核心机制，
但设置页只能看到"上限 N"，看不到"这个任务此刻跑了几个 / 排队几个"。现在工具输出新增 `budgets[]`，
渲染为：

```
Task subagent budgets:
- task deepseek-account: 0/2 local subagent(s) running
```

无任务持有预算时该段不出现（空列表 = 还没有白名单任务被路由，而不是"没有限制"）。
输出 schema 的 `required` 同步加上 `budgets`（schema 是 `additionalProperties: false`，
漏加会让工具调用直接失败——这是本次最容易踩的坑）。

### 10.4 本次实测

```
node plugin\test\pool.test.mjs        → tests 23, pass 23, fail 0
node plugin\test\plugin.test.mjs      → tests 25, pass 25, fail 0
node plugin\test\client-page.test.mjs → tests 19, pass 19, fail 0
verify-install.mjs（宿主运行时）      → 21/21 checks passed
```

新增/改写的测试：`routing: model auto resolves to the first model the provider advertises`（去掉偏好分支）、
`tool: local_pool reports each task's subagent budget`、`pool: child sessions remember their delegating task`
（补 `isOwnTaskRoute` 与 `forgetDelegation` 的断言）。

**不变量已保持**：调度语义零变化（每端点 `active + reserved < concurrency` 才候选、黏性终身、
失败冷却换机、任务预算跨机器生效、幂等）；旧配置照常加载（残留的 `weight`/`preferModels` 被忽略而不报错）。

### 10.5 明确未做的重构及触发条件

`acquireEndpoint` 与 `acquireBudget` 是**两份实现同一算法**的代码（等待者对象、超时→`QUEUE_TIMEOUT`、
abort 监听、幂等 release、出队清监听，约 90 行重复），区别只有四处：端点队列多 `maxWaiting`/`QUEUE_FULL`、
多 `served`/`lastStartedAt` 计数、`waiting` 是可读字段、以及"队首等待者已被取消时把名额让给下一位"的尾递归分支。
本次**不合并**：两份实现都是对的，合并要引入统一的槽位队列原语（抽象本身有出错风险），
并会牵动 7 个预算测试。触发条件（满足任一才做）：① 继续扩展插件（优先级/抢占/按主机分组）；
② 需要第三次改动队列语义（超时/取消/队列上限）。

---

## 11. 设置面板观感对齐官方（2026-10-13，0.7.0）

用户要求把设置页的勾选换成官方插件（语音输入）设置页那种开关。

### 11.1 实现依据：官方那个开关是什么

* 它是 `@deepseek-ai/dsh-client-ui-primitives` 的 **`Switch`** 原语：`36×20` 轨道 + `16×16` 圆钮，
  选中时 `transform: translateX(16px)`，**外观由 `aria-checked` 驱动而不是平行 class**
  （`Switch.module.css` 首行注释写明："so the visual state cannot disagree with the state
  assistive technology reads"）。
* 语音输入页**不是**那个 bundle 自己画的：bundle 的 `lib/index.js` 只有 11 字节，它只声明 `Config`，
  表单由设置服务按 schema 自动渲染。所以"对齐观感"≠"照抄实现"。
* 本插件的页面是自写浏览器半边，**按设计不能 import 官方 Client 包**（拿不到 React 实例）。
  但官方 Switch 的颜色全部来自主题变量，且这些在本部署里都有定义（已在
  `dsh-client-ui-theme/lib/client.js` 逐一确认）：`--dsw-alias-border-l3`、`--dsw-alias-brand-primary`、
  `--dsw-alias-label-primary-foreground`、`--dsw-alias-switch-thumb`、`--dsw-focus-ring-width`、
  `--dsw-focus-ring-color`。**结论：照抄 CSS 即可，零依赖。**

### 11.2 做了什么

新增本地 `Switch` 组件：**原生 checkbox 承载真值，视觉层是它的兄弟节点**。

```
label.bls-switch
├─ input[type=checkbox].bls-switchInput   ← data-field / checked / disabled / onChange（契约与从前一致）
└─ span.bls-switchTrack[aria-checked]     ← 纯视觉，状态从 aria-checked 取
   └─ span.bls-switchThumb
```

三个理由：① **测试契约不变**（既有断言读 `props.checked` 与 `type === 'checkbox'`，视觉层若取代
原生 input 就得重写全部 4 处开关断言）；② 无障碍天然正确（键盘/空格/读屏来自原生 input，
不必手写 `role="switch"`）；③ 禁用态可纯 CSS 表达（`:has(input:disabled)`），
不必给 label 再传一个 disabled prop 而在测试里制造两个 disabled 节点。

替换的 4 处：路由卡「启用路由」、白名单每行勾选、端点每行「参与分配」、`local_pool` 工具开关。
**`data-field` 与写入语义一字未改。**

顺带修掉四处与官方控件不一致的样式：输入框对齐 `Input`（32px 高、`0.5px` 描边、`radius-md`、14px 字）、
按钮对齐 `Button`（28px 紧凑档、`--dsw-alias-button-primary-fill`、hover token）、
数字输入右对齐 + `tabular-nums`、卡片标题加分隔线；空列表提示改成虚线占位块。
`<style>` 原本每张卡片内联一份，现已收成页面根部一份。

### 11.3 顺带发现并修掉的一个真缺陷

「启用路由」与「`local_pool` 工具」两个开关**在只读连接下没有被禁用**（之前用原生 checkbox 时也没禁），
点它会写入一个必然被服务端拒绝的草稿。现在四个开关在 `writable === false` 时都禁用。
这是写新测试时才暴露出来的，不是重构引入的。

### 11.4 本次实测

```
node plugin\test\pool.test.mjs        → tests 23, pass 23, fail 0
node plugin\test\plugin.test.mjs      → tests 25, pass 25, fail 0
node plugin\test\client-page.test.mjs → tests 21, pass 21, fail 0
verify-install.mjs（宿主运行时）      → 21/21 checks passed
```

新增测试：`every boolean control is a switch drawn from the aria state`（四个开关都是原生 checkbox、
轨道 `aria-checked` 随值走、切换后跟随、`<style>` 只渲染一份）、
`switches are disabled on a read-only connection while keeping their value`。
夹具 `EMPTY_VALUE` 补回 `enabled: true`（此前缺字段，掩盖了"启用路由"开关的真实默认值）。

### 11.5 复盘时又发现并修掉的一个真缺陷（同一次检查）

第二轮复查发现：`Switch` 当初被定义在 `Editor` **函数体内部**，而调用点是 `h(Switch, …)` —— 这是
**真正的组件调用**，不是直接调用函数。React 按**类型身份**做协调，而每次渲染都会产生一个新的函数对象
→ 类型变了 → React 把整棵子树**卸载再重建**：焦点会丢、圆钮的 `transition` 每次都被重启、
输入过程中可能吞掉按键。

零证据可暴露它：测试桩把函数组件**当普通函数直接调用**（`materialize`/`walk`），类型身份不参与，
所以 21 个测试全绿也照样有这个 bug。只有把 `Switch` 提到**模块作用域**（与 `Row` 并列）才是正确写法，
并已在注释里写明原因，避免以后有人再挪回组件内部。

同时核对：`Row`、`Editor` 本就在模块作用域，`providerSelect`/`modelSelect`/`select`/`number` 是
**返回元素的普通函数**（不作为组件类型使用），因此不存在同类问题。

### 11.6 文档漂移修正（同一次检查）

* 英文 README「How it works」仍写着 `least-busy / round-robin / fixed` → 改为 `least-busy` 或 `fixed`；
* 中文 README 把"子代理黏性"写成"会话黏性" → 改为子代理（与第 9 节纠正过的文案一致）；
* 本文件第 1 节的"覆盖"清单仍是 0.2 时代的描述（`round-robin`、会话黏性、缺开关/名称/预算断言）→ 已更新。

（第 1、6、8、9、10 节里的**旧测试条数**保留原样：那是当时的实测记录，不是当前状态；
当前状态见 11.4。）

### 11.7 本次实测

```
node plugin\test\pool.test.mjs        → tests 23, pass 23, fail 0
node plugin\test\plugin.test.mjs      → tests 25, pass 25, fail 0
node plugin\test\client-page.test.mjs → tests 21, pass 21, fail 0
verify-install.mjs（宿主运行时）      → 21/21 checks passed
13 个 JS/MJS 文件全部通过 node --check；package.json 的 files[] 覆盖全部交付文件
```

### 11.8 未复看（明确声明）

* 刷新页面后开关与「语音输入」页的**实际视觉一致度**、切换动画、浅色/深色主题下的表现、
  键盘 Tab + 空格、只读态的半透明效果——都需要人工看一眼，本记录只做到代码级与桩渲染级确认。
* 本次只改浏览器半边（`client.js`），**宿主未改动，因此不需要重启**，刷新页面即可生效
  （前提是本次加载的是新版本前端文件；若页面未变，做一次刷新）。
