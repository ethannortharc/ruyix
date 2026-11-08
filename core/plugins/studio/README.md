# @ruyix/studio — 工作室

把一件端到端的事从整个系统里拎出来串成一条线：想做什么（记录）、怎么做（工作流）、用什么做（素材、设定）、做成了什么（它的运行），
有它自己的首页。设计见 [docs/design/studio.md](../../../docs/design/studio.md)。

一个工作室主要是一份**声明**，由包注册（Plume 的在 `packs/plume/studio.js`）：

| 部分 | 说明 |
|---|---|
| `collections` | 它管的几类记录：每类一组字段（`text`、`textarea`、`number`、`bool`、`select`、`status`、`date`、`datetime`、`color`、`links`、`tags`、`image`、`ref:<另一类>`），或者 `runs: '<工作流>'`（它的运行，工作台的，不在这里存） |
| `start` | 从一条记录开始工作流：标题、正文、字段从记录里取；开始时、做完时、没做成时记录的状态改成什么 |
| `home` | 首页分哪几块：`start`、`working`、`list`、`board`、`calendar`、`library`、`form`、`history`，或它自己的 `own:<名字>` |
| `seed` | 第一次的记录（只做一次），比如把包原来的设置搬成第一个账号 |
| `remind` | 到点提醒：某类记录的一个时间字段到了、状态还不是「做完了」的那几种，就在桌面「正在做」里挂一条「等你」（还没开写 / 还在写 / 写好了去发布），擦掉就不再提这个时间 |

声明不对时注册就失败，并说清楚错在哪（`plume.collections.ideas.x: no field type rating`）。

`start.allowedStatuses` 可限定哪些记录状态允许启动，例如 Plume 只接受 `['idea']`。首页、编辑表单和服务端都会检查，已完成或已放弃的选题不会自动重新开始。`start.showForm: true` 让顶部开始按钮先打开完整表单，保留已填标题，以便选择账号、平台和材料后再启动。

## 数据

- 每个工作室一个 SQLite 文件：`~/.ruyix/studios/<id>/studio.db`（`RUYIX_STUDIO_HOME` 可改）；人加的素材在旁边的 `materials/`。
- 每次改动留下改之前的版本；删掉的只是标记，能找回。
- 一次运行属于哪个工作室、哪条记录，记在运行上（`run.studio = { id, collection, record }`）；一条记录做过哪些运行是查出来的，不另存。工作流所属包可指定默认工作室，普通或定时启动时保存无记录的 `run.studio = { id }`；从明确选择的工作室启动时保留该工作室 id。同一个工作流可用于不同工作室，声明引用本身不会接管它的默认归属。
- `ruyix data export` 带上它们。

## 接口

- 服务 `ruyixStudio`（给包和工作台）：`register(声明)`、`studios()`、`list`、`get`、`put`、`remove`、`start(studio, startId, recordId)`、`onRunEnd(run)`、`onChange(fn)`。
- `/api/ruyix-studio`（给页面，`src/data.js` 包好了）：`useStudios`、`useStudio`、`useCollection`、`useMaterials`、`start`、`history`；
  每次改动一个 `ruyix:studio` 窗口事件。`window.__ruyixStudios` 是现有的工作室（名字、图标），给不引用这个插件的地方用。

## 页面

- 每个工作室一个页面 `ruyix-studio-<id>`，在导航「应用」一组里；地图上它是一个村子（名字是工作室的名字），点开就是这个页面。
- 首页按声明的 `home` 排，两块一行（`full` 的独占一行）：开始（一句话写下要做的就开始，或「更多设置…」填全）、在做（「正在做」里这个工作室的那几条）、
  看板（按状态分列，拖到别的列就改状态）、列表（记录，或它的运行：点开看结果）、日历（按日期或时间，拖到别的日子保留钟点）、素材（拖进来或上传，点开用查看器）、
  表单（左边记录、右边改）、历史（工作台的记录，只看这个工作室的）。
- 改一条：每个字段按类型给输入；存的时候工作室说哪里不对，就标在那个字段下面；删掉的能撤销；「改动记录」能拿回之前的一版。
- 桌面「正在做」里工作室的活带着工作室的名字（`window.__ruyixStudios`）。

## 主智能体

`lib/tools.js` 挂在 shell 的系统工具上：`studio_list`、`studio_items`（只看）；`studio_put`、`studio_remove`（马上做，能撤回）；
`studio_start`（人明说开始才用）；`studio_create`（按人描述的建一个他自己的工作室，存成 `<home>/<id>/studio.json`，启动时加载；
撤回就是拿掉，记录留在文件夹里）。什么时候用哪个，写在主智能体的技能里（`core/shell/skills/ruyix-system`「Studios」一节）。

## 检查

`node check.mjs`：声明的检查、各类字段的值、版本和找回、只做一次的第一批记录（Plume 的设置搬成账号）、从记录开始工作流和状态跟着走、
运行列表、素材。

© 2026 Ethan H.B. Zhou

## 评分与持续改进

每个 Studio 首页有「评分与创作偏好」：选择运行和可评价步骤，给 1–5 分、写具体意见，并可选择下一次的表达方向。最终结果和中间步骤绑定独立版本；结果在查看后变动会拒绝旧评分，重复保存同一版本只保留一条有效评分。评分保存在工作室自己的 SQLite 数据库，撤回后立即重新计算，旧事件保留审计。

偏好按工作室、实际工作流、账号 / 编辑设定和步骤隔离。星级本身不会被猜成文风；明确选择在两个不同项目获得一致确认后才提升为默认，近期确认的权重更高，冲突保留待观察。最近的文字意见作为有范围的参考数据带入后续生成，当前请求和质量 / 审核要求优先。新运行保存 `run.studioPreferences` 快照，保证后来的评分不会改变正在运行的任务。暂停学习会保留评分但不注入偏好或意见。这是可解释的反馈记忆与提示词调整，不是模型权重训练。

工作流可声明 `feedbackConsumers: { review: ['draft'] }`，把审阅或渲染阶段的反馈交给下次负责生产的智能体步骤；评分和快照保留原始步骤，不改写历史数据，也不会扩大到无关步骤。Video 的时间线 / 预览 / 成片反馈用于辅助剪辑方案；手动初稿不消费创作偏好，需要开启「智能体辅助剪辑方案」。

引擎在文件编辑、重渲染快照和审阅修订快照后递增 `contentRevision`，评分指纹包含这个内容检查点及审阅版本。即使 Git 不可用或大文件未进入 Git，也会保守地要求重新查看再评分；相同内容再次保存可能使旧评分表单过期。

工作流通过 `preferenceOptions` 声明兼容选项；Newsletter 允许详略和表达，Video 另外允许节奏和字幕，Plume 另外允许来源展示。自定义工作室按运行的实际工作流展示并校验选项，自定义工作流继承基础流程的声明。学习快照只包含同一工作流 id 的评分和文字意见，不跨流程混合。旧评分缺少工作流字段时，只通过仍可读取的原运行确认归属；无法确认的记录保留在历史中，不参与学习。

服务新增 `preferences(studio, { profile?, workflow? })`、`feedbackView(studio, run?)`、`rate(studio, input)`、`removeFeedback(studio, id)`、`setLearning(studio, enabled)`；API 对应 `feedback`、`rate`、`removeFeedback`、`learning`。评分接口只向人的页面开放，没有把“给自己评分”工具注册到智能体。

`file` 字段支持从素材库选取一般文件，可 `multiple: true`；开始运行时作为附件复制。浏览器上传仍为每个文件 25 MiB；Video Studio 的本地目录路径适用于较大素材。

`node feedback-check.mjs` 检查版本绑定、跨工作室拒绝、真实 SQLite 持久化与迁移、评分撤回、重复权重、编辑设定 / 工作流隔离、自定义工作室选项、旧评分归属、暂停，以及两项目评分经真实引擎快照进入 Video / Newsletter 实际生产提示词。
