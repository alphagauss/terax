//! 宿主注入异步运行时句柄，供阻塞文件与 Git 边界访问同一 SSH 运行时。

use std::future::Future;
use std::sync::OnceLock;
use tokio::runtime::Handle;
use tokio::task::JoinHandle;

static RUNTIME: OnceLock<Handle> = OnceLock::new();

/// 在处理业务请求前绑定宿主运行时；核心不创建另一套执行器。
pub fn set_runtime(handle: Handle) {
    RUNTIME
        .set(handle)
        .expect("native runtime already initialized");
}

/// 仅在同步入口或阻塞任务线程中等待，不得从异步任务直接调用。
pub fn block_on<F: Future>(future: F) -> F::Output {
    handle().block_on(future)
}

fn handle() -> Handle {
    Handle::try_current().unwrap_or_else(|_| {
        RUNTIME
            .get()
            .expect("native runtime is not initialized")
            .clone()
    })
}

/// 原生回调线程也可将任务投递到宿主运行时，不要求调用方处于异步上下文。
pub fn spawn<F>(future: F) -> JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    handle().spawn(future)
}

/// 阻塞操作使用同一宿主的阻塞线程池。
pub fn spawn_blocking<F, R>(operation: F) -> JoinHandle<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    handle().spawn_blocking(operation)
}
