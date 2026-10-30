//! 桌面宿主入口，接入原生核心并管理 Tauri 窗口、插件与命令。

pub mod adapters;
mod desktop;
mod fullscreen;
pub mod menu;
pub mod modules;
pub use desktop::run;
