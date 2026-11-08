# Creator Studios：实现与验证

Video Studio、Newsletter Studio、Plume 优化及共享评分/偏好循环已在隔离分支实现。**第五轮四路 Claude Opus 5.5 / xhigh 审查均已 PASS、未关闭问题为 0；同一冻结提交的 59 项构建与检查全部通过。**

冻结源码：`dd292c8ff43e4260adb1bb575b981bc070a87cc7`；工作树 `ruyix-creator-ready`，分支 `codex/creator-studios-ready`。已整合 main 的明确快照 `2aa92cfc448c81d27b8ae82eb088ef597926a5ab`；其后 main 不在本次范围。没有修改另一 session 的主工作目录、已安装产品或用户数据，也尚未部署。

- 完整 gate：**59 项通过，exit 0，无顶级或已知内部 skip**，包含实际登录浏览器检查。
- 独立交叉审查：**Video、Newsletter/feedback、Plume、shared boundaries 全部 PASS，findings 均为空**。已核对实际模型、xhigh 启动参数、完成结果及源码哈希。
- 源码读取证据：**60/60 个必需文件、2,251/2,251 条必需行**；本轮 22 条修复代码均有直接读取证据。读取覆盖与语义审查分别记录。
- 当前冻结提交的 **25 MiB 浏览器上传复测通过**。30 分钟 1080p60 媒体模块验证及其版本边界见下文。

## 已实现的产品路径

| 工作室 | 能力与审核边界 |
| --- | --- |
| **Video** | 本地素材探测/来源哈希 → 可编辑时间线及审核 → 可播放预览及审核 → MP4 导出及成片审核。支持裁切、重排、增删、速度/音量、contain/cover、横竖方画幅、外部提供的软字幕 与 VTT。保存、预览和导出审批对应同一媒体版本；首尾选点不能成立时明确报错。 |
| **Newsletter** | 选题、受众、时间范围、编辑设定、链接/文档 → 来源捕获和去重 → 提纲 → 引用正文 → 独立证据核查 → 人工审阅 → Markdown、纯文本和 HTML。每轮最多自动修稿两次；人手修改重新核查。导出始终标记 `not-sent`。 |
| **Plume** | 完善账号、本篇受众、平台、参考链接、研究材料与发布配图输入，保留原稿审核、平台稿编辑、卡片生成和人工发布卡。修复陈旧预览及保存/渲染/发布竞争；已发版本冻结，未发平台仍可修改，并可复用为新选题。 |
| **评分与偏好** | 评分/文字意见绑定中间阶段或最终产物版本。结构化偏好按 Studio、实际 workflow 和账号/编辑设定隔离；至少两个独立项目支持且达到一致性门槛后形成默认值。后续创作读取固定快照与相关阶段意见，支持改分、撤回和暂停。新请求优先，偏好不替代事实或媒体技术校验。 |

偏好学习是显式反馈检索与提示条件调整，不训练模型权重，也尚未证明用户满意度持续提高。Video 手动组装不自动改变设置；偏好用于 agent 辅助创作。

Newsletter 的审阅轮次现在绑定服务器保存的 `reviewDigest`。旧 Accept 不能授权重写并重新审计后的稿件；没有摘要绑定的历史批准也必须重新审阅。**普通恢复**保留 Stop、拒绝和退回意见，先处理用户意图，再处理损坏文件。**显式从较早步骤重新创作**退休该步骤及后续步骤未消费的旧回答，以新指令重写，再等待新卡。损坏的 issue 可在修正卡上修复；接受修正只触发新审计，最终仍需再次人工批准。

## 开源与 skill 的实际采用

[调研记录](creator-studios.md) 比较了 FFmpeg、OpenTimelineIO、Auto-Editor、HyperFrames、Remotion、OpenCut、Mediabunny、ffmpeg.wasm 与 Whisper 系列，并读取 Remotion、HyperFrames、Auto-Editor 的官方 skills。Newsletter 参考 GPT Researcher 的来源/综合分离和 listmonk 的内容/模板分离。

本次采用本地 FFmpeg、可检查编辑清单、稳定片段 ID、统一帧时钟、来源追踪、保留用户修改、预览/导出审核和有范围的显式反馈，并独立编写 [video-editing skill](../../packs/video/skills/video-editing/SKILL.md)。没有复制完整上游编辑器、全局安装外部 skill 或把尚未接入的上游能力写成本产品功能。支持的格式和资源限制以 [Video](../../packs/video/README.md)、[Newsletter](../../packs/newsletter/README.md)、[Plume](../../packs/plume/README.md) 的 README 为准。

## 验证证据与适用范围

| 类别 | 实际执行证据与适用范围 |
| --- | --- |
| **原生媒体与引擎** | 真实 FFmpeg/ffprobe 裁切、拼接、完整解码、帧数、像素、音频、字幕、哈希和取消；真实 Studio → Workbench → 版本 → 审批 → 导出。主要使用合成媒体；agent 和平台响应为 fixtures。 |
| **重启与审阅** | Newsletter 真实 SQLite 关闭重开：既有 7 类损坏文件/用户意图恢复；本轮新增 6 类旧 Accept/Stop/Ask for changes × taskRevise/continue，以及无摘要的 legacy Accept。全部在新卡批准前保持无 export/approvedDigest，Studio 为 writing。独立 pack 测试验证“新审计与新稿匹配”也不能复用旧批准。 |
| **共享重跑与报告** | 新增 7 类共享重跑回归，覆盖 resume/goOn/continue/rewind、卡状态范围及迟到 action 成功/失败；取消报告用可控延迟先复现旧断言失败，再验证只等待自动报告及 SHA，不主动生成报告。 |
| **真实浏览器** | 已执行专项为 Video **12**、Plume **9**、Feedback **8**、Results **6** 类 React/Chromium 场景，覆盖草稿、迟到响应、重载、版本冲突和审批目标。组件 RPC/HTTP 多为 fixtures；无真实账号外发。 |
| **反馈及大文件** | 反馈 **23 组**服务/SQLite/engine 回归；真实 **2 GiB + 1 字节**稀疏文件验证分块/异步哈希、缺失/损坏和事件循环进展。证明边界机制，不是创作质量或峰值内存认证。 |

30 分钟 1080p60 单片段负载曾在 `6726242` 上通过，使用默认生产限制：预览 **127.512 秒**，1080p 导出 **455.507 秒 / 1,249,728,305 bytes**；两者完整解码 **108,000 帧**、视频时长误差 **−1 毫秒**。取消 **0.676 秒**且临时目录清空。当前 `dd292c8` 的 `media.js`、`timeline.js`、`files.js` 三个 SHA-256 与测量记录完全相同；这沿用的是媒体模块负载证据，未声称在新 HEAD 重跑了长负载。见 [测量记录](../reviews/creator-studios-2026-10-22/video-long-workload.json)。输入为 10 秒合成图/440 Hz 音调循环，不覆盖真人视听、设备播放、多 codec 语料或 RSS 峰值，也不是性能 SLA。

25 MiB 材料已在当前冻结 `dd292c8` 上复测通过：Chromium 生产表单/native fetch → localhost HTTP/DSH 0.2.0-rc.2 bridge → Studio handler/SQLite → 引擎附件和 artifact。输入 **26,214,400 bytes**，HTTP 请求 **34,952,617 bytes / 200**，三个副本 SHA-256 与输入一致，运行完成；测试前后 HEAD 和 8 个源码文件哈希未变。见 [上传记录](../reviews/creator-studios-2026-10-22/upload-25mib-ready.json)。合成字节上传不等于媒体解码；harness 未覆盖完整 DSH 认证/session/trust/代理或并发上传内存压力。

## 独立审查与最终回执

第四轮 `6726242`：Video、Plume 实际 PASS；Newsletter/feedback FAIL 1 项、shared boundaries FAIL 1 项。本轮修复为 `0a605f5`（自动报告测试等待）、`0643128`（Newsletter 审阅摘要）和 `dd292c8`（显式重跑退休旧回答），均有实施者回归证据；**第五轮四位 Claude 审查均已独立确认 PASS**。此前 FAIL 与额度中断记录保留，不以当前源码覆盖历史结果。

最终核对入口：

- [第五轮两项修复台账](../reviews/creator-studios-2026-10-22/round-5-resolution-ledger.md)：红绿日志与准确测试范围。
- [完整 gate 回执](../reviews/creator-studios-2026-10-22/final-gate-dd292c8-receipt.json) 与 [日志](../reviews/creator-studios-2026-10-22/final-gate-dd292c8.log)：**59 项通过，exit 0，无顶级或已知内部 skip**；本轮 connector 登录浏览器检查实际执行。
- [Video](../reviews/creator-studios-2026-10-22/round-5-video-report.json)、[Newsletter/feedback](../reviews/creator-studios-2026-10-22/round-5-newsletter-feedback-report.json)、[Plume](../reviews/creator-studios-2026-10-22/round-5-plume-report.json)、[shared boundaries](../reviews/creator-studios-2026-10-22/round-5-shared-boundaries-report.json)：**四份实际 verdict 均为 PASS、findings 为空**，已与运行身份、源码哈希和覆盖审计核对。
- [归档核验清单](../reviews/creator-studios-2026-10-22/verification.json) 与 [SHA256SUMS](../reviews/creator-studios-2026-10-22/SHA256SUMS)：保存实际完成结果、源码身份、读取证据及文件校验值。

本次没有构建/部署新 box 镜像、真人平台发布或邮件投递。Video 暂无自动 ASR、专业多轨拖拽、复杂转场/动效、HDR 调色或 OTIO/NLE 互通；Newsletter 暂无订阅者管理、SMTP 或邮件客户端矩阵认证。真实研究 provider 质量、代表性用户素材和人工编辑/听音仍需验证。

审查与完整检查绑定上述冻结源码。其后的提交仅归档这些报告及本文，功能文件哈希保持不变。报告记录了静态审查的局限，不构成所有设备、真实账号和素材均已认证。
