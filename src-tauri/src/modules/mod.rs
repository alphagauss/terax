//! Terax 原生能力模块注册表。
//!
//! 每个子模块负责一类系统边界，具体 Tauri command 仍由 crate 入口显式注册。

pub mod agent;
pub mod ai_sessions;
pub mod app_data;
pub mod fs;
pub mod git;
pub mod history;
pub mod lsp;
pub mod net;
pub mod open_with;
pub mod proc;
pub mod pty;
pub mod remote;
pub mod secrets;
pub mod shared_store;
pub mod shell;
pub mod storage;
pub mod transfers;
pub mod workspace;
pub mod workspace_process;
