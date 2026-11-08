# 主智能体：一个默认干活的智能体，语音直接交给它，它能操作整个系统（设计）

2026-10-17 · Ethan：语音输入没有对应的设置入口（其实在 设置 → 通用 → 语音输入，太隐蔽）；语音说完要交给一个模型处理。要有一个
主模型——配了那么多模型，可以把某一个设为整个 Ruyix 的主模型；任何一个智能体都可以设为主智能体，我问话、我做什么，缺省都交给它，
包括整个系统的操作（比如让它装个东西、做件事），直接语音就行。它做了之后，要有一个专门的地方或 widget 显示这些——主智能体的工作记录。

他定的（2026-10-17）：

- **主智能体**：池子里任何一个智能体都可以（dsh 的、Claude Code、Codex、pi）。对话、⌘K、语音默认都交给它；对话框顶部可以**临时换**，
  只对这次对话有效。
- **主模型**：单独一个配置，**平时跟主智能体一致**，需要时可以分开（比如小活用更便宜更快的）。Ruyix 自己的小活用它：给对话起标题、
  做摘要和记忆、整理语音文字。
- **语音**：不在输入框里时，按住右 ⌥ 说的话**直接交给主智能体**——冒一个「听到：…」的气泡，2 秒内可以取消；在输入框里照常打字。
- **权限**：**能撤销的直接做**（装软件、打开应用、启动工作流和任务、改桌面、改语音设置），记进工作记录并附撤销；撤销不了或对外的
  （删除、对外发布、发消息、花钱）先出卡片，人点了才做。

## 现在是什么样（盘点，2026-10-17）

- 「默认」有三个互不相连的设置：智能体页的默认智能体（只能是 dsh 的，`defaultDsh`），对话框自己的选择（`assistant.json`），
  设置 → 模型的默认模型（dsh 的 `agent-default-model`）。
- 语音只变成文字：打进输入框，或者填进 ⌘K 等人按回车（`desktop.jsx` toPalette）；从不交给模型或智能体。
- 对话已经能用 Claude Code / Codex / pi 回答（CLI 线），但只读、只有工作台的工具（MCP `ruyix-workbench`）；桌面、应用中心、设置的工具一个都没有。
  应用中心的安装只有页面在用。
- `conversations.db` 已经记下每一轮、每次工具调用（带智能体）、后台任务——工作记录的底子。小组件由插件推进 `__ruyixWidgetDefs`。

## 设计

### 1. 主智能体和主模型（agent-hub）

- hub 配置加 `main: { agent, model }`。`agent`：池子里任何智能体的 id（不限 dsh）。`model`：`null` = 跟主智能体一致；或一个模型引用
  （`dsh:<provider>/<model>`、`<endpoint>:<model>`、`<connection>:<model>`，和工作流的模型步骤同一种写法）。
- 服务接口：`agentHub.main()` → `{ agent, model, resolved: { agent, model, how } }`；`setMain({ agent?, model? })`。
  ops：`mainGet`、`mainSet`。原来的 `defaultAgent`（临时任务的 Lead，必须是 dsh）不动。
- 没设过时：取对话现在用的那个（`assistant.json` 的 agent/model），再不然取默认智能体——升级后人什么都不用做，行为不变。
- 主模型「跟主智能体一致」怎么解析：主智能体是 dsh 的 → 它的模型；是 CLI 的且挂了接入点 → 接入点上的那个模型（直接调用）；
  都不行 → dsh 的默认模型，并在设置里写明「主智能体是命令行智能体，小活用的是…」。
- 设置里的位置：**设置 → 通用** 最上面一张卡片「主智能体」：主智能体（下拉：池子里的智能体，按运行时分组）、主模型（跟主智能体一致 /
  选一个）、一句说明它管什么。智能体页上主智能体旁边标「主」。

### 2. 对话跟着主智能体，可以临时换（workbench assistant）

- 对话的线路由 `agentHub.main()` 决定；`assistant.json` 只存这次对话的**临时选择**（`override: { agent | model, thread }`），
  换了新对话（空闲后换新、或点「新对话」）就失效，回到主智能体。
- 对话框顶部的选择器：默认显示「主智能体（名字）」；选别的就是临时换，旁边出「回到主智能体」。
- 标题、摘要、记忆、整理语音文字用主模型（`agentHub.main().resolved.model`）。

### 3. 系统工具（shell 上的注册表，主智能体在两条线上都能用）

- `ruyixShell.systemTools`：各插件注册工具 `{ name, title: {zh,en}, description, parameters, effect: 'read' | 'undoable' | 'card',
  run(args, who) → { text, summary: {zh,en}, undo?: { tool, args } } }`。
- 第一批：
  - 应用中心（apps）：`apps_list`（read），`apps_install`（undoable：撤销 = 卸载）、`apps_uninstall`（undoable：撤销 = 再装上；2026-10-17 加，nookbox 0.5.11 起能从 box 里卸），
    `apps_open`（undoable：在页面上开窗口，经对话的「页面动作」通道，和 workbench_show 同一种）。
  - 桌面（shell）：`desk_get`（read），`desk_set`（undoable：走 changes 日志，由主智能体直接 apply，`by: 主智能体（应你的话）`，撤销 = changes undo）。
  - 语音（shell）：`voice_get`（read），`voice_set`（undoable：写 voice.json 前留旧值）。
  - 工作台（已有）：启动运行、任务排期——原来「只在人明说时直接做」的那几个算 undoable（撤销 = 停止 / 删除排期），起草类照旧出卡片。
- 对话把注册表里的工具加进 allTools：dsh 线直接注册，CLI 线经 MCP `ruyix-workbench`（工具在主机上执行，CLI 智能体本身仍是只读、没有 Bash）。
- 规则写进主智能体的说明（brief）和一个 skill `ruyix-system`：人明说要做的、能撤销的直接做；撤销不了或对外的用卡片；做完一句话说清做了什么。
- 只有**主智能体**（以及临时换上的那个）在对话里拿到 undoable 工具；工作流步骤里的智能体拿不到。

### 4. 工作记录

- 每次 undoable / card 工具调用在 `conversations.db` 记一条 `action`：`{ tool, summary, by (agent), at, undo, undone }`。
  op `actions`（最近的、某条之后的），op `undo { id }`（执行它的 undo 工具，记一条撤销）。
- 语音也记：`heard`（听到的文字、是否取消）。
- 桌面小组件「主智能体」（`main:agent`，sm / md）：现在的状态（空闲 / 在听 / 在想 / 在做：哪个工具）、最近几件做了的事（每件一行，
  能撤销的有撤销），最后一次听到的话；点开 → 对话页。对话页顶部也有同样一条「刚才做了」。

### 5. 语音直接交给主智能体（页面）

- `desktop.jsx` 的 toPalette 换成：有字 → 气泡「听到：…」（2 秒，可取消，可点一下立刻发）→ `ask(text, { via: 'voice' })`（chat-state 的 ask，
  直接 chatSend，不经 ⌘K）。对话框没打开时不弹出整个对话框：气泡变成「主智能体在做…」，做完的结果进小组件和右下角通知。
- 在输入框里：照旧打字。

## 做了什么、以后再做（2026-10-17，合入前的独立复查之后）

做了：主智能体和主模型（agent-hub、设置 → 通用、智能体页的标记和「设为主智能体」）；对话跟着主智能体、可临时换（新话题或空闲后回到主智能体，
回答中不换线，CLI 线回答时来的消息排队）；系统工具注册表和页面动作；桌面（desk_get / desk_set / desk_undo）、语音设置（voice_get / voice_set）、
应用中心（apps_list / apps_install / apps_open / apps_close）；工作记录（对话里的 action 条目、撤销、新会话会被告知做过什么）；
语音直接交给主智能体（气泡 2 秒可取消，新的一句取代没发出的旧一句）；桌面小组件「主智能体」。

以后再做（还没有）：`ruyix-system` skill（现在只有对话说明里的规则）；工作台的启动运行和排期改成带撤销的直接操作；
小组件的「在听 / 在想 / 在用哪个工具」；对话框没开时做完后的右下角通知；CLI 主智能体挂了接入点时用接入点上的模型做小活；
用主模型整理语音文字；删除主智能体时告诉人退回了缺省智能体。

## 分工和顺序

- 先 1（agent-hub + 设置卡片 + 对话跟随），再 3+4（工具注册表、应用和桌面的工具、工作记录），再 5（语音）和小组件。
- 文件归属：agent-hub 是 workspace-ce 最近改的，对话、桌面、工作台是 workspace-15 的——动之前先说好（见会话消息）。

© 2026 Ethan H.B. Zhou
