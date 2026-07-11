数据目录收口（已完成，2026-07-11）

- 所有 Terax 自有持久化文件统一通过 `src-tauri/src/modules/app_data.rs` 写入 `~/.terax`。
- 共享配置、AI 会话、Workspace 状态、窗口状态、SSH host key、shell integration 和日志各自使用固定子目录。
- 不读取或迁移旧 AppData。操作系统凭据库、WebView 私有存储和外部工具配置保持原有位置。