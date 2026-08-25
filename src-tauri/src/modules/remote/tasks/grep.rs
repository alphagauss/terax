//! SSH GNU grep 字面量搜索任务的固定命令适配器。
//!
//! 本模块只接受已验证的路径、模式和布尔选项；路径过滤和 Rust matcher 仍由搜索服务
//! 统一收敛，避免把 GNU glob 或单词边界语义当成公共搜索契约。

use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::modules::remote::session::{
    shell_quote, validate_remote_path, ExecOutput, RemoteWorkspace,
};

use super::TaskKind;

const SOURCE: &str = include_str!("scripts/grep_content.sh");
const TIMEOUT: Duration = Duration::from_secs(30);
const OUTPUT_LIMIT: usize = 16 * 1024 * 1024;

/// 服务端字面量搜索的封闭参数。
pub(crate) struct ContentRequest<'a> {
    pub(crate) root: &'a str,
    pub(crate) pattern: &'a str,
    pub(crate) ignore_case: bool,
    pub(crate) whole_word: bool,
    pub(crate) max_depth: usize,
    pub(crate) max_size: u64,
}

/// 使用服务端 GNU find 与 grep 执行字面量内容搜索。
pub(crate) async fn content(
    workspace: &Arc<RemoteWorkspace>,
    request: ContentRequest<'_>,
    cancellation: Option<&CancellationToken>,
) -> Result<ExecOutput, String> {
    validate_remote_path(request.root)?;
    if !request.root.starts_with('/') {
        return Err("remote grep search requires an absolute root".into());
    }
    let script = format!(
        "target_path={}; pattern={}; ignore_case={}; whole_word={}; max_depth={}; max_size={}; probe_features={}; {SOURCE}",
        shell_quote(request.root),
        shell_quote(request.pattern),
        usize::from(request.ignore_case),
        usize::from(request.whole_word),
        request.max_depth,
        request.max_size,
        usize::from(workspace.tasks.should_probe(TaskKind::GrepContent)),
    );
    let command = format!(
        "command -v bash >/dev/null 2>&1 || exit 127; exec bash -c {}",
        shell_quote(&script)
    );
    match cancellation {
        Some(cancellation) => {
            workspace
                .tasks
                .run_cancellable(
                    workspace,
                    TaskKind::GrepContent,
                    &command,
                    TIMEOUT,
                    OUTPUT_LIMIT,
                    cancellation,
                )
                .await
        }
        None => {
            workspace
                .tasks
                .run(
                    workspace,
                    TaskKind::GrepContent,
                    &command,
                    None,
                    TIMEOUT,
                    OUTPUT_LIMIT,
                )
                .await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::SOURCE;

    #[test]
    fn script_prunes_hidden_and_heavy_directories() {
        assert!(SOURCE.contains("-name '.*' -prune"));
        assert!(SOURCE.contains("-name node_modules"));
        assert!(SOURCE.contains("-size \"-$((max_size + 1))c\""));
        assert!(SOURCE.contains("grep_options=(-F -n -H -Z -I)"));
    }
}
