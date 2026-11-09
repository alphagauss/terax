//! 在当前 SSH 环境执行固定的文件树粘贴任务。

use std::sync::Arc;
use std::time::Duration;

use super::TaskKind;
use crate::modules::fs::paste::SCRIPT;
use crate::modules::remote::session::{shell_quote, RemoteWorkspace};

pub(crate) async fn run(
    workspace: &Arc<RemoteWorkspace>,
    args: &[String],
) -> Result<String, String> {
    let mut command = format!("exec bash -c {} terax-paste", shell_quote(SCRIPT));
    for arg in args {
        command.push(' ');
        command.push_str(&shell_quote(arg));
    }
    let output = workspace
        .tasks
        .run(
            workspace,
            TaskKind::ExplorerPaste,
            &command,
            None,
            Duration::from_secs(1800),
            4096,
        )
        .await?;
    if output.timed_out {
        return Err("remote paste timed out".into());
    }
    if output.exit_code != Some(0) {
        let diagnostic = String::from_utf8_lossy(&output.stderr);
        return Err(if diagnostic.trim().is_empty() {
            format!("remote paste failed with status {:?}", output.exit_code)
        } else {
            diagnostic.trim().to_owned()
        });
    }
    String::from_utf8(output.stdout).map_err(|error| error.to_string())
}
