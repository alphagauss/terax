//! 原生能力的宿主接入边界。
//!
//! 宿主只负责启动、请求映射与通知出口，共享服务不依赖通信协议。

#[cfg(feature = "headless")]
pub mod stdio;
#[cfg(feature = "desktop")]
pub mod tauri;
