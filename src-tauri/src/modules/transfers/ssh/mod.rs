//! SSH 文件传输数据面。
//!
//! 本模块只负责任务独占 channel 和 SFTP 数据流，不持有任务快照或 Explorer 会话。

pub(crate) mod archive;
pub(crate) mod direct;
pub(crate) mod session;
