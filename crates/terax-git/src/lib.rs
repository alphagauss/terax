//! Git 仓库操作与命令执行，复用 terax-core 的工作区授权和远端会话。

mod batch;
pub mod errors;
mod network;
pub mod operations;
mod parser;
mod process;
pub mod types;
mod utils;
