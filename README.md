# OpenCode for fnOS

将官方 OpenCode Linux Web 服务包装成飞牛 FPK 应用。桌面入口采用飞牛内部 iframe 窗口，服务以独立包用户运行，无 Docker，也不修改上游 OpenCode。

本项目由社区开发，与 OpenCode 官方团队无隶属关系。

## 当前交付状态

- x86_64 开发测试包：`dist/OpenCode-fnOS-1.19.0-1-x86_64.fpk`。
- 官方 OpenCode 1.19.0 Linux x64 baseline binary，经 GitHub release SHA256 验证；兼容不具备 AVX2 的 CPU。
- 完整 FPK 工程、安装/配置向导、启动停止状态、日志轮转、升级备份、卸载加密导出、恢复工具、构建与检查脚本。
- 已实际完成 fnpack 1.2.3 打包、包内权限与 ELF 检查、Shell 语法与恶意向导输入检查。
- **尚未在 fnOS 设备安装或运行，不能作为实机验收通过的正式发布包。** 当前 Windows 电脑没有可用 Linux/WSL 环境。`ldd`、CLI help、Web/PTY/SSE、模型调用及持久化均需实机验证。
- ARM64 在 x86_64 实机验收后加入；构建脚本当前会明确拒绝 ARM64。

## 支持平台与运行依赖

当前仅构建 Linux x86_64 / fnOS `platform=x86`。ELF 检查发现 GLIBC 最高引用符号版本 2.30，依赖 libc、libpthread、libdl、libm 和 Linux 动态加载器。未填写未经实机测试的 `os_min_version`。

应用声明飞牛运行时依赖 `nodejs_v22`、`python312`、`java-21-openjdk`。服务本身使用 OpenCode standalone binary；这些运行时供项目命令使用。构建时另行捆绑 pnpm 10.18.3（npm registry SHA512 integrity）和 Maven 3.9.11（Apache SHA512），由应用私有命令包装器调用。

启动脚本依赖 Bash、curl、util-linux 的 flock/setsid；卸载保留数据依赖 openssl；实机诊断需要 file/ldd。Git 使用 NAS 上已有的 Git，当前未捆绑 Git，也未声明未核实的飞牛 Git 包名。首次实机测试必须确认 Git 存在；缺失时 Git 验收不通过。

## 安装与打开

1. 在飞牛应用中心手动安装 `dist` 中的 FPK。
2. 设置服务端口（默认 4096）、用户名（默认 opencode）及至少 12 个字符的 Web 密码。
3. 等待运行时依赖和应用安装完成，在应用中心启动。
4. 双击桌面 OpenCode 图标，在飞牛窗口内输入 Web 账号密码。
5. 在文件管理器的 `OpenCode/projects` 共享目录放入项目，在 OpenCode 内打开对应项目目录。

当前入口为 HTTP 独立端口。请用 HTTP 飞牛桌面进行第一轮窗口验收；HTTPS 飞牛桌面嵌入 HTTP 服务可能被浏览器阻止。跨端口 iframe 的 Basic Auth 弹窗、剪贴板权限与快捷键仍需验证。如果登录挑战被浏览器阻止，需要后续增加兼容登录入口，不能直接关闭密码。

## 构建

需要 Python 3.12+、网络连接，以及足够保存 binary、暂存包和结果的磁盘空间。脚本自动获取官方 fnpack，缓存下载，校验 binary 和开发工具，并规范化包内 Unix 权限。Windows fnpack 原始输出不保留执行权限，**应使用本项目构建脚本产生的 dist 包**。

Linux/macOS：

```bash
./scripts/build.sh 1.19.0 x86_64
python3 scripts/verify.py
```

Windows：

```powershell
./scripts/build.ps1 -Version 1.19.0 -Architecture x86_64 -Python 'C:\path\to\python.exe'
& 'C:\path\to\python.exe' scripts/verify.py
```

本机已验证的 Python 路径：

```powershell
./scripts/build.ps1 -Python 'C:\Users\hansh\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
```

仅调整包装逻辑时用 `-Revision 2`，Linux 可传 `--revision 2`。版本采用 `OpenCode版本-包装修订号`。不能使用未经核实的校验值；上游 release 缺少 SHA256 digest 时构建会停止。

`opencode-fnos/app/bin/opencode` 是已下载的本地 binary；构建会重新从经过校验的版本归档取出 binary。pnpm/Maven 文件生成在 `.build` 暂存工程中，不安装到开发电脑的全局环境。

## 开发与数据路径

| 内容 | 路径 |
| --- | --- |
| 安装文件 | `$TRIM_APPDEST` |
| Web 服务设置 | `$TRIM_PKGETC/web.port`、`web.username`、`web.password` |
| OpenCode 配置 | `$TRIM_PKGETC/opencode/` |
| HOME | `$TRIM_PKGHOME` |
| Provider、会话、数据库 | `$TRIM_PKGVAR/data/opencode/`（具体文件名随上游版本变化） |
| 缓存 | `$TRIM_PKGVAR/cache/opencode/` |
| 状态 | `$TRIM_PKGVAR/state/opencode/` |
| 临时文件 | `$TRIM_PKGTMP`，缺省时 `$TRIM_PKGVAR/tmp` |
| 服务输出 | `$TRIM_PKGVAR/log/opencode.log` |
| 上游内部日志 | `$TRIM_PKGVAR/data/opencode/log/` |
| 升级备份 | `$TRIM_PKGVAR/backups/时间戳/` |
| 项目 | `$TRIM_DATA_SHARE_PATHS` 中声明的 `OpenCode/projects` 目录 |

包用户权限与共享 ACL 由飞牛资源声明管理，没有 root 服务或 `chmod -R 777`。应用设置中的目录授权入口保持开放，可由用户显式授权已有目录。运行身份隔离不等于文件系统沙箱：程序仍可读取系统允许包用户读取的文件。

启动时检查密码、项目目录、端口和 binary，使用 PID、进程 binary 与启动时间识别服务，再等待官方 `/global/health`。健康检查账号通过 curl 标准输入传递，不放入命令行或日志。停止时 TERM 后最多等待 15 秒，再对已验证进程组 KILL。服务输出以约 5 MiB 为阈值轮转，保留 3 份历史；上游内部日志遵循上游自身策略。

## Provider 配置

模型密钥全部在 OpenCode 界面配置，不在 FPK 向导收集。OpenCode 原生 Provider 流程负责 DeepSeek、OpenCode Go、OpenRouter、OpenAI Compatible 等；Ollama/LM Studio 需要填写 NAS 可访问的端点。不同 Provider 在当前上游 UI 中可用的配置方式需实测；本包未添加独立 Provider 页面。

## 升级与恢复

升级前先停止服务并分别备份配置、data/state 和 HOME；项目共享目录不参与覆盖。所有 OpenCode 自更新均禁用，binary 随 FPK 更新。

升级失败时保留当前备份，并重新安装上一版 FPK；恢复配置和数据库时服务必须停止，数据库要与对应旧版 binary 一起恢复。备份不是已经测试过的自动回滚。升级备份目前不自动删除，应由管理员确认恢复点后清理。

卸载默认把私有配置、会话与 HOME 导出为 AES-256-CBC/PBKDF2 加密文件，保存到 `OpenCode/projects/OpenCode-private-时间戳.tar.enc`。解密密码为卸载时的 Web 密码，请保管。加密导出失败时脚本报错，停止继续卸载。选择删除则交由 fnOS 清理应用私有目录；系统卸载行为需实机验收。任何选项都不会由本项目删除共享项目。

重装后的恢复工具是 `$TRIM_APPDEST/lib/restore.py`，需要 Python 3.12+。在维护终端中使用飞牛提供的 `TRIM_PKGETC`、`TRIM_PKGVAR`、`TRIM_PKGHOME` 环境变量，停止应用后执行：

```bash
python3 "$TRIM_APPDEST/lib/restore.py" /实际项目路径/OpenCode-private-时间戳.tar.enc
```

工具会交互询问旧密码，验证归档路径后还原。恢复后在飞牛配置向导中把端口、用户名和密码设为恢复前的值，再启动服务；向导端口决定桌面入口。恢复工具尚未经过 fnOS 实机验证。

## 常见问题与安全说明

- 启动失败：先查看飞牛显示的生命周期错误和应用日志。运行 `bash "$TRIM_APPDEST/lib/diagnose.sh"` 可检查实际依赖、OpenCode CLI help 与开发工具；它不会打印环境变量或密码。
- 端口占用：在应用设置修改端口。FPK 不写固定 `service_port`，桌面入口通过向导变量绑定，启动时动态检查。
- iframe 空白：检查浏览器 mixed content、认证挑战、CSP 和 WebSocket 请求。不要据此改成未认证服务。
- 终端找不到命令：检查飞牛运行时依赖、Git 和 PATH；项目自带工具可以放在应用用户允许执行的位置。
- 多人共用：当前一个 Web 账号共享所有会话与可访问项目，不是按飞牛用户隔离的多租户系统。
- 只向可信用户提供 Web 密码。该服务允许 Shell 与文件修改。独立端口不复用飞牛登录态，不应直接暴露到公网；HTTPS 与统一网关属于后续版本。

## 实机验收

完整逐项清单见 `docs/ACCEPTANCE.md`。在该清单实际通过前，本包仅供开发测试。

## 核对的官方资料

- [飞牛 fnpack 1.2.3](https://developer.fnnas.com/docs/cli/fnpack/)
- [飞牛桌面 iframe 入口](https://developer.fnnas.com/docs/core-concepts/app-entry/)
- [飞牛资源与共享 ACL](https://developer.fnnas.com/docs/core-concepts/resource/)
- [飞牛运行时依赖](https://developer.fnnas.com/docs/core-concepts/runtime/)
- [OpenCode 官方 1.19.0 release](https://github.com/anomalyco/opencode/releases/tag/v1.19.0)
- [OpenCode CLI](https://docs.opencode.ai/docs/cli/)
- [OpenCode 1.19.0 Web UI/CSP 实现](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/server/shared/ui.ts)

官方页面原文与相关上游源码快照保存在 `docs/`。核对日期：2026-10-13。
