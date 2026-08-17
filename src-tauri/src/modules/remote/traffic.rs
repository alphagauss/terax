//! SSH transport 的进程级双向流量统计。
//!
//! 本模块在 russh 接管连接前包装底层流，只累计本机与远端之间实际完成的读写字节。
//! 计数器跨 SSH 重连复用，不解析 channel，也不参与持久化。

use std::io::IoSlice;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use super::models::SshTrafficSnapshot;

/// 当前进程共享的 SSH 收发字节计数器。
#[derive(Default)]
pub(super) struct SshTrafficMeter {
    uploaded_bytes: AtomicU64,
    downloaded_bytes: AtomicU64,
}

impl SshTrafficMeter {
    /// 返回不会重置计数器的累计快照。
    pub(super) fn snapshot(&self) -> SshTrafficSnapshot {
        SshTrafficSnapshot {
            uploaded_bytes: self.uploaded_bytes.load(Ordering::Relaxed),
            downloaded_bytes: self.downloaded_bytes.load(Ordering::Relaxed),
        }
    }

    fn record_upload(&self, bytes: usize) {
        if bytes == 0 {
            return;
        }
        self.uploaded_bytes
            .fetch_add(bytes as u64, Ordering::Relaxed);
    }

    fn record_download(&self, bytes: usize) {
        if bytes == 0 {
            return;
        }
        self.downloaded_bytes
            .fetch_add(bytes as u64, Ordering::Relaxed);
    }
}

/// 在不改变原始流行为的前提下记录成功完成的 SSH transport 读写。
pub(super) struct CountingSshStream<S> {
    inner: S,
    traffic: Arc<SshTrafficMeter>,
}

impl<S> CountingSshStream<S> {
    pub(super) fn new(inner: S, traffic: Arc<SshTrafficMeter>) -> Self {
        Self { inner, traffic }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for CountingSshStream<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let before = buffer.filled().len();
        let result = Pin::new(&mut self.inner).poll_read(cx, buffer);
        if matches!(result, Poll::Ready(Ok(()))) {
            self.traffic
                .record_download(buffer.filled().len().saturating_sub(before));
        }
        result
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for CountingSshStream<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let result = Pin::new(&mut self.inner).poll_write(cx, buffer);
        if let Poll::Ready(Ok(written)) = result {
            self.traffic.record_upload(written);
        }
        result
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffers: &[IoSlice<'_>],
    ) -> Poll<std::io::Result<usize>> {
        let result = Pin::new(&mut self.inner).poll_write_vectored(cx, buffers);
        if let Poll::Ready(Ok(written)) = result {
            self.traffic.record_upload(written);
        }
        result
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    #[tokio::test]
    async fn counts_completed_reads_and_writes_by_transport_direction() {
        let traffic = Arc::new(SshTrafficMeter::default());
        let (mut peer, stream) = tokio::io::duplex(64);
        let mut stream = CountingSshStream::new(stream, traffic.clone());

        peer.write_all(b"download").await.unwrap();
        let mut downloaded = [0; 8];
        stream.read_exact(&mut downloaded).await.unwrap();
        assert_eq!(&downloaded, b"download");

        stream.write_all(b"upload").await.unwrap();
        let mut uploaded = [0; 6];
        peer.read_exact(&mut uploaded).await.unwrap();
        assert_eq!(&uploaded, b"upload");

        assert_eq!(
            traffic.snapshot(),
            SshTrafficSnapshot {
                uploaded_bytes: 6,
                downloaded_bytes: 8,
            }
        );
    }
}
