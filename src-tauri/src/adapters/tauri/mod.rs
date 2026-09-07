//! 桌面宿主的共享能力入口。
//!
//! 整个模块由 desktop 特性控制，命令本身无需重复声明宿主条件。

pub mod agent;
pub mod files;
pub mod mutate;
pub mod net;
pub mod network;
pub mod search;
pub mod secrets;
pub mod sessions;
pub mod shell;
pub mod store;
pub mod tree;
pub mod workspace;
