//! 目录内容同步的只读比较与差异清单。
//!
//! 远端一次脚本返回目录元数据，差异归档复用现有后台任务与事务提交。
//! 不跟踪删除或重命名，不把预览结果作为后续覆盖授权。

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use super::commit::RootCommitMode;
use super::errors::{io_failure, TransferErrorCode, TransferFailure};
use super::manager::{TaskControl, TransferRunError};
use super::models::{
    EnqueueTransferRequest, FolderSyncOptions, TransferDirection, TransferEntryKind,
};
use super::planner::{PreparedTransfer, TransferManifest};
use super::progress::ExecutionContext;
use serde::Serialize;
use terax_core::modules::remote::session::shell_quote;
use terax_core::modules::workspace::WorkspaceEnv;

const MAX_ENTRIES: usize = 200_000;
const MAX_OUTPUT: usize = 32 * 1024 * 1024;
const MAX_IGNORE_BYTES: usize = 1024 * 1024;

/// 规则仅来自所选源目录及子目录，不读取机器级 Git 配置或目标端规则。
#[derive(Default)]
struct SyncScan {
    entries: BTreeMap<String, SyncEntry>,
    ignore_files: BTreeMap<String, String>,
}

fn filter_source(
    mut scan: SyncScan,
    options: &FolderSyncOptions,
) -> Result<BTreeMap<String, SyncEntry>, TransferFailure> {
    scan.entries.retain(|path, entry| {
        if path.is_empty() {
            return true;
        }
        let name = path.rsplit('/').next().unwrap_or(path);
        let excluded_name = path.split('/').any(|part| options.excludes_name(part));
        let excluded_directory = entry.kind == 'd'
            && options
                .exclude_directories
                .iter()
                .any(|excluded| name == excluded);
        !(excluded_name || excluded_directory)
    });
    if options.respect_gitignore {
        filter_gitignore(scan)
    } else {
        Ok(scan.entries)
    }
}

fn filter_gitignore(scan: SyncScan) -> Result<BTreeMap<String, SyncEntry>, TransferFailure> {
    use ignore::gitignore::{Gitignore, GitignoreBuilder};
    let root = Path::new("terax-sync-root");
    let mut matchers = BTreeMap::<String, Gitignore>::new();
    let mut excluded = BTreeSet::new();
    let mut result = BTreeMap::new();
    for (path, entry) in scan.entries {
        if !path.is_empty() {
            let mut parents: Vec<_> =
                std::iter::successors(path.rsplit_once('/').map(|(parent, _)| parent), |parent| {
                    parent.rsplit_once('/').map(|(parent, _)| parent)
                })
                .collect();
            if parents.iter().any(|parent| excluded.contains(*parent)) {
                continue;
            }
            parents.push("");
            let mut ignored = false;
            for parent in parents.into_iter().rev() {
                if let Some(matcher) = matchers.get(parent) {
                    let matched = matcher.matched(root.join(&path), entry.kind == 'd');
                    if !matched.is_none() {
                        ignored = matched.is_ignore();
                    }
                }
            }
            if ignored {
                if entry.kind == 'd' {
                    excluded.insert(path);
                }
                continue;
            }
        }
        if entry.kind == 'd' {
            let rule_path = if path.is_empty() {
                ".gitignore".to_string()
            } else {
                format!("{path}/.gitignore")
            };
            if let Some(contents) = scan.ignore_files.get(&rule_path) {
                let mut builder = GitignoreBuilder::new(root.join(&path));
                for line in contents.trim_start_matches('\u{feff}').lines() {
                    builder
                        .add_line(Some(root.join(&rule_path)), line)
                        .map_err(|error| {
                            failure(format!("invalid .gitignore {rule_path}: {error}"))
                        })?;
                }
                matchers.insert(
                    path.clone(),
                    builder
                        .build()
                        .map_err(|error| failure(error.to_string()))?,
                );
            }
        }
        result.insert(path, entry);
    }
    Ok(result)
}

#[derive(Clone, Debug)]
pub(crate) struct SyncEntry {
    pub(crate) kind: char,
    pub(crate) size: u64,
    pub(crate) modified: i64,
}

/// 路径均相对单个来源根，包含所需祖先目录，不允许归档递归引入额外文件。
#[derive(Clone, Debug)]
pub(crate) struct SyncSelection {
    pub(crate) entries: BTreeMap<String, SyncEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPreview {
    added: u64,
    updated: u64,
    skipped: u64,
    conflicts: u64,
    bytes: u64,
    items: Vec<SyncPreviewItem>,
    truncated: bool,
}

#[derive(Serialize)]
struct SyncPreviewItem {
    path: String,
    action: &'static str,
}

fn failure(detail: impl Into<String>) -> TransferFailure {
    TransferFailure::new(TransferErrorCode::InvalidRequest, detail)
}

/// 校验相对路径，下载时拒绝无法原样映射到 Windows 的名称，避免别名覆盖。
fn validate_relative(path: &str, windows: bool) -> Result<(), TransferFailure> {
    if path.is_empty() {
        return Ok(());
    }
    if path.len() > 32 * 1024
        || path.chars().any(char::is_control)
        || path.split('/').any(|part| {
            part.is_empty()
                || part == "."
                || part == ".."
                || (windows
                    && (part.contains(['\\', ':', '*', '?', '"', '<', '>', '|'])
                        || part.ends_with(['.', ' '])
                        || terax_core::modules::remote::sftp::sanitize_local_name(part) != part))
        })
    {
        return Err(failure(format!("unsupported sync path: {path}")));
    }
    Ok(())
}

fn seconds(time: std::time::SystemTime) -> Result<i64, TransferFailure> {
    time.duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .map_err(|_| failure("sync modification time precedes Unix epoch"))
}

fn local_scan(
    root: &Path,
    options: &FolderSyncOptions,
    control: &TaskControl,
) -> Result<SyncScan, TransferFailure> {
    use std::io::Read;
    let mut scan = SyncScan::default();
    let result = &mut scan.entries;
    let mut ignore_bytes = 0usize;
    let mut pending = vec![(root.to_path_buf(), String::new())];
    while let Some((path, relative)) = pending.pop() {
        control
            .checkpoint_blocking()
            .map_err(|_| failure("sync scan canceled"))?;
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|e| io_failure(format!("scan {}", path.display()), &e))?;
        let kind = if metadata.file_type().is_symlink() {
            'l'
        } else if metadata.is_dir() {
            'd'
        } else if metadata.is_file() {
            'f'
        } else {
            'o'
        };
        if relative.is_empty() && kind != 'd' {
            return Err(failure("sync root must be a regular directory"));
        }
        validate_relative(&relative, cfg!(windows))?;
        if options.respect_gitignore
            && kind == 'f'
            && path.file_name().is_some_and(|name| name == ".gitignore")
        {
            if metadata.len() > MAX_IGNORE_BYTES as u64 {
                return Err(failure(".gitignore size limit exceeded"));
            }
            let file = super::source::open_verified_file_blocking(
                &path,
                super::source::LocalSourceIdentity::from_metadata(&metadata),
                metadata.len(),
                metadata.modified().ok(),
            )
            .map_err(|error| io_failure("read .gitignore", &error))?;
            let mut contents = String::new();
            file.take((MAX_IGNORE_BYTES + 1) as u64)
                .read_to_string(&mut contents)
                .map_err(|error| io_failure("read .gitignore", &error))?;
            if contents.len() > MAX_IGNORE_BYTES || contents.contains('\0') {
                return Err(failure("invalid .gitignore contents"));
            }
            ignore_bytes += contents.len();
            if ignore_bytes > MAX_OUTPUT {
                return Err(failure(".gitignore total size limit exceeded"));
            }
            scan.ignore_files.insert(relative.clone(), contents);
        }
        result.insert(
            relative.clone(),
            SyncEntry {
                kind,
                size: metadata.len(),
                modified: seconds(
                    metadata
                        .modified()
                        .map_err(|e| io_failure("read sync modification time", &e))?,
                )?,
            },
        );
        if result.len() > MAX_ENTRIES {
            return Err(failure("sync entry limit exceeded"));
        }
        if kind == 'd'
            && (relative.is_empty()
                || !options.exclude_directories.iter().any(|name| {
                    path.file_name()
                        .is_some_and(|file_name| file_name == name.as_str())
                }))
        {
            for entry in super::source::read_verified_directory_blocking(
                &path,
                super::source::LocalSourceIdentity::from_metadata(&metadata),
            )
            .map_err(|e| io_failure("scan sync directory", &e))?
            {
                control
                    .checkpoint_blocking()
                    .map_err(|_| failure("sync scan canceled"))?;
                let entry = entry.map_err(|e| io_failure("read sync directory", &e))?;
                let name = entry
                    .file_name()
                    .into_string()
                    .map_err(|_| failure("sync requires UTF-8 filenames"))?;
                if options.excludes_name(&name)
                    && !(options.respect_gitignore && name == ".gitignore")
                {
                    continue;
                }
                let relative = if relative.is_empty() {
                    name
                } else {
                    format!("{relative}/{name}")
                };
                pending.push((entry.path(), relative));
                if pending.len() + result.len() > MAX_ENTRIES {
                    return Err(TransferFailure::new(
                        TransferErrorCode::ResourceLimit,
                        "sync entry limit exceeded",
                    ));
                }
            }
        }
    }
    Ok(scan)
}

/// 通过标准输入发送脚本，避免目录清单受命令行长度限制；输出、耗时和取消均有界。
pub(crate) async fn run_script(
    env: &WorkspaceEnv,
    script: String,
    control: Arc<TaskControl>,
) -> Result<Vec<u8>, TransferRunError> {
    control.checkpoint().await?;
    match env {
        WorkspaceEnv::Ssh { profile_id } => {
            let workspace = terax_core::modules::remote::manager::global_manager()?
                .workspace(profile_id)
                .await?;
            super::ssh::archive::run_sync_script(&workspace, script, control, MAX_OUTPUT).await
        }
        #[cfg(windows)]
        WorkspaceEnv::Wsl { distro } => {
            super::wsl::archive::run_sync_script(distro, script, control, MAX_OUTPUT).await
        }
        _ => Err(failure("folder sync requires SSH or WSL").into()),
    }
}

fn scan_script(root: &str, options: &FolderSyncOptions) -> String {
    let mut script = format!(
        "set -e\nexport LC_ALL=C\n[ ! -L {root} ] && [ -d {root} ]\ncd -- {root}\nfind .",
        root = shell_quote(root)
    );
    let pattern = |name: &str| {
        let literal: String = name
            .chars()
            .flat_map(|c| {
                if "\\*?[]".contains(c) {
                    vec!['\\', c]
                } else {
                    vec![c]
                }
            })
            .collect();
        shell_quote(&literal)
    };
    for name in options
        .excludes
        .iter()
        .map(String::as_str)
        .chain(options.exclude_git.then_some(".git"))
    {
        if options.respect_gitignore && name == ".gitignore" {
            continue;
        }
        script.push_str(&format!(" -name {} -prune -o", pattern(name)));
    }
    // 目标端仍需保留同名目录自身的类型，以识别来源同名文件的冲突。
    for name in &options.exclude_directories {
        script.push_str(&format!(
            " \\( -type d -name {} -printf '%P\\0%y\\0%s\\0%T@\\0' -prune \\) -o",
            pattern(name)
        ));
    }
    script.push_str(" \\( -printf '%P\\0%y\\0%s\\0%T@\\0'");
    if options.respect_gitignore {
        let reader = r#"set -e
for path do
  [ ! -L "$path" ] && [ -f "$path" ] || exit 73
  exec {input}< "$path"
  if IFS= read -r -d '' -n 1048577 contents <&"$input"; then exit 73; fi
  exec {input}<&-
  printf '%s\0g\0%s\0%s\0' "${path#./}" 0 "$contents"
done"#;
        script.push_str(&format!(
            " -type f -name .gitignore -exec bash -c {} terax-sync-ignore {{}} +",
            shell_quote(reader)
        ));
    }
    script.push_str(" \\)\n");
    script
}

fn parse_scan(bytes: &[u8]) -> Result<SyncScan, TransferFailure> {
    let text = std::str::from_utf8(bytes).map_err(|_| failure("sync requires UTF-8 filenames"))?;
    let fields: Vec<_> = text
        .strip_suffix('\0')
        .ok_or_else(|| failure("incomplete sync scan"))?
        .split('\0')
        .collect();
    if fields.len() % 4 != 0 || fields.len() / 4 > MAX_ENTRIES * 2 {
        return Err(failure("invalid sync scan size"));
    }
    let mut scan = SyncScan::default();
    let result = &mut scan.entries;
    for fields in fields.chunks_exact(4) {
        validate_relative(fields[0], false)?;
        if fields[1] == "g" {
            if fields[0].rsplit('/').next() != Some(".gitignore")
                || fields[2] != "0"
                || fields[3].len() > MAX_IGNORE_BYTES
                || scan
                    .ignore_files
                    .insert(fields[0].to_string(), fields[3].to_string())
                    .is_some()
            {
                return Err(failure("invalid .gitignore scan record"));
            }
            continue;
        }
        let modified = fields[3]
            .split('.')
            .next()
            .unwrap_or("")
            .parse()
            .map_err(|_| failure("invalid sync modification time"))?;
        let entry = SyncEntry {
            kind: fields[1]
                .chars()
                .next()
                .ok_or_else(|| failure("invalid sync type"))?,
            size: fields[2]
                .parse()
                .map_err(|_| failure("invalid sync size"))?,
            modified,
        };
        if result.insert(fields[0].to_owned(), entry).is_some() {
            return Err(failure("duplicate sync path"));
        }
    }
    if result.get("").is_none_or(|entry| entry.kind != 'd') {
        return Err(failure("sync root must be a directory"));
    }
    if result.len() > MAX_ENTRIES {
        return Err(failure("sync entry limit exceeded"));
    }
    Ok(scan)
}

fn compare(
    source: BTreeMap<String, SyncEntry>,
    destination: BTreeMap<String, SyncEntry>,
    windows: bool,
) -> Result<(SyncSelection, SyncPreview), TransferFailure> {
    let mut preview = SyncPreview {
        added: 0,
        updated: 0,
        skipped: 0,
        conflicts: 0,
        bytes: 0,
        items: Vec::new(),
        truncated: false,
    };
    let mut selected = BTreeSet::from([String::new()]);
    let mut details = BTreeMap::new();
    let mut blocked = BTreeSet::<String>::new();
    let destination: BTreeMap<_, _> = destination
        .into_iter()
        .map(|(path, entry)| (if windows { path.to_lowercase() } else { path }, entry))
        .collect();
    let mut names = BTreeSet::new();
    for (path, entry) in &source {
        if path.is_empty() {
            continue;
        }
        validate_relative(path, windows)?;
        if windows && !names.insert(path.to_lowercase()) {
            return Err(failure("sync paths collide on Windows"));
        }
        let target = destination.get(&if windows {
            path.to_lowercase()
        } else {
            path.clone()
        });
        let conflict = std::iter::successors(Some(path.as_str()), |path| {
            path.rsplit_once('/').map(|(parent, _)| parent)
        })
        .any(|ancestor| blocked.contains(ancestor))
            || !matches!(entry.kind, 'f' | 'd')
            || target.is_some_and(|target| target.kind != entry.kind);
        let action = if conflict {
            blocked.insert(path.clone());
            preview.conflicts += 1;
            "conflict"
        } else if target.is_none() {
            preview.added += 1;
            "add"
        } else if entry.kind == 'f' && entry.modified > target.unwrap().modified {
            preview.updated += 1;
            "update"
        } else {
            preview.skipped += 1;
            "skip"
        };
        if matches!(action, "add" | "update") {
            if entry.kind == 'f' {
                preview.bytes += entry.size;
            }
            let mut current = path.as_str();
            selected.insert(current.to_string());
            while let Some((parent, _)) = current.rsplit_once('/') {
                selected.insert(parent.to_string());
                current = parent;
            }
        }
        let priority = match action {
            "conflict" => 0,
            "update" => 1,
            "add" => 2,
            _ => 3,
        };
        details.insert((priority, path.clone()), action);
        if details.len() > 1000 {
            details.pop_last();
            preview.truncated = true;
        }
    }
    preview.items = details
        .into_iter()
        .map(|((_, path), action)| SyncPreviewItem { path, action })
        .collect();
    Ok((
        SyncSelection {
            entries: source
                .into_iter()
                .filter(|(path, _)| selected.contains(path))
                .collect(),
        },
        preview,
    ))
}

async fn inspect(
    env: &WorkspaceEnv,
    request: &EnqueueTransferRequest,
    control: Arc<TaskControl>,
) -> Result<(SyncSelection, SyncPreview), TransferRunError> {
    let options = request
        .sync
        .as_ref()
        .ok_or_else(|| failure("missing sync options"))?;
    let (local, remote) = match request.direction {
        TransferDirection::Upload => (&request.sources[0], &request.destination),
        TransferDirection::Download => (&request.destination, &request.sources[0]),
    };
    let local = PathBuf::from(local);
    if !local.is_absolute() || local.parent().is_none() {
        return Err(failure("invalid local sync root").into());
    }
    let mut options_owned = options.clone();
    options_owned.respect_gitignore &= request.direction == TransferDirection::Upload;
    let mut remote_options = options.clone();
    remote_options.respect_gitignore &= request.direction == TransferDirection::Download;
    let scan_control = control.clone();
    let local_scan =
        tokio::task::spawn_blocking(move || local_scan(&local, &options_owned, &scan_control));
    let remote_scan = run_script(env, scan_script(remote, &remote_options), control.clone());
    let (local, remote) = tokio::join!(local_scan, remote_scan);
    control.checkpoint().await?;
    let local = local.map_err(|e| failure(e.to_string()))??;
    let remote = parse_scan(&remote?)?;
    let (source, destination) = match request.direction {
        TransferDirection::Upload => (local, remote.entries),
        TransferDirection::Download => (remote, local.entries),
    };
    Ok(compare(
        filter_source(source, options)?,
        destination,
        cfg!(windows) && request.direction == TransferDirection::Download,
    )?)
}

pub async fn preview(
    env: &WorkspaceEnv,
    request: EnqueueTransferRequest,
) -> Result<SyncPreview, TransferFailure> {
    let request = request.normalize()?;
    inspect(env, &request, Arc::new(TaskControl::new()))
        .await
        .map(|(_, preview)| preview)
        .map_err(|error| match error {
            TransferRunError::Failed(error) => error,
            TransferRunError::Canceled => failure("sync canceled"),
        })
}

/// 任务执行时重新比较两端，保持预览与真正执行之间的修改可见。
pub(crate) async fn prepare(
    prepared: &mut PreparedTransfer,
    env: &WorkspaceEnv,
    request: &EnqueueTransferRequest,
    context: &ExecutionContext,
) -> Result<(), TransferRunError> {
    let (selection, preview) = inspect(env, request, context.control()).await?;
    if preview.conflicts > 0 {
        return Err(TransferRunError::failed(
            TransferErrorCode::DestinationExists,
            "sync contains type conflicts or unsupported entries",
        ));
    }
    match &mut prepared.manifest {
        TransferManifest::Local(plan) => {
            let source = &plan.directories[0].source;
            let target = &plan.roots[0].final_path;
            if source.starts_with(target) || target.starts_with(source) {
                return Err(failure("sync source and destination overlap").into());
            }
            for root in &mut plan.roots {
                root.mode = RootCommitMode::MergeNewer;
                root.destination_kind = Some(TransferEntryKind::Directory);
            }
            if request.direction == TransferDirection::Upload {
                plan.destination_parent = plan.roots[0]
                    .stage
                    .parent()
                    .ok_or_else(|| failure("sync target has no parent"))?
                    .to_path_buf();
                if let super::planner::WslArchiveContext::Upload {
                    destination_parent, ..
                } = &mut plan.wsl
                {
                    *destination_parent = request
                        .destination
                        .trim_end_matches('/')
                        .rsplit_once('/')
                        .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
                        .ok_or_else(|| failure("invalid sync target"))?
                        .to_string();
                }
            }
            plan.sync = Some(selection);
        }
        TransferManifest::RemoteUpload(plan) => {
            for root in &mut plan.roots {
                root.mode = RootCommitMode::MergeNewer;
                root.destination_kind = Some(TransferEntryKind::Directory);
            }
            plan.sync = Some(selection);
        }
        TransferManifest::RemoteDownload(plan) => {
            for root in &mut plan.roots {
                root.mode = RootCommitMode::MergeNewer;
                root.destination_kind = Some(TransferEntryKind::Directory);
            }
            plan.sync = Some(selection);
        }
    }
    Ok(())
}

impl SyncSelection {
    /// tar 使用 NUL 清单和非递归模式，只允许比较阶段选中的路径进入归档。
    pub(crate) fn pack_script(&self, root: &str, archive: &str) -> String {
        let paths: Vec<_> = self
            .entries
            .keys()
            .map(|relative| {
                if relative.is_empty() {
                    root.to_string()
                } else {
                    format!("{}/{relative}", root.trim_end_matches('/'))
                }
            })
            .collect();
        let mut script = String::from("set -e\nset -o pipefail\nexport LC_ALL=C\npaths=(");
        for path in &paths {
            script.push_str(&format!(" {}", shell_quote(path)));
        }
        script.push_str(" )\nkinds=(");
        for entry in self.entries.values() {
            script.push_str(if entry.kind == 'd' { " d" } else { " f" });
        }
        script.push_str(" )\nsizes=(");
        for entry in self.entries.values() {
            script.push_str(&format!(" {}", entry.size));
        }
        script.push_str(" )\ntimes=(");
        for entry in self.entries.values() {
            script.push_str(&format!(" {}", entry.modified));
        }
        script.push_str(
            r#" )
verify_sources() {
  local offset=0 index position mode count bytes length
  local metadata=()
  while ((offset < ${#paths[@]})); do
    count=0
    bytes=0
    while ((offset + count < ${#paths[@]} && count < 128)); do
      length=${#paths[offset+count]}
      if ((count > 0 && bytes + length + 1 > 32768)); then break; fi
      bytes=$((bytes + length + 1))
      count=$((count + 1))
    done
    mapfile -d '' -t metadata < <(stat --printf '%f\0%s\0%Y\0' -- "${paths[@]:offset:count}")
    [ "${#metadata[@]}" -eq "$((count * 3))" ] || return 73
    for ((index=0; index<count; index++)); do
      position=$((offset + index))
      mode=$((16#${metadata[index*3]} & 0170000))
      if [ "${kinds[position]}" = d ]; then
        [ "$mode" -eq "$((0040000))" ] || return 73
      else
        [ "$mode" -eq "$((0100000))" ] || return 73
        [ "${metadata[index*3+1]}" = "${sizes[position]}" ] || return 73
        [ "${metadata[index*3+2]}" = "${times[position]}" ] || return 73
      fi
    done
    offset=$((offset + count))
  done
}
verify_sources
"#,
        );
        script.push_str(&format!(
            "for path in \"${{paths[@]}}\"; do printf './%s\\0' \"${{path#/}}\"; done | tar -czf {} -C / --hard-dereference --no-recursion --null -T -\nverify_sources\n",
            shell_quote(archive)
        ));
        script
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_preset_prunes_files_and_directories_at_every_depth() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join(".git")).unwrap();
        std::fs::create_dir_all(root.path().join("sub")).unwrap();
        std::fs::write(root.path().join(".git/config"), b"git").unwrap();
        std::fs::write(root.path().join("sub/.git"), b"git file").unwrap();
        std::fs::write(root.path().join("sub/code.rs"), b"code").unwrap();
        let mut options = FolderSyncOptions {
            exclude_git: true,
            ..Default::default()
        };
        let entries = filter_source(
            local_scan(root.path(), &options, &TaskControl::new()).unwrap(),
            &options,
        )
        .unwrap();
        assert!(!entries.contains_key(".git"));
        assert!(!entries.contains_key(".git/config"));
        assert!(!entries.contains_key("sub/.git"));
        assert!(entries.contains_key("sub/code.rs"));
        assert!(scan_script("/srv/project", &options).contains("-name '.git' -prune -o"));
        options.exclude_git = false;
        let entries = filter_source(
            local_scan(root.path(), &options, &TaskControl::new()).unwrap(),
            &options,
        )
        .unwrap();
        assert!(entries.contains_key(".git/config"));
        assert!(entries.contains_key("sub/.git"));
    }

    #[test]
    fn source_gitignore_honors_nested_rules_exceptions_and_root_anchors_without_git() {
        let root = tempfile::tempdir().unwrap();
        for path in ["target", "sub/target", "ignored", "explicit", "sub/nested"] {
            std::fs::create_dir_all(root.path().join(path)).unwrap();
        }
        std::fs::write(
            root.path().join(".gitignore"),
            "\u{feff}/target/\r\n*.log\r\n!keep.log\r\nignored/\r\n!ignored/file\r\n!explicit/\r\n",
        )
        .unwrap();
        std::fs::write(root.path().join("sub/.gitignore"), "!debug.log\n/nested/\n").unwrap();
        for path in [
            "target/file",
            "sub/target/file",
            "ignored/file",
            "explicit/file",
            "debug.log",
            "keep.log",
            "sub/debug.log",
            "sub/nested/file",
            "code.rs",
        ] {
            std::fs::write(root.path().join(path), b"data").unwrap();
        }
        let options = FolderSyncOptions {
            respect_gitignore: true,
            exclude_directories: vec!["explicit".into()],
            ..Default::default()
        };
        let scan = local_scan(root.path(), &options, &TaskControl::new()).unwrap();
        let entries = filter_source(scan, &options).unwrap();
        for path in [
            "target",
            "target/file",
            "ignored",
            "ignored/file",
            "explicit",
            "explicit/file",
            "debug.log",
            "sub/nested",
        ] {
            assert!(!entries.contains_key(path), "{path}");
        }
        for path in [
            ".gitignore",
            "sub/.gitignore",
            "sub/target/file",
            "keep.log",
            "sub/debug.log",
            "code.rs",
        ] {
            assert!(entries.contains_key(path), "{path}");
        }
        assert!(!root.path().join(".git").exists());
    }

    #[test]
    fn directory_presets_prune_every_depth_but_preserve_same_named_files_and_target_conflicts() {
        let root = tempfile::tempdir().unwrap();
        for path in ["target", "nested/target", "files"] {
            std::fs::create_dir_all(root.path().join(path)).unwrap();
        }
        for path in ["target/file", "nested/target/file", "files/target"] {
            std::fs::write(root.path().join(path), b"data").unwrap();
        }
        let options = FolderSyncOptions {
            exclude_directories: vec!["target".into()],
            ..Default::default()
        };
        let scan = local_scan(root.path(), &options, &TaskControl::new()).unwrap();
        assert!(scan.entries.contains_key("target"));
        assert!(!scan.entries.contains_key("target/file"));
        let (_, preview) = compare(
            BTreeMap::from([("".into(), entry('d', 1)), ("target".into(), entry('f', 1))]),
            scan.entries.clone(),
            false,
        )
        .unwrap();
        assert_eq!(preview.conflicts, 1);
        let entries = filter_source(scan, &options).unwrap();
        assert!(!entries.contains_key("target"));
        assert!(!entries.contains_key("nested/target"));
        assert!(entries.contains_key("files/target"));
    }

    #[test]
    fn custom_gitignore_exclusion_still_applies_its_rules_and_disabled_mode_includes_files() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join(".gitignore"), "secret\n").unwrap();
        std::fs::write(root.path().join("secret"), b"data").unwrap();
        let mut options = FolderSyncOptions {
            excludes: vec![".gitignore".into()],
            respect_gitignore: true,
            ..Default::default()
        };
        let entries = filter_source(
            local_scan(root.path(), &options, &TaskControl::new()).unwrap(),
            &options,
        )
        .unwrap();
        assert!(!entries.contains_key(".gitignore"));
        assert!(!entries.contains_key("secret"));
        options.respect_gitignore = false;
        let entries = filter_source(
            local_scan(root.path(), &options, &TaskControl::new()).unwrap(),
            &options,
        )
        .unwrap();
        assert!(entries.contains_key("secret"));
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "需要 TERAX_TEST_WSL_DISTRO 指定测试发行版"]
    async fn wsl_sync_scripts_scan_pack_and_commit_without_per_file_roundtrips() {
        let env = WorkspaceEnv::Wsl {
            distro: std::env::var("TERAX_TEST_WSL_DISTRO").unwrap(),
        };
        let control = Arc::new(TaskControl::new());
        let root = format!("/tmp/terax-sync-test-{}", uuid::Uuid::new_v4());
        let source = format!("{root}/source");
        let target = format!("{root}/target");
        let setup = format!("set -e\nmkdir -p {source}/nested {source}/excluded {target}/nested\nprintf new > {source}/nested/file\nprintf old > {target}/nested/file\nprintf keep > {target}/old-name\nprintf skip > {source}/excluded/file\nprintf equal > {source}/equal\nprintf target > {target}/equal\ntouch -d @20 {source}/nested/file {source}/equal {target}/equal\ntouch -d @10 {target}/nested/file\nfor index in {{1..260}}; do printf new > {source}/nested/file-$index; done\n");
        run_script(&env, setup, control.clone()).await.unwrap();
        let result = async {
            run_script(
                &env,
                format!("ln -- {source}/nested/file {source}/hardlink\n"),
                control.clone(),
            )
            .await
            .unwrap();
            run_script(&env, format!("set -e\nmkdir -p {source}/target {source}/deep/target\nprintf data > {source}/target/file\nprintf data > {source}/deep/target/file\nprintf data > {source}/nested/target\nprintf data > {source}/drop.skip\nprintf data > {source}/keep.skip\nprintf data > {source}/nested/child.skip\nprintf data > {source}/code.rs\nprintf '*.skip\\n!keep.skip\\n!target/\\n' > {source}/.gitignore\nprintf '!child.skip\\n' > {source}/nested/.gitignore\n"), control.clone()).await.unwrap();
            let options = FolderSyncOptions {
                exclude_git: false,
                excludes: vec!["excluded".into()],
                exclude_directories: vec!["target".into()],
                respect_gitignore: true,
            };
            let source_entries = parse_scan(
                &run_script(&env, scan_script(&source, &options), control.clone())
                    .await
                    .unwrap(),
            )
            .unwrap();
            assert!(!source_entries.entries.contains_key("excluded"));
            assert!(!source_entries.entries.contains_key("target/file"));
            assert!(!source_entries.entries.contains_key("deep/target/file"));
            let source_entries = filter_source(source_entries, &options).unwrap();
            assert!(!source_entries.contains_key("target"));
            assert!(!source_entries.contains_key("drop.skip"));
            assert!(source_entries.contains_key("nested/target"));
            assert!(source_entries.contains_key("keep.skip"));
            assert!(source_entries.contains_key("nested/child.skip"));
            let destination = parse_scan(
                &run_script(&env, scan_script(&target, &options), control.clone())
                    .await
                    .unwrap(),
            )
            .unwrap();
            let (selection, report) = compare(source_entries, destination.entries, false).unwrap();
            assert_eq!(report.updated, 1);
            let archive = format!("{root}/delta.tar.gz");
            let mut pack = format!(
                "stat() {{ printf 'call\\n' >> {root}/stat-calls; command stat \"$@\"; }}\n"
            );
            pack.push_str(&selection.pack_script(&source, &archive));
            pack.push_str(&format!("[ \"$(wc -l < {root}/stat-calls)\" -le 6 ]\n"));
            run_script(&env, pack, control.clone()).await.unwrap();
            let listing = run_script(&env, format!("tar -tvzf {archive}\n"), control.clone())
                .await
                .unwrap();
            let listing = String::from_utf8(listing).unwrap();
            assert!(listing.contains("nested/file"));
            assert!(listing.contains("hardlink"));
            assert!(!listing.lines().any(|line| line.starts_with('h')));
            assert!(!listing.contains("excluded") && !listing.contains("equal"));
            assert!(!listing.contains("drop.skip") && !listing.contains("target/file"));
            let local = tempfile::tempdir().unwrap();
            std::fs::write(local.path().join(".gitignore"), "*.rs\n").unwrap();
            let preview = preview(
                &env,
                EnqueueTransferRequest {
                    sync: Some(options.clone()),
                    sources: vec![source.clone()],
                    destination: local.path().to_string_lossy().into_owned(),
                    direction: TransferDirection::Download,
                    strategy: super::super::models::TransferStrategy::Archive,
                    destination_name: None,
                },
            )
            .await
            .unwrap();
            assert!(preview.items.iter().any(|item| item.path == "code.rs"));
            assert!(!preview.items.iter().any(|item| item.path == "drop.skip"));
            let (transaction, _) =
                super::super::commit::remote_commit_command(&[super::super::commit::RemoteRoot {
                    source_path: source.clone(),
                    stage: format!("{root}/stage"),
                    final_path: target.clone(),
                    kind: super::super::models::TransferEntryKind::Directory,
                    destination_kind: Some(super::super::models::TransferEntryKind::Directory),
                    mode: super::super::commit::RootCommitMode::MergeNewer,
                    merge_preconditions: Vec::new(),
                }]);
            let commit = format!("set -e\ncd {root}\nmkdir -p stage/nested\nprintf source > stage/nested/file\nprintf source > stage/equal\nprintf source > stage/new\ntouch -d @20 stage/nested/file stage/equal\ntouch -d @30 target/nested/file\nidentity=$(stat -c %i target)\n{transaction}\n[ \"$(stat -c %i target)\" = \"$identity\" ]\n[ \"$(cat target/nested/file)\" = old ]\n[ \"$(cat target/equal)\" = target ]\n[ \"$(cat target/new)\" = source ]\n[ \"$(cat target/old-name)\" = keep ]\n");
            run_script(&env, commit, control.clone()).await.unwrap();
            let reconciliation = super::super::commit::remote_commit_command(&[]).0;
            let regression = include_str!("ssh/reconcile.test.sh");
            let script = format!("set -e\nprintf '%s' {} > {root}/reconcile.sh\nmkdir {root}/regression\nbash -c {} terax-reconcile-test {root}/reconcile.sh {root}/regression\n", shell_quote(&reconciliation), shell_quote(regression));
            run_script(&env, script, control.clone()).await.unwrap();

            run_script(
                &env,
                format!("printf changed > {source}/nested/file\n"),
                control.clone(),
            )
            .await
            .unwrap();
            assert!(run_script(
                &env,
                selection.pack_script(&source, &archive),
                control.clone()
            )
            .await
            .is_err());
        };
        // 测试清理只指向本测试生成的 UUID 路径。
        use futures_util::FutureExt;
        let result = std::panic::AssertUnwindSafe(result).catch_unwind().await;
        run_script(
            &env,
            format!(
                "find {} -type d -exec chmod u+rwx {{}} \\; && rm -rf -- {}\n",
                shell_quote(&root),
                shell_quote(&root)
            ),
            control,
        )
        .await
        .unwrap();
        if let Err(error) = result {
            std::panic::resume_unwind(error);
        }
    }

    fn entry(kind: char, modified: i64) -> SyncEntry {
        SyncEntry {
            kind,
            size: 3,
            modified,
        }
    }

    #[test]
    fn sync_selects_missing_and_strictly_newer_without_deletions() {
        let source = BTreeMap::from([
            ("".into(), entry('d', 10)),
            ("new".into(), entry('f', 1)),
            ("newer".into(), entry('f', 11)),
            ("equal".into(), entry('f', 10)),
            ("older".into(), entry('f', 9)),
            ("empty".into(), entry('d', 1)),
        ]);
        let target = BTreeMap::from([
            ("".into(), entry('d', 20)),
            ("newer".into(), entry('f', 10)),
            ("equal".into(), entry('f', 10)),
            ("older".into(), entry('f', 10)),
            ("target-only".into(), entry('f', 1)),
        ]);
        let (selection, report) = compare(source, target, false).unwrap();
        assert_eq!(
            selection
                .entries
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["", "empty", "new", "newer"]
        );
        assert_eq!(
            (report.added, report.updated, report.skipped, report.bytes),
            (2, 1, 2, 6)
        );
        assert!(!report.items.iter().any(|item| item.path == "target-only"));
    }

    #[test]
    fn sync_blocks_type_conflicts_and_keeps_required_ancestors() {
        let source = BTreeMap::from([
            ("".into(), entry('d', 10)),
            ("dir".into(), entry('d', 1)),
            ("dir/new".into(), entry('f', 1)),
            ("blocked".into(), entry('d', 1)),
            ("blocked/file".into(), entry('f', 20)),
            ("link".into(), entry('l', 1)),
        ]);
        let target = BTreeMap::from([
            ("".into(), entry('d', 10)),
            ("dir".into(), entry('d', 10)),
            ("blocked".into(), entry('f', 1)),
        ]);
        let (selection, report) = compare(source, target, false).unwrap();
        assert_eq!(
            selection
                .entries
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["", "dir", "dir/new"]
        );
        assert_eq!(report.conflicts, 3);
    }

    #[test]
    fn bounded_preview_keeps_changes_visible_among_many_unchanged_files() {
        let mut source = BTreeMap::from([("".into(), entry('d', 1))]);
        for index in 0..1100 {
            source.insert(format!("a-{index}"), entry('f', 1));
        }
        let mut target = source.clone();
        source.insert("z-updated".into(), entry('f', 2));
        target.insert("z-updated".into(), entry('f', 1));
        source.insert("z-conflict".into(), entry('d', 1));
        target.insert("z-conflict".into(), entry('f', 1));
        let (_, report) = compare(source, target, false).unwrap();
        assert!(report.truncated);
        assert_eq!(report.items.len(), 1000);
        assert_eq!(report.items[0].path, "z-conflict");
        assert_eq!(report.items[1].path, "z-updated");
        assert_eq!(
            (report.conflicts, report.updated, report.skipped),
            (1, 1, 1100)
        );
    }

    #[test]
    fn sync_scan_rejects_traversal_truncation_and_windows_aliases() {
        assert!(parse_scan(b"\x00d\x000\x001.000\x00file\x00f\x003\x002.999\x00").is_ok());
        assert!(parse_scan(b"../escape\x00f\x003\x002\x00").is_err());
        assert!(parse_scan(b"\x00d\x000\x001").is_err());
        for name in [
            "a/../b",
            "/absolute",
            "a\\b",
            "file:stream",
            "file.",
            "file ",
        ] {
            assert!(validate_relative(name, true).is_err(), "{name}");
        }
        let source = BTreeMap::from([
            ("".into(), entry('d', 1)),
            ("A".into(), entry('f', 1)),
            ("a".into(), entry('f', 1)),
        ]);
        assert!(compare(source, BTreeMap::new(), true).is_err());
    }

    #[test]
    fn local_sync_scan_prunes_excluded_directories() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("node_modules")).unwrap();
        std::fs::write(root.path().join("node_modules/file"), b"excluded").unwrap();
        std::fs::write(root.path().join(".hidden"), b"included").unwrap();
        let result = local_scan(
            root.path(),
            &FolderSyncOptions {
                excludes: vec!["node_modules".into()],
                ..Default::default()
            },
            &TaskControl::new(),
        )
        .unwrap();
        assert_eq!(
            result
                .entries
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["", ".hidden"]
        );
    }
}
