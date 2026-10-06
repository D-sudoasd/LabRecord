# LabRecord

独立 Windows 离线实验规划和现场记录应用。先阅读 README、docs/architecture.md 和 docs/使用说明.html。当前任务规格保存在 docs/specification.md。

- 延续工作区根目录的主动交付、证据边界和必要验证原则。
- 界面中文；记录中的样品状态、原表标记、单位、空值和文件引用必须保留。
- 准备数量、不同待测样品数量、计划操作数分别统计。重测复用样品 ID；备样启用后才计入计划。
- 修改时间不得覆盖 originalStartedAt / originalEndedAt；修改计划不得改变已有 run.snapshot。没有操作记录的旧表不能生成实际操作或推断时间。
- 界面无 Node 权限。所有数据库、文件和原生对话框操作只经固定 preload 接口，并在主进程验证。
- 修改数据库格式需显式迁移和相应备份兼容性检查。不能只提高 schemaVersion 后继续读取旧数据。
- 修改写入、计数、时间、导入或恢复行为，运行相应 tests/*.test.ts；涉及现场交互，构建后运行 npm run test:desktop。
- 打包交付必须运行 npm run test:packaged；单元测试和构建通过不能代替打包后的实际操作检查。
- tests 使用临时独立目录。不要将验收数据写入用户的 %APPDATA% 数据目录。
- node_modules、dist、release、test-results、本地数据库和备份包均不进入 Git。更新交付时保留必要软件包和验证说明。
