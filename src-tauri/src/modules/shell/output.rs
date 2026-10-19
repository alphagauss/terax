//! Agent 进程 stdout 与 stderr 的有界增量记录。
//!
//! 输出按全局字节 offset 排序，读取方只维护一个 cursor；缓冲区淘汰和单次响应
//! 截断都会显式返回，避免模型在重试或长任务输出中静默丢失上下文。

use std::collections::VecDeque;

const OUTPUT_CAPACITY: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy)]
pub enum OutputStream {
    Stdout,
    Stderr,
}

struct OutputChunk {
    start: u64,
    stream: OutputStream,
    bytes: Vec<u8>,
}

#[derive(Default)]
pub struct OutputLog {
    chunks: VecDeque<OutputChunk>,
    retained: usize,
    next_offset: u64,
    pending_stdout: Vec<u8>,
    pending_stderr: Vec<u8>,
}

pub struct OutputSlice {
    pub stdout: String,
    pub stderr: String,
    pub next_offset: u64,
    pub available_from: u64,
    pub dropped_bytes: u64,
    pub truncated: bool,
}

impl OutputLog {
    /// 追加一段输出，并只保留最近 4 MiB。
    pub fn push(&mut self, stream: OutputStream, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let pending = match stream {
            OutputStream::Stdout => &mut self.pending_stdout,
            OutputStream::Stderr => &mut self.pending_stderr,
        };
        pending.extend_from_slice(bytes);
        let (decoded, incomplete) = decode_available(std::mem::take(pending));
        *pending = incomplete;
        self.push_decoded(stream, decoded);
    }

    /// 流结束时将不足一个 UTF-8 字符的尾部按替换字符落盘。
    pub fn finish_stream(&mut self, stream: OutputStream) {
        let pending = match stream {
            OutputStream::Stdout => &mut self.pending_stdout,
            OutputStream::Stderr => &mut self.pending_stderr,
        };
        let pending = std::mem::take(pending);
        if !pending.is_empty() {
            self.push_decoded(
                stream,
                String::from_utf8_lossy(&pending).into_owned().into_bytes(),
            );
        }
    }

    fn push_decoded(&mut self, stream: OutputStream, mut bytes: Vec<u8>) {
        if bytes.is_empty() {
            return;
        }
        let incoming_start = self.next_offset;
        self.next_offset = self.next_offset.saturating_add(bytes.len() as u64);
        let mut skipped = bytes.len().saturating_sub(OUTPUT_CAPACITY);
        while skipped < bytes.len() && is_utf8_continuation(bytes[skipped]) {
            skipped += 1;
        }
        if skipped > 0 {
            bytes = bytes.split_off(skipped);
        }
        let kept = bytes.len();
        self.chunks.push_back(OutputChunk {
            start: incoming_start.saturating_add(skipped as u64),
            stream,
            bytes,
        });
        self.retained = self.retained.saturating_add(kept);
        self.trim_to(OUTPUT_CAPACITY);
    }

    /// 从全局 offset 读取最多 `max_bytes`，并分别聚合 stdout 与 stderr。
    pub fn read(&self, since: u64, max_bytes: usize) -> OutputSlice {
        let available_from = self
            .chunks
            .front()
            .map(|chunk| chunk.start)
            .unwrap_or(self.next_offset);
        let requested = since.min(self.next_offset);
        let start = requested.max(available_from);
        let mut cursor = start;
        let mut remaining = max_bytes;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();

        for chunk in &self.chunks {
            let end = chunk.start.saturating_add(chunk.bytes.len() as u64);
            if end <= cursor {
                continue;
            }
            if remaining == 0 {
                break;
            }
            let mut skip = cursor.saturating_sub(chunk.start) as usize;
            while skip < chunk.bytes.len() && is_utf8_continuation(chunk.bytes[skip]) {
                skip += 1;
                cursor = cursor.saturating_add(1);
            }
            let mut take = remaining.min(chunk.bytes.len().saturating_sub(skip));
            while take > 0
                && skip + take < chunk.bytes.len()
                && is_utf8_continuation(chunk.bytes[skip + take])
            {
                take -= 1;
            }
            if take == 0 {
                break;
            }
            let target = match chunk.stream {
                OutputStream::Stdout => &mut stdout,
                OutputStream::Stderr => &mut stderr,
            };
            target.extend_from_slice(&chunk.bytes[skip..skip + take]);
            remaining -= take;
            cursor = cursor.saturating_add(take as u64);
        }

        OutputSlice {
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            next_offset: cursor,
            available_from,
            dropped_bytes: available_from.saturating_sub(requested),
            truncated: cursor < self.next_offset,
        }
    }

    pub fn next_offset(&self) -> u64 {
        self.next_offset
    }

    /// 进程结束后进一步压缩保留输出，避免终态记录长期占用完整运行缓冲。
    pub fn compact(&mut self, capacity: usize) {
        self.trim_to(capacity);
    }

    fn trim_to(&mut self, capacity: usize) {
        while self.retained > capacity {
            let overflow = self.retained - capacity;
            let Some(front) = self.chunks.front_mut() else {
                break;
            };
            if front.bytes.len() <= overflow {
                self.retained -= front.bytes.len();
                self.chunks.pop_front();
            } else {
                let mut remove = overflow;
                while remove < front.bytes.len() && is_utf8_continuation(front.bytes[remove]) {
                    remove += 1;
                }
                front.bytes.drain(..remove);
                front.start = front.start.saturating_add(remove as u64);
                self.retained -= remove;
            }
        }
    }
}

fn decode_available(bytes: Vec<u8>) -> (Vec<u8>, Vec<u8>) {
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut consumed = 0;
    while consumed < bytes.len() {
        match std::str::from_utf8(&bytes[consumed..]) {
            Ok(_) => {
                decoded.extend_from_slice(&bytes[consumed..]);
                consumed = bytes.len();
            }
            Err(error) => {
                let valid_end = consumed + error.valid_up_to();
                decoded.extend_from_slice(&bytes[consumed..valid_end]);
                consumed = valid_end;
                let Some(error_len) = error.error_len() else {
                    break;
                };
                decoded.extend_from_slice("�".as_bytes());
                consumed += error_len;
            }
        }
    }
    (decoded, bytes[consumed..].to_vec())
}

fn is_utf8_continuation(byte: u8) -> bool {
    byte & 0b1100_0000 == 0b1000_0000
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_cursor_preserves_both_streams() {
        let mut log = OutputLog::default();
        log.push(OutputStream::Stdout, b"out");
        log.push(OutputStream::Stderr, b"err");

        let first = log.read(0, 4);
        assert_eq!(first.stdout, "out");
        assert_eq!(first.stderr, "e");
        assert_eq!(first.next_offset, 4);
        assert!(first.truncated);
        assert_eq!(first.dropped_bytes, 0);

        let second = log.read(first.next_offset, 8);
        assert_eq!(second.stderr, "rr");
        assert_eq!(second.next_offset, 6);
        assert!(!second.truncated);
        assert_eq!(second.dropped_bytes, 0);
    }

    #[test]
    fn reports_bytes_evicted_before_requested_offset() {
        let mut log = OutputLog::default();
        log.push(OutputStream::Stdout, &vec![b'a'; OUTPUT_CAPACITY + 7]);

        let slice = log.read(0, 16);
        assert_eq!(slice.available_from, 7);
        assert_eq!(slice.dropped_bytes, 7);
        assert_eq!(slice.stdout.len(), 16);
    }

    #[test]
    fn future_offset_is_clamped_to_current_tail() {
        let mut log = OutputLog::default();
        log.push(OutputStream::Stdout, b"abc");
        let slice = log.read(99, 10);
        assert_eq!(slice.next_offset, 3);
        assert!(slice.stdout.is_empty());
    }

    #[test]
    fn compact_keeps_only_the_latest_bytes() {
        let mut log = OutputLog::default();
        log.push(OutputStream::Stdout, b"abcdefgh");
        log.compact(3);
        let slice = log.read(0, 10);
        assert_eq!(slice.stdout, "fgh");
        assert_eq!(slice.available_from, 5);
        assert_eq!(slice.dropped_bytes, 5);
    }

    #[test]
    fn preserves_utf8_across_push_and_read_boundaries() {
        let mut log = OutputLog::default();
        let text = "a你b".as_bytes();
        log.push(OutputStream::Stdout, &text[..2]);
        log.push(OutputStream::Stdout, &text[2..]);

        let first = log.read(0, 2);
        assert_eq!(first.stdout, "a");
        assert_eq!(first.next_offset, 1);
        let second = log.read(first.next_offset, 4);
        assert_eq!(second.stdout, "你b");
        assert!(!second.truncated);
    }

    #[test]
    fn compact_starts_at_a_utf8_boundary() {
        let mut log = OutputLog::default();
        log.push(OutputStream::Stdout, "a你".as_bytes());
        log.compact(3);

        let slice = log.read(0, 8);
        assert_eq!(slice.stdout, "你");
        assert_eq!(slice.available_from, 1);
    }
}
