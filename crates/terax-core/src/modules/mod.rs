//! 原生业务模块，禁止依赖桌面窗口与通信框架。

pub mod ai_sessions;
pub mod app_data;
pub mod fs;
pub mod network_proxy;
pub mod proc;
#[cfg(feature = "workspace-runtime")]
pub mod remote;
pub mod secrets;
pub mod shared_store;
pub mod shell;
pub mod storage;
pub mod workspace;
#[cfg(feature = "workspace-runtime")]
pub mod workspace_capabilities;
#[cfg(feature = "workspace-runtime")]
pub mod workspace_identity;
