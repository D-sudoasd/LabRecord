# 数据与实现说明

## 数据关系

`Experiment → Group → Sample → PlanItem → Run` 使用稳定 ID 关联。一个样品可有多个计划操作；一项操作最多一个实际记录。重测记录 `repeatOf` 和相同的 `sampleId`。

Group.preparedCount 为准备总数，可以是 null。已计划的不同样品数按 Sample 统计，备样为准备总数减去已计划样品数。PlanItem.status 为 pending、running、completed、skipped、interrupted。完成进度按 PlanItem 统计，跳过和中断独立显示。

Group.name 与原始 Group.state 分开；厚度、宽度、高度及单位允许留空。具体样品的覆盖值保存在 Sample.parameters。`addSamples` 在同一事务中创建样品组、连续编号和测试队列，安排数量超出准备数量时整次回滚。

Run.snapshot 保存开始时的样品组、具体样品、操作、字段及单位；后续计划编辑不更新它。实际厚度、文件引用和自定义参数保存在 Run.actual；样品名称、宽高和单位保存在独立的 Run.actualSample，避免与旧自定义字段 ID 冲突。现场备注保存在 Run.notes。问题、参数修订、时间修正和附件添加写入 RecordEvent。

0.2 的名称与尺寸是实体 JSON 中可选的新增字段，数据库与导出格式版本仍为 1。旧版本备份无需填造字段即可读取；旧操作快照保持原样。新操作的实际参数初始沿用计划，只有现场修正记录说明实际变化，不能把这些数值当成仪器独立测量结果。

自动点击时间以 UTC ISO 8601 保存，同时保存时区和当时的偏移。originalStartedAt / originalEndedAt 保留第一次自动记录的值；手工补录没有原始自动值，保留 null。修正事件保留修改前的时间。未知时间不作为零值或当前时间处理。

SQLite 包含独立实体表、外键、状态约束、样品和预期文件名唯一约束，partial unique index 限制全库最多一个 running。写入使用事务、WAL、synchronous=FULL。request ID 与命令 SHA-256 在同一事务保存，可重试同一请求而不重复操作；界面另有连续点击保护。

## 桌面边界

沙盒 renderer 没有 Node 权限，contextIsolation 开启，固定 contextBridge API 不暴露 ipcRenderer 或文件系统。主进程校验窗口与 frame 来源，Zod 校验命令，SQLite 参数绑定，序列化变更与文件服务。外部导航和新窗口请求被拒绝。

`labrecord://app` 只提供 UI 目录内的资源，`labrecord://attachment/<id>` 只访问登记的图片。图片检查文件头，不执行 HTML 或 SVG。导入、导出、备份、恢复及文件引用均由主进程的原生选择框限定；导出与备份禁止覆盖受管理的数据目录。

自动保存输入保留本地草稿，等待 500 ms 或失焦时写入；选项通常在 50 ms 写入。未保存输入会在开始、完成、切换页面/样品或关闭前刷新。失败显示错误并保留输入，不将失败视为已保存。

0.4 的界面使用统一颜色、圆角与阴影变量，宽窗口展开导航，窄窗口保留紧凑导航。页面快捷键复用草稿刷新机制；打开对话框时停止页面快捷键，关闭后恢复原入口焦点。搜索与用时显示复用共享组件。用时由 Run.startedAt / endedAt 计算，仅正在进行的操作每秒刷新显示；未知时间保留“—”，超过一天显示累计小时，不写入数据库或生成额外事件。

## 文件格式

- XLSX：第一张“实验规划”，随后“操作记录”“时间线与修改历史”“附件清单”“参数定义”。字段定义以 LabRecordFields-v1 标记，可在重新导入规划时保留文本、数值、选项、单位及空值。重新导入规划不恢复实际操作。
- CSV：UTF-8 BOM，记录类型为样品组、操作、事件、附件，包含未安排样品、起止时间、原始值、问题、引用和稳定 ID。CSV 空值为空字段；Excel 可能自动识别纯数字文本，查看前导零编号优先用 XLSX。
- JSON：`format=LabRecord`、`schemaVersion=1`，只含当前实验，结构化保存全部实体、字段类型、单位和 null。用于后续数据处理；实际恢复使用完整备份。
- 完整备份：ZIP 容器，扩展名 .labrecord；包含 SQLite 在线备份和登记的附件。LabRecordBackup version 1 清单保存每个文件的 SHA-256 和大小。恢复先校验 CRC、清单、哈希、数据库、字段类型和关联，再对当前数据制作完整备份并切换工作目录，失败则恢复原目录。
- 报告文件夹：`LabRecordReport` formatVersion 1。report.pdf 使用 Electron 原生 printToPDF；report.html 不含脚本，嵌入图片并转义全部文本。records.json 保存当前实验完整实体，README-agent.md 解释关联与未知值，images 保存原图片，manifest.json 保存文件大小与 SHA-256。起止间隔仅在两个时间均已知时计算。生成时校验图片，全部成功后才公布最终目录。

自动备份每天创建一次，保留最近 10 份 automatic 包；应用启动、首次保存及每小时检查。手动备份与恢复前备份不自动清理。恢复后的旧工作目录仍保留在 previous-*，便于检查原数据。

## GitHub 私人仓库同步

桌面主进程固定访问 GitHub 官方 API，每次同步验证仓库为私人仓库。正常数据写入 `labrecord/latest.json` 和 `labrecord/snapshots/`。索引为 LabRecordSync version 1，包含内容摘要、备份 SHA-256、大小、摘要计数和快照文件或分段清单。备份大于 20 MiB 时分为最多 26 个分段，分别校验后再拼接；完整备份及展开内容上限 512 MiB。

每次上传先保存 UUID 快照，再使用读取到的索引 SHA 更新 latest.json。并发上传不能覆盖已变化的索引；失败不推进本机同步基线，已上传片段保留于仓库历史。所有实体按稳定 ID 排序后的内容摘要用于判断变化，不使用设备时钟或数据库字节判断同步方向。仅本机变化则上传，仅云端变化则接收，双方独立变化则要求选择一份；本版不逐字段合并。

接收前验证各段大小、SHA、ZIP、清单、数据库及实体关联，再生成 `before-cloud-*.labrecord` 并切换工作目录。运行中的本机操作阻止接收；本机原目录仍保留。没有网络时不会修改本机记录。

登录凭据单独保存于用户数据目录，优先使用已登录 GitHub CLI；手工令牌通过 Electron safeStorage 的 Windows 加密保存。令牌不会返回界面、写日志或进入备份/仓库。另一电脑需独立登录。同步状态保存仓库、目录、最后一致的内容摘要和时间，实验数据恢复不携带凭据。

## 私人报告归档（0.3）

报告导出先完成本机目录，再复制经清单验证的文件到用户数据目录的 report-archive。ReportQueue version 1 保存任务和状态，不进入实验数据库或完整备份；任务绑定仓库、同步目录、实验 ID 和报告 ID。上传中的任务在重启后恢复为待上传，上传成功后清理受管理的副本。关闭自动归档保留任务。凭据配置的可选 reportArchiveEnabled 字段兼容旧配置，默认开启。

网络上传在独立队列中执行，不占用数据库命令序列；状态查询也无需等待上传。启动、连接和同步后尝试队列，每次重试每个任务最多尝试一次。失败保存错误并等待后续触发。更换仓库不会转移旧任务。导出成功但登记归档失败时返回本机路径和独立的归档错误。

labrecord/reports/index.json 为 LabRecordReports version 1；每份 archive.json 为 LabRecordReportArchive version 1。文件、分段的大小与 SHA-256 均保存，20 MiB 以上文件分段，总量上限 2 GiB。固定文件白名单和 UUID 图片路径防止清单越界。下载校验完整报告后原子公布最终目录。

主进程使用 GitHub blob/tree/commit/ref 接口，将报告与索引在一个提交中公布；base_tree 保留其他内容，force=false 的快进更新保护其他设备的提交。冲突后读取新基线重建索引，最多重试三次。相同报告 ID 重试检查已有清单与本机文件摘要，不创建重复版本。索引 Markdown 识别分段文件并提示使用软件下载。实验数据与导出格式版本仍为 1。

## 当前边界

一张规划表最多 10,000 行、100 列，最多 50 个自定义字段；一次安排最多 1,000 个样品。XLSX/CSV 文件最多 20 MB，图片最多 10 MB，完整备份展开内容最多 512 MB。XLSX 读取第一张工作表；CSV 使用 UTF-8。

图片复制到应用数据目录，纳入完整备份；仪器数据文件只保存路径引用。迁移实验数据时需另行复制仪器文件。软件不修改原文件、不从文件名猜测时间、不用完成标记合成测量记录。

`LABRECORD_TEST_MODE=1` 与绝对路径 `LABRECORD_TEST_DATA` 同时提供时，可覆盖测试数据目录。仅测试模式接受 `LABRECORD_TEST_SYNC_PREFIX`，将实际云端检查限制在独立目录。正常应用不使用这些覆盖变量。测试不会触碰用户实验数据。

接口和备份实现参考 [Electron IPC 官方说明](https://www.electronjs.org/docs/latest/tutorial/ipc)与 [SQLite 在线备份说明](https://www.sqlite.org/backup.html)。具体实现行为及本地验收结果见源码和 [验收记录](verification.md)。
