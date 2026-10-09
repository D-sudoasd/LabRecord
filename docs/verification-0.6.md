# LabRecord 0.6.0 本地交付验收

2026-10-09（Asia/Shanghai）完成。Windows x64 软件包为 `release/LabRecord-0.6.0-Windows-x64.zip`，解压整个目录后运行 `LabRecord.exe`。代码与使用流程已经实际实现，验收数据均为合成实验，测试使用独立临时目录。

| 检查                         | 结果                                                 |
| ---------------------------- | ---------------------------------------------------- |
| TypeScript 类型检查与构建    | 通过                                                 |
| 数据、存储与交换测试         | 58 / 58 通过                                         |
| 开发版完整桌面检查           | 40 / 40 通过；最后复制修改另做 2 项定向检查          |
| 最终 Windows 打包程序        | 41 / 41 通过，失败、跳过、flaky 均为 0               |
| ZIP 完整性与关键文件         | CRC 通过；10 个关键文件与实际验收目录的 SHA-256 一致 |
| 独立只读代码审查             | PASS / CLEAR，无 blocker；审查者未独立重跑测试       |
| 本轮改动文件的格式与差异检查 | 通过                                                 |

## 实际覆盖

- 一件物理样品预排循环、分级、旋转或离位测量；多次测量和真正重测分别保留，准备数、物理样品数、操作数及备样互不混淆。
- 材料、状态、方式、技术、制度与批次命名；空字段、Windows 字符与保留名、内部 `--`/`__`/`$&` 保真、跨实验避重、临时名冲突、名称预留及乱序开始。
- 实验设置、历史规则与历史测量参数复用；批量配置、筛选时清理隐藏选择、原位与离位制度录入、连续添加和焦点恢复。
- 新建实验、快速添加、安排样品和追加制度的提交后响应丢失重试；明确拒绝后修正输入；未知结果的 Escape、关闭和返回先刷新记录，读取失败时保留请求。
- 复制前保存命名输入，保存失败时不复制旧名称；旧计划预留不制造实际运行或时间，不重复写入审计事件。
- 旧 v1 备份、可选元数据、新字段与错误字段、名称冲突、手工补录、原始时间及历史快照；真正导出 CSV/JSON/XLSX/HTML/PDF 并核对内容。
- 原有现场问题、图片、自动保存、重启、备样、跳过、中断、F8、跨午夜时间修正、概览，以及真实 900 × 700 / 150% 应用缩放。

## 交付与可追溯性

软件包：`LabRecord-0.6.0-Windows-x64.zip`，163,041,818 字节，149 个文件。

```text
SHA-256: ce461a914efa8eff50fbb629fa9c5781405616f38bdf3d07a660f954915b92ca
```

`release/SHA256SUMS.txt` 和 `release/delivery-manifest.json` 保留压缩包、关键文件、原生运行环境和演示报告的校验信息。原生运行环境为 Electron 44.5.1、Node 24.21.0、SQLite 3.53.4，`packaged=true`。

[机器可读验收记录](verification-0.6.json)记录全部 41 个打包场景、软件包摘要和源码指纹。主线程原始日志、独立审查结论及源码/测试输入的逐文件 SHA-256 在 `local_artifacts/beamtime-upgrade/`；最初工作树的完整源码 ZIP、二进制差异补丁和状态清单保留在其 `before-20261009-125000/` 子目录，既有未提交改动没有被撤销。原有 10 张 0.5 截图逐字节保留；新增 [多制度规划](images/beamtime-planning.png)、[旋转测量现场](images/beamtime-live.png)、[窄窗口配置](images/beamtime-small.png) 均来自最终 0.6.0 打包程序，来源与哈希见 [截图记录](images/sources.json)。

SQLite 表、索引、`user_version`、`schemaVersion` 和完整备份版本仍为 1；本轮只扩展可选实体元数据，并通过旧备份与快照回归。新记录应使用 0.6 或更新版本继续操作。

## 适用范围

本轮不读取、解析、匹配实际 SXRD 文件，不集成外部处理软件，也不依赖实际目录存在。0.6.0 未执行新的真实私人库同步、GitHub CI 或公开发布；云端原有行为由本地模拟回归覆盖。Windows 程序仍未代码签名。工程验收不代表仪器数据或科研结论验收。

构建保留了原依赖的 `use client` 打包提示、SQLite 实验性 API、颜色环境及未填写 author 的提示，退出码均为 0。全仓格式检查发现既有 `.coding-team.json` 格式提示，本轮未修改该配置；本轮所有修改文件的定向格式检查通过。

复现：

```powershell
npm run typecheck
npm test
npm run build
npm run test:desktop
npm run dist
npm run test:packaged
node scripts/check-release.mjs --preserve-screenshots
```

[同步辐射现场使用流程与命名规则](beamtime-workflow.md)。
