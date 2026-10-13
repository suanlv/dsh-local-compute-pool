# 更新记录

版本号跟随 `plugin/package.json`。每次改动都会：跑完三个测试文件、更新 `plugin/README*.md` 的字段说明、
并把验证记录追加到 [plugin/VERIFICATION.md](plugin/VERIFICATION.md)。

> 文档与仓库结构的改动不单独占版本号。例如仓库页面的多语言结构（英文为主 + `README.zh.md`、
> 官方 `kind` 取值、`docs/DESIGN.en.md`）与"为什么是裸目录束而不是 npm 包"的说明，
> 都记在下面的 0.7.0 之后，因为 `plugin/` 里的代码没有变化。

## 文档与仓库结构（0.7.0 之后，未改变版本号）

* 仓库页面改成官方风格的多语言结构：`README.md` 英文（GitHub 落地页）+ `README.zh.md` 中文，内容对等；
  四份 README 统一加 YAML frontmatter 与语言切换行；`plugin/README*.md` 与 `docs/DESIGN*.md` 互为镜像。
* frontmatter 的 `kind` 采用官方取值：根 README 用 `package-bundle`（与 `dsh-experimental-voice-input-bundle`
  同类），`plugin/` 与 `docs/` 的说明用 `package-reference`（与 `dsh-schedule` 同类）。
* 新增 `docs/DESIGN.en.md` 英文设计说明。
* 新增「分发方式」一节（两份 DESIGN），说明为什么做裸目录束而不发布 npm；
  安装章节开头也写明"两步、不需要 npm、不需要构建"。
* 修复 `plugin/README*.md` 指向私有工作区 `NAMING.md` 的死链（改为指向本文件）。

## 0.7.0

设置面板观感对齐官方插件：

* 四处勾选（启用路由 / 白名单每个 provider / 端点「参与分配」/ `local_pool` 工具）改为**官方同款开关**：
  36×20 轨道 + 圆钮、状态由 `aria-checked` 驱动、颜色取自同一套主题变量，跟随明暗主题。
  真值仍由原生 checkbox 承载，因此键盘（Tab + 空格）与读屏语义不变。
* 输入框 / 按钮 / 数字框尺寸与描边对齐官方 `Input` / `Button`；`<style>` 从"每张卡片一份"收成页面一份。
* **修复**：只读连接下"启用路由"与 `local_pool` 开关没有被禁用（会写入必然被拒绝的草稿）。
* **修复**：`Switch` 曾定义在 `Editor` 组件内部，React 每次渲染都会重建该子树（焦点丢失、动画重启）。
  已移到模块作用域。

## 0.6.0

技术债清理（审查结论：不需要重构）：

* 删除两个从未生效的配置：`endpoints[].weight`（无任何选择逻辑读取）、`endpoints[].preferModels`
  （只影响 `auto` 且 provider 广告多个模型的边缘情形）。`auto` 现在明确为"该 provider 广告的第一个模型"。
* 「子 → 父任务」的两份重复映射合并为一条派发记录，`parentOfChild` 与 `isOwnTaskRoute` 读同一份。
* `local_pool` 新增**任务预算视图**：每个持有预算的任务单列一行（`task <provider>: 1/2 running`），
  补上"设置页看不到任务级并行"的缺口。
* 调度语义零变化；旧配置照常加载（残留的被删字段被忽略而不报错）。

## 0.5.0

精简设置页「路由」卡片：

* 移除"同一会话固定在一台机器"——黏性是池的设计约束（同一个子代理终身一台），不是偏好，现写死为开。
  关掉它会让同一子代理每次请求都重新选机器，前缀缓存反复失效。
* 撤掉"轮询"这一档：有空闲端点时它与"按负载"等价，单端点时三种策略完全相同。旧配置里的 `round-robin`
  会被映射为 `least-busy`，不会报错。
* "启用插件"收窄为"启用路由"，并说明与卡片总开关的分工。
* 修正"作用范围"缺少代价说明。

## 0.4.0

修复两个使用中暴露的问题：

* **设置页**：改 provider 后模型列表要保存才刷新（且会沿用旧 provider 的 model id）；
  端点名称不可编辑。三处根因分别是按已保存值算选项、没有 label 输入框、改 provider 时没重置 model。
* **白名单与算力池重叠时，任务会给"自己"派子代理**：任务自身的请求现在也**真实占用**该端点的一个名额
  （`LocalPool.hold`），因此 `concurrency: 1` 的机器只留给任务本身，它的子代理去别的端点；
  池里只有这一台时子代理保持继承线路，由服务端串行。
* 顺带修掉 `agent/request` 被重复执行导致的**子代理在两台机器间来回搬**（幂等性缺陷）。

## 0.3.0

* 更名：`dsh-better-local-support` /「更好的本地推理支持」→ `dsh-local-compute-pool` /「本地算力池」。
* **修复**：`locale/*.json` 此前是平铺的 `{"title": …}`，而官方加载器只读 `{"meta": {"title": …}}` 信封，
  导致卡片标题一直回退显示成原始包名。改用官方信封后中英标题才真正生效。
* 移除 `package.json` 里自造的 `meta` 字段（它不在显示链路上，容易误导后来人）。

## 0.2.0 及更早

* 白名单（触发 provider + 每任务子代理并行上限）与任务级预算的真实限流。
* 队列准入（`QUEUE_FULL` / `QUEUE_TIMEOUT`）、失败冷却与自动换机、`local_pool` 状态工具与 `probe` 探活。
* 浏览器半边设置页：两个列表 + 路由/失败/准入三组标量，原子保存（按 revision 围栏）。
