//! Terax 原生能力模块注册表。
//!
//! 每个子模块负责一类系统边界，具体 Tauri command 仍由 crate 入口显式注册。

pub mod agent;
pub use terax_core::modules::ai_sessions;
pub use terax_core::modules::app_data;
pub mod auxiliary_window;
pub mod clipboard_files;
pub mod clipboard_images;
#[cfg(windows)]
pub mod editor_menu;
pub mod external_agent;
pub mod file_actions;
pub mod fs;
pub mod git;
pub mod history;
pub mod lsp;
pub mod markdown_images;
pub use terax_core::modules::net;
pub use terax_core::modules::network_proxy;
pub mod notifications;
pub mod open_with;
pub use terax_core::modules::proc;
pub mod pty;
pub mod python;
pub mod remote;
pub mod screenshots;
pub use terax_core::modules::secrets;
pub use terax_core::modules::shared_store;
pub use terax_core::modules::shell;
pub use terax_core::modules::storage;
pub mod transfers;
pub use terax_core::modules::workspace;
pub mod workspace_process;
pub mod workspace_runtime;
