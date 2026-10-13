# 本地算力池 · Local compute pool

一个 **DeepSeek Harness 插件**：把多个本地推理端点并成一个池，让被委派的子代理（subagent）按负载铺开到不同机器上，
每个端点有独立的并发闸门与排队，失败自动冷却换机；所有本地端点都不可用时，子代理保持原线路继续跑。

* 包名：`dsh-local-compute-pool` ｜ 卡片名：**本地算力池** / *Local compute pool*
* 分发形态：**裸目录束**（不是 npm 包）——克隆本仓库后按下面的绝对路径方式安装
* 许可：MIT

---

## 它解决什么

本地部署的模型有三个现实约束，这个插件的每个机制都对应其中之一：

| 现实约束 | 本插件的做法 |
| --- | --- |
| 显存/内存有限，通常一次只能服务一个会话 | 每个端点一个**并发闸门**（默认 1），同时最多放行 `concurrency` 个请求，其余排队（有上限、有超时） |
| 上下文缓存能力弱 | 每个子代理**终身黏在**一台机器上，前缀缓存与工具调用方言保持稳定 |
| 不擅长多发并行 | `least-busy` 策略把子代理铺开到不同机器，而不是堆在一台后面排队 |

核心不是"跑得更快"，而是**让"多派几个子代理"这件事在本地模型上从不可用变成可用**：本地服务收到两个并发请求时
往往不是各慢一半，而是双双超时或把显存打爆。

---

## 前置条件

* DeepSeek Harness 桌面端（本插件在 `0.2.0-rc.2` 上开发与验证）。
* 已经在 `llm-pi-ai` 里配好**至少一个**本地 OpenAI 兼容 provider（例如 `local` → `http://127.0.0.1:8888/v1`）。
  插件不自己发 HTTP、不新增 provider，只负责"选谁 + 排队"。

## 安装

克隆本仓库：

```
git clone https://github.com/suanlv/dsh-local-compute-pool.git
```

然后用插件管理器安装 `plugin` 目录的**绝对路径**：

```
plugin_manager  action: install_bundle
                target: <克隆下来的仓库目录>\plugin
```

安装后：

* 包会加入 profile 的 `dsh.profile.bundles`，本仓库 `plugin/cordis.patch.yml` 作为一层 patch 插入插件行；
* **新装的 bundle 可以热生效**；若提示 `restart-required`，重启 Harness 桌面端；
* 之后改 `cordis.patch.yml` 的 `config` 会被 HMR 实时重载；**改 JS（`index.js` / `lib/*` / `client.js`）需要重启**
  （浏览器半边刷新页面即可）。

卸载：`plugin_manager action: remove_bundle target: dsh-local-compute-pool`。

## 第一次使用

1. **添加端点**：侧栏 **插件(Plugins)** → 卡片 **本地算力池** → 「子代理模型池」→「＋ 添加本地端点」，
   `provider` 从实时目录里选，`模型` 选 `auto`（该 provider 广告的第一个模型）或精确 id，
   `并发` 填该机器能同时服务几个请求（单会话本地服务填 1）。
   **出厂端点列表是空的**：指向别人机器上不存在服务的默认值只会失败，所以不预设。
2. **决定谁能用本地算力**：「触发白名单」里勾选 provider——只有**任务自身的模型**跑在这些 provider 上时，
   它派生的子代理才会落到本地池；白名单为空则表示"不限制"。每行旁边的数字是该任务的子代理并行上限，
   它会写进该任务的提示词，并且在网关处**真实限流**（跨机器也算同一个任务的账）。
3. **验证**：一条消息里起两个 subagent，它们应当落到不同端点上；或在模型里调用 `local_pool` 工具查看
   每台机器在跑几个、排队几个、哪台冷却中、每个任务持有多少子代理预算。

## 已知边界（请先读这一节）

* **只管子代理**。默认 `applyTo: children`：主代理保持自己的模型。改成 `all` 会让主代理**整段对话**落到本地模型，
  工具调用能力取决于那个模型本身。
* **不自己发 HTTP，也不做重试**。请求走你在 `llm-pi-ai` 里配好的 provider；重试由 `dsh-llm-retry` 负责，
  插件只是在每次重试经过时重新选端点（这正是失败后能换机器的原因）。
* **它不认识"设备"，只认识 provider id**。当前所有端点都是 `127.0.0.1` 形态；远端那台靠端口转发/隧道到达。
  插件**不区分"同一台机器的两个端口"与"两台机器"**，也没有设备发现、远端传输、集群成员或认证。
* **不做跨机协作**：没有会话迁移、没有跨机缓存共享、没有分布式状态。每个子代理的世界就是它黏住的那台机器。
* **不做通用负载均衡**：决策粒度是"子代理"，不是"请求"。
* `concurrency` 是人工声明值，插件无法探知服务端真实并发能力；填大了会把本地服务压垮。

## 配置

完整字段表见 [plugin/README.md](plugin/README.md)（中文）与 [plugin/README.en.md](plugin/README.en.md)（English）。
出厂 `plugin/cordis.patch.yml` 里每一项都有注释。

## 测试

`plugin/lib/` 只依赖 Node 标准库，没有依赖、没有构建步骤。

```powershell
node plugin\test\pool.test.mjs          # 23：端点池：选择/黏性/排队/冷却/任务占位
node plugin\test\plugin.test.mjs        # 25：宿主半边接线：路由改写、并发闸门、白名单预算、工具输出
node plugin\test\client-page.test.mjs   # 21：浏览器半边：设置页渲染、开关控件、写操作
```

装后自检（模拟宿主解析一遍：登记 / 入口 / `Config` / 客户端标识符 / locale 信封 / 补丁行 id / 工具注册）：

```powershell
# 建议用宿主自己的运行时跑，这样 app.asar 里的模块才解析得到
$env:ELECTRON_RUN_AS_NODE='1'
& "<安装目录>\DeepSeek Harness.exe" tools\verify-install.mjs

# 纯 node 也能跑，但 Config 那条会如实报"读不了 app.asar"
node tools\verify-install.mjs
```

`tools/probe-asar-import.mjs` 用来证明"Electron 的 Node 能 import app.asar 里的模块、纯 Node 不能"——
这是设置页能否出现的前提条件，也是本插件排错时最容易误判的一点。

## 开发说明

* 宿主半边（`plugin/index.js`、`plugin/lib/*`）改完**必须整代重启**：模块按 URL 缓存，只改文件名会造成
  "新入口 + 旧 lib"的混合世代。
* 浏览器半边（`plugin/client.js`）是静态文件，刷新页面即可换新。
* 用 `plugin_manager` 安装/卸载，不要手改 profile 的 `package.json`。

## 出处

本插件最初为作者自己的一台开发机而写（两台本地端点 + 一个云端主代理），
经过多轮修正才形成现在的形态。开发过程中的命名决策、逐版验证记录与设计取舍
保存在作者的工作区，不在本仓库内。
