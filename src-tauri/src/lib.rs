//! Terax 共享原生服务入口。
//!
//! 默认 desktop 特性注册 Tauri 宿主；无界面构建不链接 WebView 或窗口插件。

#[cfg(feature = "desktop")]
mod desktop;
#[cfg(feature = "desktop")]
mod fullscreen;
#[cfg(feature = "desktop")]
pub mod menu;
pub mod modules;
#[cfg(feature = "desktop")]
pub use desktop::run;
pub mod adapters;
