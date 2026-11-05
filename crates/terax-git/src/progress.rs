//! 从本地 Git 的 stderr 提取有界阶段进度；展示通道失效不影响命令执行。

use std::time::{Duration, Instant};
use terax_core::events::OutputSink;

use crate::types::{GitProgress, GitProgressStage};

pub(crate) struct ProgressReader {
    sink: OutputSink<Option<GitProgress>>,
    line: Vec<u8>,
    overflow: bool,
    last: Option<GitProgress>,
    sent_at: Option<Instant>,
}

impl ProgressReader {
    pub(crate) fn new(sink: OutputSink<Option<GitProgress>>) -> Self {
        Self {
            sink,
            line: Vec::new(),
            overflow: false,
            last: None,
            sent_at: None,
        }
    }

    pub(crate) fn feed(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            if byte == b'\r' || byte == b'\n' {
                if !self.line.is_empty() || self.overflow {
                    let progress = (!self.overflow).then(|| parse(&self.line)).flatten();
                    self.publish(progress, Instant::now());
                }
                self.line.clear();
                self.overflow = false;
            } else if self.line.len() < 1024 {
                self.line.push(byte);
            } else {
                self.overflow = true;
            }
        }
    }

    fn publish(&mut self, progress: Option<GitProgress>, now: Instant) {
        if progress == self.last {
            return;
        }
        // 同阶段最多每 100ms 发布一次；阶段切换、完成和回到执行态立即可见。
        if let (Some(next), Some(last), Some(sent_at)) = (progress, self.last, self.sent_at) {
            if next.stage == last.stage
                && next.percent != 100
                && now.duration_since(sent_at) < Duration::from_millis(100)
            {
                return;
            }
        }
        let _ = self.sink.send(progress);
        self.last = progress;
        self.sent_at = Some(now);
    }

    pub(crate) fn finish(&mut self) {
        self.publish(None, Instant::now());
    }
}

fn parse(line: &[u8]) -> Option<GitProgress> {
    let line = std::str::from_utf8(line).ok()?.trim();
    let line = line.strip_prefix("remote: ").unwrap_or(line).trim_start();
    let (label, value) = line.split_once(':')?;
    let stage = match label {
        "Counting objects" => GitProgressStage::Counting,
        "Compressing objects" => GitProgressStage::Compressing,
        "Receiving objects" => GitProgressStage::Receiving,
        "Unpacking objects" => GitProgressStage::Unpacking,
        "Resolving deltas" => GitProgressStage::Resolving,
        "Writing objects" => GitProgressStage::Writing,
        "Updating files" => GitProgressStage::Updating,
        _ => return None,
    };
    let (percent, _) = value.trim_start().split_once('%')?;
    let percent = percent
        .parse::<u8>()
        .ok()
        .filter(|percent| *percent <= 100)?;
    Some(GitProgress { stage, percent })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn fragmented_crlf_progress_is_bounded_and_unknown_output_clears_the_stage() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let output = events.clone();
        let mut reader = ProgressReader::new(OutputSink::new(move |progress| {
            output.lock().unwrap().push(progress);
            Ok(())
        }));
        reader.feed(b"remote: Compressing obj");
        reader.feed(b"ects:  65% (13/20)\r\n");
        reader.feed(b"Receiving objects: 100% (20/20), 1.2 MiB | 2 MiB/s, done.\r");
        reader.feed(b"fatal: connection lost\n");
        assert_eq!(events.lock().unwrap().len(), 3);
        assert_eq!(events.lock().unwrap()[0].unwrap().percent, 65);
        assert_eq!(
            events.lock().unwrap()[1].unwrap().stage,
            GitProgressStage::Receiving
        );
        assert_eq!(events.lock().unwrap()[2], None);
        reader.feed(&vec![b'x'; 4096]);
        assert_eq!(reader.line.len(), 1024);
        reader.feed(b"Receiving objects: 50%\n");
        assert_eq!(events.lock().unwrap().len(), 3);
        for line in [
            b"Counting objects: 101%".as_slice(),
            b"warning: 30%",
            b"Receiving objects: -1%",
            b"\xff: 1%",
        ] {
            assert!(parse(line).is_none());
        }
        reader.feed(b"Writing objects: 10%\r");
        reader.finish();
        assert_eq!(events.lock().unwrap().last(), Some(&None));
    }

    #[test]
    fn percentage_updates_are_throttled_but_stage_changes_and_completion_are_immediate() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let output = events.clone();
        let mut reader = ProgressReader::new(OutputSink::new(move |progress| {
            output.lock().unwrap().push(progress);
            // 展示接收方消失不应中断 Git。
            Err("closed".into())
        }));
        let now = Instant::now();
        let progress = |stage, percent| Some(GitProgress { stage, percent });
        reader.publish(progress(GitProgressStage::Receiving, 1), now);
        reader.publish(
            progress(GitProgressStage::Receiving, 2),
            now + Duration::from_millis(50),
        );
        reader.publish(
            progress(GitProgressStage::Receiving, 3),
            now + Duration::from_millis(100),
        );
        reader.publish(
            progress(GitProgressStage::Receiving, 100),
            now + Duration::from_millis(101),
        );
        reader.publish(
            progress(GitProgressStage::Resolving, 1),
            now + Duration::from_millis(102),
        );
        assert_eq!(events.lock().unwrap().len(), 4);
    }
}
