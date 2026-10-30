//! 宿主注入的事件和流式输出出口，不拥有业务状态或执行生命周期。

use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;

type Emit = dyn Fn(&str, Value) -> Result<(), String> + Send + Sync;

/// 广播业务事件；序列化保持既有事件名称和 payload 结构。
#[derive(Clone)]
pub struct EventSink(Arc<Emit>);

impl EventSink {
    pub fn new(emit: impl Fn(&str, Value) -> Result<(), String> + Send + Sync + 'static) -> Self {
        Self(Arc::new(emit))
    }

    pub fn emit(&self, event: &str, payload: impl Serialize) -> Result<(), String> {
        (self.0)(
            event,
            serde_json::to_value(payload).map_err(|error| error.to_string())?,
        )
    }
}

/// 单个会话的有类型输出，原始字节不经过 JSON 编码。
pub struct OutputSink<T>(Arc<dyn Fn(T) -> Result<(), String> + Send + Sync>);

impl<T> Clone for OutputSink<T> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<T> OutputSink<T> {
    pub fn new(send: impl Fn(T) -> Result<(), String> + Send + Sync + 'static) -> Self {
        Self(Arc::new(send))
    }

    pub fn send(&self, value: T) -> Result<(), String> {
        (self.0)(value)
    }
}
