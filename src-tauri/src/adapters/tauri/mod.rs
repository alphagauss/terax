//! 桌面宿主的共享能力入口。
//!
//! 仅属于桌面 crate，共享业务由 terax-core 提供。

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

pub(crate) mod host;
