# LabRecord

![LabRecord：材料样品、操作时间线与私人报告归档的概念插图](assets/readme/hero.png)

**从实验规划到现场记录，再到可追溯的实验报告。** 中文 Windows 软件，断网也能使用；换电脑时，把记录和报告保存到自己的 GitHub 私人库。

[**下载 Windows 版**](https://github.com/D-sudoasd/LabRecord/releases/latest) · [快速开始](#三步完成一次实验) · [私人库设置](#把实验保存在自己的私人库) · [使用说明](docs/使用说明.html)

![Windows x64](https://img.shields.io/badge/Windows-x64-196B63) ![离线使用](https://img.shields.io/badge/记录与报告-支持离线-196B63) [![MIT License](https://img.shields.io/badge/License-MIT-196B63)](LICENSE)

_LabRecord is an offline-first Windows app for experiment planning, live sample records, and traceable reports. Source code is public; experimental records and reports belong in your own private repository._

**v0.4.0：更清晰、更从容的实验工作空间。** 采用受 iOS 启发的浅色界面、圆角卡片和柔和层次；宽窗口显示完整导航，窄窗口自动收紧。准备、计划与备样一眼可见，现场操作保留大按钮和持续可见的保存状态。

## 现场记录，专注当前样品

队列、当前样品和时间线在同一页。点击开始与完成，自动保存起止时间并显示本次用时；完成进度随记录更新。备注、实际尺寸、问题和图片随时补充。忘记点击时可修正时间，并保留原值和修改历史。

![真实现场界面：当前样品、大按钮、现场备注和操作时间线；使用合成演示数据](docs/images/live.png)

## 少填几次，多记录一点

填写名称即可添加样品并安排测试。信息、数量和尺寸分别填写，实时预览准备 / 测试 / 备样；数量不合适时直接提示。厚度与宽度直接录入，高度和其他参数按需展开；“保存并继续添加”保留参数，编号自动连续。

![真实快速添加界面：样品名称、准备数量、测试数量、厚度与宽度](docs/images/quick-add.png)

| 实验阶段 | LabRecord 提供什么                                                                   |
| -------- | ------------------------------------------------------------------------------------ |
| 实验前   | 名称与原始状态分开；连续编号、批量编辑、自定义字段与单位；Excel/CSV 导入和多行粘贴   |
| 实验中   | 逐项开始与完成；自动保存、时间修正、问题与图片；插入样品、启用备样、跳过、中断和重测 |
| 实验后   | 一次生成 PDF、独立 HTML、完整 JSON、图片、agent 阅读说明及 SHA-256 清单              |
| 换电脑   | 私人库同步完整记录与图片；报告独立归档，可列出并下载；失败保留本机文件与待上传任务   |

准备数量和测试数量分别统计：**准备 6 个 → 安排测试 4 个 → 备样 2 个**。重测新增操作并保留原样品关联；备样启用后才进入计划。

## 三步完成一次实验

1. **下载并解压。** 从 [Releases](https://github.com/D-sudoasd/LabRecord/releases/latest) 下载 Windows x64 ZIP，解压整个文件夹，双击 `LabRecord.exe`。无需安装 Node、Python、Excel 或数据库。首次打开可载入演示实验。
2. **规划并记录。** 规划页添加样品；`Alt+N` 打开快速添加，`Ctrl+Enter` 保存并继续添加。`Ctrl+1 / 2 / 3` 切换规划、现场和回看页，切换前保存当前输入。现场点击开始、完成，随手补充变化。重新打开软件，未结束的操作仍保留。
3. **生成报告。** 回看页点击“导出实验报告”并选择目录。报告先保存到本机；已连接私人库时，后台继续归档，可在“云同步”查看状态、重试或下载。

```text
report.pdf        阅读与分享
report.html       含图片的独立报告，下载后离线打开
records.json      完整实体、稳定 ID、单位、空值和修改历史
README-agent.md  后续 agent 的读取入口与数据含义
images/          现场图片原文件
manifest.json    文件大小与 SHA-256
```

将完整目录交给后续 agent，先读 `README-agent.md`，再核对 `records.json`。未知时间保持空白，计划参数与实际修改分别保存。

![真实回看与报告导出界面，使用合成演示数据](docs/images/review.png)

## 把实验保存在自己的私人库

公开仓库保存源码与演示素材。**每位使用者独立连接自己的私人数据仓库**；公开源码不会授予实验数据的访问权限。

1. 在 GitHub 创建并初始化一个私人仓库，例如 `你的账号/research-records`。点击软件顶栏“云同步”，填写仓库地址。
2. 使用本机已登录的 GitHub CLI，或填写只授予该私人库 **Contents 读写**权限的细粒度令牌。令牌由 Windows 加密保存在本机；每台电脑独立登录。
3. 点击“同步实验记录”。另一电脑连接同一私人库后同步，即可接续。记录同步手动触发，现场可以保持离线。
4. “生成报告后保存到私人库”默认开启。报告先本机保存，再后台上传；失败保留任务，启动、重新连接或点击同步时重试。云同步页提供状态、查看、刷新和下载入口。

```text
labrecord/
  latest.json                         最新完整实验备份索引
  snapshots/                          数据库、历史与图片的完整备份
  reports/
    README.md                         报告阅读索引
    index.json                        机器可读索引
    <experiment-id>/<report-id>/       每次导出的独立报告版本
```

![真实归档界面，使用合成的私人库与离线失败状态](docs/images/report-cloud.png)

多个电脑归档报告时保留各自版本。两端独立修改完整实验记录时，软件提示选择版本，接收前为本机制作备份。进行中的本机操作需要先完成或中断才能接收云端。

仪器原始数据保存路径引用，迁移时另行复制。现场图片包含在备份与报告中。单张图片上限 10 MB，完整备份及展开内容上限 512 MiB，单份云端报告上限 2 GiB；大文件分段上传，下载时校验重组。

## 开发、验证与贡献

Electron、React、TypeScript、SQLite；交付 Windows x64。开发使用 Node.js 24，依赖版本固定在锁文件中。下载包内含运行环境。

```powershell
npm ci
npm run dev
npm run verify
npm run dist
npm run test:packaged
node scripts/check-release.mjs
```

常规测试使用独立临时数据，不访问 GitHub。显式联网验收：

```powershell
node scripts/test-live-cloud.mjs 你的账号/私人测试库
```

联网检查使用随机隔离目录与合成实验，结束后清理测试文件。提交问题时提供复现步骤和脱敏截图，实验记录、令牌和备份保存在私人存储。

[数据与实现说明](docs/architecture.md) · [验收记录](docs/verification.md) · [私人报告归档说明](docs/private-storage.md) · [MIT 许可证](LICENSE)

Windows 程序目前未进行代码签名。报告整理已保存记录，实际实验结论由仪器数据与实验条件判定。首页主视觉由 imagegen 生成，界面截图来自真实软件的合成演示实验；[生成提示词与来源](assets/readme/generation.md)。
