<p align="center">
  <a href="https://github.com/D-sudoasd/LabRecord/releases/latest">
    <img src="assets/readme/hero-0.7.1.png" width="100%" alt="LabRecord 材料实验记录概念插图：金属试样、实验时间线和上锁的报告档案">
  </a>
</p>

<p align="center"><em>imagegen 概念主视觉。实际软件界面见下方的真实截图。</em></p>

<h1 align="center">LabRecord</h1>

<p align="center"><strong>规划样品、记录现场操作，一次导出可追溯的实验报告。</strong></p>

<p align="center">
  <a href="https://github.com/D-sudoasd/LabRecord/releases/download/v0.8.3/LabRecord-0.8.3-Windows-x64.zip"><strong>下载 Windows 版 · 0.8.3</strong></a>
  &nbsp;·&nbsp; <a href="#三步完成一次实验">三步开始使用</a>
  &nbsp;·&nbsp; <a href="docs/beamtime-workflow.md">现场使用流程</a>
  &nbsp;·&nbsp; <a href="CHANGELOG.md">更新记录</a>
</p>

当前公开下载仍为 0.8.3。0.10.1 本地工作区升级版尚未公开发布。

<p align="center">
  <img src="https://img.shields.io/badge/Windows-x64-196B63" alt="Windows x64">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-196B63" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/version-0.8.3-196B63" alt="version 0.8.3">
</p>

> 中文 Windows 桌面应用。实验规划、现场记录和报告导出可以离线完成；需要换电脑时，再连接各自的 GitHub 私人数据仓库。

## 从规划到报告

一件实物样品可以安排多次测量，后续重测沿用实物身份并关联原记录。主要信息和备注可直接在现场规划表中填写；需要时再记录时间、问题和照片。

### 实验规划

![LabRecord 0.7.1 实验规划：样品组、测量数量和待测操作；使用合成实验数据](docs/images/planning-0.7.1.png)

同一件样品可安排循环加载、分级加载、旋转扫描或离位测量。准备数量、不同待测样品数和计划操作数分别统计；启用备样后才加入计划。未知时间与未填数量不补成零，单位按录入保留。

规划页顶部的现场规划表有五列：简写编号、尺寸、原位参数、实际样品信息和备注。每一行是一项测量，可直接填写常用信息；同一件样品的首测为 G-1，再测为 G-1-2、G-1-3，下一件为 G-2。每次测量有自己的备注；其他资料按需展开。已开始的记录保留当时的编号和计划快照。现场表可单独保存为 A4 横向 PDF 或 Excel，备注列也留有手写空间。

LabRecord 保存和复制文件夹名称；两台仪器电脑上的实际文件夹仍由现场人员建立。共用同一 LabRecord 数据的电脑应升级到相同版本，并保留至少一份完整备份。旧版可能无法读取新版数据或恢复新版备份；0.8.3 也可能拒绝恢复包含跨实验同名的备份。

打开旧版 v1 或 v2 数据，或从备份、云端接收旧版数据时，软件会在升级到 v3 前自动保存并校验包含附件的旧版完整备份到本机 `backups`。备份失败时会停止升级并提示，不继续迁移。新版可恢复 v1、v2 和 v3 备份；0.10.0 等旧版不能打开或恢复 v3 数据。

### 现场记录

![LabRecord 0.7.1 现场记录：当前样品、开始与完成按钮、快记和操作队列；使用合成实验数据](docs/images/live-0.7.1.png)

现场页突出当前编号、开始/完成、备注与下一项；问题、图片和其他记录按需展开。填写备注不需要先开始操作，也不会自动生成时间。记录保存到本机，也可离线使用。

### 回看与导出

![LabRecord 0.7.1 回看：待核对事项和样品记录；使用合成实验数据](docs/images/review-0.7.1.png)

核对待补时间、未关联文件和未处理问题。报告一次包含：

- PDF：便于阅读和打印。
- 独立 HTML：含图片，可离线打开。
- `records.json`：完整记录、稳定 ID、空值、单位和修改历史。
- 图片、`README-agent.md` 和 SHA-256 校验清单。

![LabRecord 0.7.1 快速添加样品：样品名称、准备与测试数量和实时备样提示；使用合成数据](docs/images/quick-add-0.7.1.png)

只需填写样品统称即可安排操作；数量和尺寸可按需补充。修改过的样品表单若被关闭，会先给出“继续填写”或“放弃填写”选择。减少计划数量后，若隐藏的样品行已填写过内容，保存前需要选择返回检查或放弃这些隐藏内容。

## 三步完成一次实验

1. **下载并打开。** 下载上方的 Windows x64 ZIP，完整解压后双击 `LabRecord.exe`。不需要安装 Node.js、Python、Excel 或数据库。首次打开可选择载入演示实验；演示记录会保存在本机实验库。
2. **建立实验并安排样品。** 点击“新建第一个实验”，到“实验规划”添加样品，然后直接在现场表中填写尺寸、条件、样品信息和每次测量的备注。需要再测时，从原行安排再次测量。
3. **保存或打印。** 点击“保存 PDF 打印表”或“导出 Excel”。需要记录开始和完成时间时，再进入“现场记录”；未知信息可以留空。

**常用快捷键：** `Alt+N` 打开快速添加，`Ctrl+Enter` 保存并继续，`Ctrl+K` 打开实验库，`Ctrl+1 / 2 / 3` 切换页面；现场页的 `F8` 开始或完成当前操作。输入、中文输入法组合输入和弹窗期间不会触发 `F8`。

Windows 程序目前尚未代码签名。

可以随时回到开始页并重新打开实验；自定义参数可以调整填写顺序。添加样品时，关闭弹窗或按 `Escape` 可先继续填写或明确放弃。上方规划、现场和回看截图来自 0.7.1，界面以当前版本为准。

## 适合实验室工作流的细节

- **多种制度、同一样品。** 测量制度各自保存；重测增加操作并关联原记录，不另造物理样品。
- **实际值有来历。** 操作开始时保存计划快照；之后更正样品信息不会改写开始时的计划或原始自动时间。由计划初始化的值不等于独立实测值；旧记录未填写的实际值不会从计划补造，旧版空值的来源可能无法判定。
- **报告有边界。** 报告整理已保存的记录，不判定实验数据是否合格，也不代替仪器数据分析。
- **仪器原始数据由你管理。** 软件保留填写的文件名和路径引用；这不代表仪器原始文件已上传。换电脑时请单独复制文件并核对路径。
- **记录保存在本机。** 可生成完整备份并从备份恢复。使用云同步时，两台电脑各自登录；互有修改时软件提示选择版本，并先备份本机数据。

## 连接你自己的私人仓库

每位使用者使用**自己的 GitHub 私人仓库**，其中保存完整备份和独立报告版本。公开的 LabRecord 源码不包含实验记录，也不会授予他人访问私人仓库的权限。

1. 在 GitHub 创建并初始化一个私人仓库，在应用的“云同步”页填写仓库地址。
2. 使用本机已登录的 GitHub CLI，或仅向该仓库授予 **Contents 读写**权限的细粒度令牌。令牌由 Windows 加密保存在本机。
3. 手动点击“同步实验记录”，在另一台电脑连接同一仓库后即可接续。

报告先保存到本机，已连接私人库时可在后台自动归档；联网失败会保留本地报告和待上传任务。单独归档或下载时，应用会校验报告文件和 SHA-256。请保留完整报告目录，先读其中的 `README-agent.md` 再分析。

## 更多说明

- [完整离线使用说明](docs/使用说明.html) · [报告私人归档](docs/private-storage.md) · [同步辐射现场流程](docs/beamtime-workflow.md)
- [数据模型和实现边界](docs/architecture.md) · [更新记录](CHANGELOG.md) · [0.7.1 验证与校验值](docs/verification-0.7.1.md) · [截图来源与版本](docs/images/sources.json)
- [主视觉生成提示词与来源](assets/readme/hero-0.7.1.md) · [MIT License](LICENSE)

## 开发

需要 Node.js 24。下载 ZIP 的最终用户无需安装开发环境。
运行桌面验收前，需要安装 Poppler 并将 `pdftotext` 加入 PATH，以检查现场表 PDF 的实际内容；最终用户无需安装 Poppler。

```powershell
npm ci
npm run dev
npm run verify
npm run dist
npm run test:packaged
node scripts/check-release.mjs
```

界面截图及桌面验收使用合成实验和独立临时目录，不写入真实实验数据库。0.10.1 本地包与验收结果见[验证记录](docs/verification-0.10.1.md)。

[下载 LabRecord 0.7.1](https://github.com/D-sudoasd/LabRecord/releases/tag/v0.7.1) · [查看 0.7.1 更新说明](docs/releases/v0.7.1.md)
