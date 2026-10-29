//! SSH 任务私有 staging 的受限清理与断线重试。
//!
//! 传输连接中断时，原会话无法立即删除任务私有路径。本模块在当前 Workspace 进程
//! 内保留 staging ID、聚合历史任务 ID、稳定 SSH 端点与精确目标父目录，等待同一
//! 端点重连后只清理匹配该授权的 staging。用户选择的传输范围与删除授权相互独立。

use std::sync::Arc;
use std::time::Duration;

use crate::modules::remote::manager::global_manager;
use crate::modules::remote::session::{shell_quote, RemoteWorkspace};

use super::super::cleanup_ticket::{CleanupTicket, CleanupTicketTarget};
use super::super::errors::TransferErrorCode;
use super::super::manager::TransferRunError;

const CLEANUP_RETRY_INTERVAL: Duration = Duration::from_secs(2);
const CLEANUP_RETRY_WINDOW: Duration = Duration::from_secs(10 * 60);
const CLEANUP_COMMAND_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_CLEANUP_COMMAND_BYTES: usize = 160 * 1024;
// 正常树只遍历一次；回退必须在 find 下沉前逐目录立即 chmod，`{} +` 会过晚执行。
const CLEANUP_COMMAND_START: &str = r#"terax_remove_owned_path() {
  path=$1
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    return 0
  fi
  if [ -d "$path" ] && [ ! -L "$path" ]; then
    parent=${path%/*}
    [ -n "$parent" ] || parent=/
    path_device=$(stat -c %d -- "$path") || return 1
    parent_device=$(stat -c %d -- "$parent") || return 1
    [ "$path_device" = "$parent_device" ] || return 1
  fi
  if find -P "$path" -xdev -depth -delete 2>/dev/null; then
    return 0
  fi
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    return 0
  fi
  if [ ! -d "$path" ] || [ -L "$path" ]; then
    find -P "$path" -xdev -depth -delete
    return $?
  fi
  chmod u+rwx -- "$path" || return 1
  find -P "$path" -xdev -type d -exec sh -c '
    expected_device=$1
    directory=$2
    directory_device=$(stat -c %d -- "$directory") || exit 1
    [ "$directory_device" = "$expected_device" ] || exit 0
    chmod u+rwx -- "$directory"
  ' terax-cleanup "$path_device" {} \; || return 1
  find -P "$path" -xdev -depth -delete
}
set --"#;
const CLEANUP_COMMAND_END: &str = r#"
terax_cleanup_status=0
for path do
  if ! terax_remove_owned_path "$path"; then
    terax_cleanup_status=1
  fi
done
[ "$terax_cleanup_status" -eq 0 ]"#;

/// 单个传输任务持有的远端删除授权。
///
/// 相邻 staging 只能位于规划阶段得到的规范目标父目录，名称必须携带同一任务 ID。
/// SSH Archive 下载使用的 `/tmp` 目录另按 `mktemp` 固定格式校验。
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
pub(crate) struct RemoteCleanupScope {
    profile_id: String,
    endpoint_host: String,
    endpoint_port: u16,
    endpoint_username: String,
    task_id: String,
    owner_task_id: String,
    staging_parents: Vec<String>,
    allow_download_tmp: bool,
}

impl RemoteCleanupScope {
    /// 从 SSH 上传计划的最终目标生成精确清理范围。
    pub(crate) fn for_upload<'a>(
        workspace: &RemoteWorkspace,
        task_id: String,
        owner_task_id: String,
        final_paths: impl IntoIterator<Item = &'a str>,
    ) -> Self {
        let mut staging_parents: Vec<_> = final_paths
            .into_iter()
            .filter_map(|path| remote_parent(path).map(str::to_string))
            .collect();
        staging_parents.sort();
        staging_parents.dedup();
        Self {
            profile_id: workspace.profile.id.clone(),
            endpoint_host: workspace.profile.host.to_ascii_lowercase(),
            endpoint_port: workspace.profile.port,
            endpoint_username: workspace.profile.username.clone(),
            task_id,
            owner_task_id,
            staging_parents,
            allow_download_tmp: false,
        }
    }

    /// 创建只允许清理 SSH Archive 下载临时目录的范围。
    pub(crate) fn for_download(
        workspace: &RemoteWorkspace,
        task_id: String,
        owner_task_id: String,
    ) -> Self {
        Self {
            profile_id: workspace.profile.id.clone(),
            endpoint_host: workspace.profile.host.to_ascii_lowercase(),
            endpoint_port: workspace.profile.port,
            endpoint_username: workspace.profile.username.clone(),
            task_id,
            owner_task_id,
            staging_parents: Vec::new(),
            allow_download_tmp: true,
        }
    }

    /// 为经过当前端点和路径授权校验的 backup 创建 recovery 票据。
    pub(crate) fn cleanup_ticket(
        &self,
        paths: Vec<String>,
    ) -> Result<Option<CleanupTicket>, TransferRunError> {
        if paths.is_empty() {
            return Ok(None);
        }
        if paths
            .iter()
            .any(|path| !path.ends_with(".backup") || !self.owns(path))
        {
            return Err(TransferRunError::failed(
                TransferErrorCode::InvalidRequest,
                "invalid remote transfer cleanup path",
            ));
        }
        Ok(Some(CleanupTicket::recovery(CleanupTicketTarget::Ssh {
            profile_id: self.profile_id.clone(),
            endpoint_host: self.endpoint_host.clone(),
            endpoint_port: self.endpoint_port,
            endpoint_username: self.endpoint_username.clone(),
            staging_task_id: self.task_id.clone(),
            owner_task_id: self.owner_task_id.clone(),
            staging_parents: self.staging_parents.clone(),
            paths,
        })))
    }

    /// 从 Journal 票据恢复与原任务等价的远程清理授权。
    pub(crate) fn from_ticket(target: &CleanupTicketTarget) -> Option<(Self, Vec<String>)> {
        let CleanupTicketTarget::Ssh {
            profile_id,
            endpoint_host,
            endpoint_port,
            endpoint_username,
            staging_task_id,
            owner_task_id,
            staging_parents,
            paths,
        } = target
        else {
            return None;
        };
        let scope = Self {
            profile_id: profile_id.clone(),
            endpoint_host: endpoint_host.clone(),
            endpoint_port: *endpoint_port,
            endpoint_username: endpoint_username.clone(),
            task_id: staging_task_id.clone(),
            owner_task_id: owner_task_id.clone(),
            staging_parents: staging_parents.clone(),
            allow_download_tmp: false,
        };
        paths
            .iter()
            .all(|path| path.ends_with(".backup") && scope.owns(path))
            .then(|| (scope, paths.clone()))
    }

    /// 返回票据绑定的 profile，只用于取得当前 Workspace 连接。
    pub(crate) fn profile_id(&self) -> &str {
        &self.profile_id
    }
}

/// 在后台等待同一 SSH 端点恢复，并清理当前任务明确拥有的路径。
pub(crate) fn schedule(scope: RemoteCleanupScope, mut paths: Vec<String>) {
    paths.sort();
    paths.dedup();
    if paths.is_empty() {
        return;
    }
    let profile_id = scope.profile_id.clone();
    let owner_task_id = scope.owner_task_id.clone();
    super::super::manager::begin_deferred_cleanup(&owner_task_id);
    tauri::async_runtime::spawn(async move {
        if tokio::time::timeout(
            CLEANUP_RETRY_WINDOW,
            cleanup_after_reconnect(&scope, &paths),
        )
        .await
        .is_err()
        {
            log::warn!(
                "remote transfer cleanup expired for profile {profile_id}: {} path(s)",
                paths.len()
            );
        } else {
            super::super::manager::finish_deferred_cleanup(&owner_task_id);
        }
    });
}

/// 用少量服务器本地命令删除经过验证的任务私有路径，并返回仍需重试的路径。
///
/// 此入口只接受 Terax 生成的固定命名，拒绝任意用户路径。权限阻塞时只恢复
/// 任务私有树的目录 owner 权限，不跟随符号链接，也不会把文件数量放大为逐项 SFTP 往返。
pub(crate) async fn remove_now(
    workspace: &Arc<RemoteWorkspace>,
    scope: &RemoteCleanupScope,
    paths: &[String],
) -> Vec<String> {
    if paths.is_empty() {
        return Vec::new();
    }
    if !scope.matches_workspace(workspace) {
        log::warn!(
            "refused remote transfer cleanup for mismatched SSH endpoint on profile {}",
            scope.profile_id
        );
        return paths.to_vec();
    }
    if let Some(path) = paths.iter().find(|path| !scope.owns(path)) {
        log::warn!("refused to clean invalid remote transfer path: {path}");
        return paths.to_vec();
    }

    let mut remaining = Vec::new();
    for batch in cleanup_batches(paths) {
        let command = cleanup_command(batch.iter().copied());
        match workspace
            .exec(&command, None, CLEANUP_COMMAND_TIMEOUT)
            .await
        {
            Ok(output) if output.exit_code == Some(0) && !output.timed_out && !output.truncated => {
            }
            Ok(output) => {
                log::warn!(
                    "remote transfer cleanup command failed with exit {:?}: {}",
                    output.exit_code,
                    String::from_utf8_lossy(&output.stderr).trim()
                );
                remaining.extend(batch.into_iter().map(str::to_string));
            }
            Err(error) => {
                log::warn!("failed to start remote transfer cleanup: {error}");
                remaining.extend(batch.into_iter().map(str::to_string));
            }
        }
    }
    remaining
}

/// 循环等待 Workspace 重连，并用服务器本地递归删除重试尚未清理的路径。
async fn cleanup_after_reconnect(scope: &RemoteCleanupScope, paths: &[String]) {
    let mut remaining = paths.to_vec();
    loop {
        let workspace = match global_manager() {
            Ok(manager) => manager.workspace(&scope.profile_id).await.ok(),
            Err(_) => None,
        };
        if let Some(workspace) = workspace {
            remaining = remove_now(&workspace, scope, &remaining).await;
            if remaining.is_empty() {
                return;
            }
        }
        tokio::time::sleep(CLEANUP_RETRY_INTERVAL).await;
    }
}

/// 判断当前失败是否无法可靠使用现有 SSH 连接立即清理。
pub(crate) fn should_defer(result: &Result<(), TransferRunError>) -> bool {
    matches!(result, Err(TransferRunError::Canceled))
        || matches!(
            result,
            Err(TransferRunError::Failed(failure))
                if failure.code == TransferErrorCode::ConnectionLost
        )
}

fn cleanup_batches(paths: &[String]) -> Vec<Vec<&str>> {
    let mut batches = Vec::new();
    let mut batch = Vec::new();
    let mut command_bytes = CLEANUP_COMMAND_START.len() + CLEANUP_COMMAND_END.len();
    for path in paths {
        let argument_bytes = 1 + shell_quote(path).len();
        if !batch.is_empty() && command_bytes + argument_bytes > MAX_CLEANUP_COMMAND_BYTES {
            batches.push(std::mem::take(&mut batch));
            command_bytes = CLEANUP_COMMAND_START.len() + CLEANUP_COMMAND_END.len();
        }
        command_bytes += argument_bytes;
        batch.push(path.as_str());
    }
    if !batch.is_empty() {
        batches.push(batch);
    }
    batches
}

/// 为已校验所有权的路径生成同一份受限 Linux 删除脚本。
pub(crate) fn cleanup_command<'a>(paths: impl IntoIterator<Item = &'a str>) -> String {
    let mut command = String::from(CLEANUP_COMMAND_START);
    for path in paths {
        command.push(' ');
        command.push_str(&shell_quote(path));
    }
    command.push_str(CLEANUP_COMMAND_END);
    command
}

impl RemoteCleanupScope {
    /// 同时绑定 profile 与稳定端点，避免 profile 改绑后清理到另一台服务器。
    /// 确认当前 Workspace 仍连接票据捕获的同一稳定 endpoint。
    pub(crate) fn matches_workspace(&self, workspace: &RemoteWorkspace) -> bool {
        self.matches_endpoint(
            &workspace.profile.id,
            &workspace.profile.host,
            workspace.profile.port,
            &workspace.profile.username,
        )
    }

    /// 比较重连后的稳定端点字段，主机名不区分 ASCII 大小写。
    fn matches_endpoint(&self, profile_id: &str, host: &str, port: u16, username: &str) -> bool {
        profile_id == self.profile_id
            && host.eq_ignore_ascii_case(&self.endpoint_host)
            && port == self.endpoint_port
            && username == self.endpoint_username
    }

    /// 判断路径是否由当前任务生成且位于获准父目录。
    fn owns(&self, path: &str) -> bool {
        if uuid::Uuid::parse_str(&self.task_id).is_err()
            || !path.starts_with('/')
            || path == "/"
            || path.contains(['\0', '\r', '\n'])
            || path[1..].split('/').any(str::is_empty)
            || path
                .split('/')
                .any(|component| matches!(component, "." | ".."))
        {
            return false;
        }
        let Some(parent) = remote_parent(path) else {
            return false;
        };
        let name = path.rsplit('/').next().unwrap_or_default();
        if let Some(value) = name.strip_prefix(".terax-archive-") {
            return value == self.task_id && self.allows_parent(parent);
        }
        if parent == "/tmp" && self.allow_download_tmp {
            let prefix = format!("terax-archive.{}.", self.task_id);
            return name.strip_prefix(&prefix).is_some_and(|value| {
                value.len() == 8 && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
            });
        }
        let Some(value) = name.strip_prefix(".terax-part-") else {
            return false;
        };
        // `.backup` 只会在对应根已经成功公开后由执行器加入清理集合。
        let value = value.strip_suffix(".backup").unwrap_or(value);
        let Some((task_id, index)) = value.rsplit_once('-') else {
            return false;
        };
        task_id == self.task_id
            && self.allows_parent(parent)
            && !index.is_empty()
            && index.bytes().all(|byte| byte.is_ascii_digit())
    }

    fn allows_parent(&self, parent: &str) -> bool {
        self.staging_parents.iter().any(|allowed| allowed == parent)
    }
}

fn remote_parent(path: &str) -> Option<&str> {
    let (parent, name) = path.rsplit_once('/')?;
    if name.is_empty() {
        return None;
    }
    Some(if parent.is_empty() { "/" } else { parent })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_accepts_only_paths_owned_by_the_exact_task_and_parent() {
        let task = uuid::Uuid::new_v4();
        let stage = format!("/srv/releases/.terax-part-{task}-3");
        let scope = RemoteCleanupScope {
            profile_id: "profile".into(),
            endpoint_host: "server.example".into(),
            endpoint_port: 22,
            endpoint_username: "user".into(),
            task_id: task.to_string(),
            owner_task_id: task.to_string(),
            staging_parents: vec!["/srv/releases".into()],
            allow_download_tmp: false,
        };
        assert!(scope.owns(&stage));
        assert!(scope.owns(&format!("{stage}.backup")));
        assert!(scope.owns(&format!("/srv/releases/.terax-archive-{task}")));
        assert!(!scope.owns(&format!("/tmp/terax-archive.{task}.a1B2c3D4")));
        assert!(!scope.owns("/"));
        assert!(!scope.owns("/srv/releases/package"));
        assert!(!scope.owns("/srv/releases/.terax-part-not-a-uuid-0"));
        assert!(!scope.owns(&format!("/etc/.terax-part-{task}-0")));
        assert!(!scope.owns(&format!("/srv/releases/../.terax-archive-{task}")));
        assert!(!scope.owns(&format!(
            "/srv/releases/.terax-part-{}-0",
            uuid::Uuid::new_v4()
        )));
        assert!(scope.cleanup_ticket(vec![stage.clone()]).is_err());
        let ticket = scope
            .cleanup_ticket(vec![format!("{stage}.backup")])
            .unwrap()
            .unwrap();
        let (restored, paths) = RemoteCleanupScope::from_ticket(&ticket.target).unwrap();
        assert_eq!(restored.profile_id(), "profile");
        assert_eq!(paths, vec![format!("{stage}.backup")]);
        let mut invalid_target = ticket.target;
        let CleanupTicketTarget::Ssh { paths, .. } = &mut invalid_target else {
            unreachable!();
        };
        *paths = vec![stage.clone()];
        assert!(RemoteCleanupScope::from_ticket(&invalid_target).is_none());

        let download_scope = RemoteCleanupScope {
            allow_download_tmp: true,
            staging_parents: Vec::new(),
            ..scope.clone()
        };
        assert!(download_scope.owns(&format!("/tmp/terax-archive.{task}.a1B2c3D4")));
        assert!(!download_scope.owns("/tmp/terax-archive.a1B2c3D4"));
    }

    #[test]
    fn cleanup_scope_rejects_a_rebound_profile_endpoint() {
        let scope = RemoteCleanupScope {
            profile_id: "profile".into(),
            endpoint_host: "server.example".into(),
            endpoint_port: 22,
            endpoint_username: "user".into(),
            task_id: uuid::Uuid::new_v4().to_string(),
            owner_task_id: uuid::Uuid::new_v4().to_string(),
            staging_parents: Vec::new(),
            allow_download_tmp: true,
        };

        assert!(scope.matches_endpoint("profile", "SERVER.EXAMPLE", 22, "user"));
        assert!(!scope.matches_endpoint("profile", "other.example", 22, "user"));
        assert!(!scope.matches_endpoint("profile", "server.example", 2222, "user"));
        assert!(!scope.matches_endpoint("profile", "server.example", 22, "other"));
    }

    #[test]
    fn cleanup_commands_are_split_before_the_byte_limit() {
        let paths = vec![
            format!("/home/user/{}", "'".repeat(21_000)),
            format!("/home/user/{}", "'".repeat(21_000)),
        ];
        let batches = cleanup_batches(&paths);
        assert_eq!(batches.len(), 2);
        assert!(cleanup_command(batches[0].iter().copied()).len() <= MAX_CLEANUP_COMMAND_BYTES);
        assert!(cleanup_command(batches[1].iter().copied()).len() <= MAX_CLEANUP_COMMAND_BYTES);
    }

    #[test]
    fn maximally_quoted_transfer_path_fits_one_cleanup_command() {
        let path = "'".repeat(32 * 1_024);
        let paths = vec![path];
        let batches = cleanup_batches(&paths);

        assert_eq!(batches.len(), 1);
        assert!(cleanup_command(batches[0].iter().copied()).len() <= MAX_CLEANUP_COMMAND_BYTES);
    }

    #[test]
    fn cleanup_is_bounded_and_repairs_each_directory_before_descending() {
        let path = String::from("/srv/releases/.terax-part-task-0.backup");
        let command = cleanup_command([path.as_str()]);

        let device_check = command.find("path_device=$(stat").unwrap();
        let first_delete = command.find("find -P \"$path\"").unwrap();
        assert!(device_check < first_delete);
        assert!(command.contains("[ \"$path_device\" = \"$parent_device\" ] || return 1"));
        assert!(command.contains("find -P \"$path\" -xdev -depth -delete"));
        assert!(command.contains("find -P \"$path\" -xdev -type d"));
        assert!(command.contains("chmod u+rwx -- \"$directory\""));
        assert!(command.contains("{} \\;"));
        assert!(!command.contains("{} +"));
        assert!(!command.contains("rm -rf"));
        assert!(!command.contains("chmod -R"));
        assert!(command.contains("terax_cleanup_status=0"));
        assert!(command.contains("if ! terax_remove_owned_path \"$path\""));
        assert!(command.contains("set -- '/srv/releases/.terax-part-task-0.backup'"));
    }
}
