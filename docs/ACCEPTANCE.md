# fnOS 实机验收（待执行）

本清单未执行；本地包检查不代表实际安装或 Agent 验收。

记录设备型号、CPU、fnOS 版本、浏览器版本、安装包 SHA256、测试时间和失败请求/日志。

- [ ] 手动安装成功，运行时依赖自动安装，包用户不是 root。
- [ ] `file`、`ldd` 无缺失依赖，实际 GLIBC 满足 binary 要求。
- [ ] `opencode web --help` 与 hostname/port 参数一致。
- [ ] 桌面图标出现，双击在飞牛窗口打开，端口修改后入口与服务一致。
- [ ] 无密码及错误密码均不能访问会话、文件、Shell、Provider API；正确密码登录。
- [ ] 检查实际 HTML 的 X-Frame-Options、CSP；窗口内认证挑战正常。
- [ ] HTTP 飞牛入口能打开；记录 HTTPS mixed content 情况。
- [ ] 健康 API 正常，重复启动不产生多服务，端口占用时明确报错。
- [ ] 伪造/陈旧 pidfile 不误杀其他进程，服务停止后 PTY 任务不会遗留。
- [ ] 文件管理器可放入 `OpenCode/projects/test-project`，包用户可读写；未授权目录无法写入。
- [ ] `git`、`node`、`npm`、`pnpm`、`python3`、`java`、`mvn` 命令可执行。
- [ ] 创建 Session，让 Agent 创建 test.txt、修改内容、执行 ls 和 git status；核实磁盘实际内容与退出码。
- [ ] DeepSeek / OpenCode Go / OpenRouter 至少验证目标 Provider；真实模型回复不能用假 SSE 代替。
- [ ] 配置 OpenAI Compatible 及 NAS 可访问的 Ollama/LM Studio，实际请求与多轮对话成功。
- [ ] SSE 即时更新，长任务、页面刷新恢复、重启后会话持久化。
- [ ] PTY 打开、输入、resize、长输出、Ctrl+C、交互命令与连接恢复成功。
- [ ] Ctrl+C/Ctrl+V、Clipboard API、附件上传、拖拽与窗口快捷键逐项记录。
- [ ] 日志超过阈值时轮转，上游内部日志容量策略可接受；日志不包含 Web 密码。
- [ ] 修改设置后原有运行状态恢复，停止状态不被意外启动。
- [ ] 升级前备份完整；升级后配置、Provider、Session、数据库和项目仍在。
- [ ] 升级失败时重新安装旧包并恢复对应旧数据库成功。
- [ ] 卸载默认产生可解密备份；重装恢复成功；错误密码和路径穿越归档被拒绝。
- [ ] 删除私有数据选项实际清理私有数据；两种卸载选项均不删除项目。

通过 x86_64 验收后再开启 ARM64，之后研究 HTTPS 与统一网关。
