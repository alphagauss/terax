//! Alpha 本机单例服务集成。
//!
//! 本模块负责内嵌源码释放、共享解释器配置，以及跨 Terax 进程幂等的服务控制。
//! Alpha 是否运行始终由受认证健康检查判定，不在各窗口复制生命周期状态。

pub mod commands;
mod runtime_files;
mod service;

pub use service::schedule_delayed_start;
