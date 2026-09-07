//! 文件树目录读取与排序。
//!
//! 本模块统一处理本地和 SSH 目录的直接子项，并保证两条后端路径使用相同的
//! 类型分组和数字感知排序规则。文件系统访问仍由 Workspace 环境边界决定。

use std::cmp::Ordering;
use std::collections::HashSet;
use std::path::Path;
use std::time::UNIX_EPOCH;

use ignore::WalkBuilder;
use serde::Serialize;

#[cfg(feature = "desktop")]
use crate::modules::remote;
use crate::modules::workspace::{resolve_path, WorkspaceEnv};

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
}

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub kind: EntryKind,
    pub size: u64,
    /// Milliseconds since UNIX epoch; 0 if unavailable.
    pub mtime: u64,
    pub gitignored: bool,
}

// Whether `dir` is inside a git repo. Walks up only; never descends into
// siblings, so it does not touch protected macOS folders (Desktop, ...).
fn in_git_repo(dir: &Path) -> bool {
    let mut cur = dir;
    loop {
        if cur.join(".git").exists() {
            return true;
        }
        match cur.parent() {
            Some(p) => cur = p,
            None => return false,
        }
    }
}

// Immediate children of `dir` that git does not ignore. Outside a repo every
// name is returned, so nothing is dimmed.
fn git_non_ignored_names(dir: &Path, show_hidden: bool) -> HashSet<String> {
    WalkBuilder::new(dir)
        .hidden(!show_hidden)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(false)
        .parents(true)
        .max_depth(Some(1))
        .follow_links(false)
        .build()
        .flatten()
        .filter_map(|d| d.file_name().to_str().map(str::to_string))
        .collect()
}

/// 比较已经完成大小写折叠的名称，并将连续 ASCII 数字按数值排序。
fn natural_cmp_inner(a: &str, b: &str) -> Ordering {
    let a = a.as_bytes();
    let b = b.as_bytes();
    let mut ai = 0;
    let mut bi = 0;

    loop {
        match (a.get(ai).copied(), b.get(bi).copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(ac), Some(bc)) => {
                if ac.is_ascii_digit() && bc.is_ascii_digit() {
                    let a_end = ai
                        + a[ai..]
                            .iter()
                            .take_while(|byte| byte.is_ascii_digit())
                            .count();
                    let b_end = bi
                        + b[bi..]
                            .iter()
                            .take_while(|byte| byte.is_ascii_digit())
                            .count();
                    let a_run = &a[ai..a_end];
                    let b_run = &b[bi..b_end];
                    let a_zeros = a_run.iter().take_while(|byte| **byte == b'0').count();
                    let b_zeros = b_run.iter().take_while(|byte| **byte == b'0').count();
                    let a_number = &a_run[a_zeros..];
                    let b_number = &b_run[b_zeros..];

                    let order = a_number
                        .len()
                        .cmp(&b_number.len())
                        .then_with(|| a_number.cmp(b_number))
                        .then_with(|| a_run.len().cmp(&b_run.len()));
                    if order != Ordering::Equal {
                        return order;
                    }
                    ai = a_end;
                    bi = b_end;
                } else {
                    let order = ac.to_ascii_lowercase().cmp(&bc.to_ascii_lowercase());
                    if order != Ordering::Equal {
                        return order;
                    }
                    ai += 1;
                    bi += 1;
                }
            }
        }
    }
}

/// 对名称执行不分大小写且数字感知的自然排序比较。
fn natural_cmp(a: &str, b: &str) -> Ordering {
    let a_folded = (!a.is_ascii()).then(|| a.to_lowercase());
    let b_folded = (!b.is_ascii()).then(|| b.to_lowercase());
    natural_cmp_inner(
        a_folded.as_deref().unwrap_or(a),
        b_folded.as_deref().unwrap_or(b),
    )
}

/// 按目录、符号链接、文件分组，并在组内自然排序。
fn sort_dir_entries(entries: &mut [DirEntry]) {
    entries.sort_by(|a, b| {
        let rank = |kind: &EntryKind| match kind {
            EntryKind::Dir => 0,
            EntryKind::Symlink => 1,
            EntryKind::File => 2,
        };
        rank(&a.kind)
            .cmp(&rank(&b.kind))
            .then_with(|| natural_cmp(&a.name, &b.name))
    });
}

/// 对仅包含名称的目录结果应用与文件树一致的自然排序。
fn sort_names(names: &mut [String]) {
    names.sort_by(|a, b| natural_cmp(a, b));
}

/// Lists immediate children of `path`. Dirs first, then files, each sorted
/// case-insensitively. Dot-prefixed entries (files and dirs) are hidden unless
/// `show_hidden` is set. `git_decorations` opts into the per-entry `gitignored`
/// flag; off by default so non-explorer callers pay nothing.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn fs_read_dir(
    path: String,
    show_hidden: bool,
    git_decorations: Option<bool>,
    workspace: Option<WorkspaceEnv>,
) -> Result<Vec<DirEntry>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    if let Some(profile_id) = workspace.ssh_profile_id() {
        #[cfg(not(feature = "desktop"))]
        {
            let _ = profile_id;
            return Err("SSH requires a desktop workspace in this build".into());
        }
        #[cfg(feature = "desktop")]
        {
            let manager = remote::manager::global_manager()?;
            let workspace = manager.workspace(profile_id).await?;
            let mut entries = remote::sftp::read_dir(&workspace, &path, show_hidden)
                .await
                .map(|entries| {
                    entries
                        .into_iter()
                        .map(|entry| DirEntry {
                            name: entry.name,
                            kind: match entry.kind {
                                remote::sftp::RemoteEntryKind::File => EntryKind::File,
                                remote::sftp::RemoteEntryKind::Dir => EntryKind::Dir,
                                remote::sftp::RemoteEntryKind::Symlink => EntryKind::Symlink,
                            },
                            size: entry.size,
                            mtime: entry.mtime,
                            gitignored: false,
                        })
                        .collect::<Vec<_>>()
                })?;
            sort_dir_entries(&mut entries);
            return Ok(entries);
        }
    }
    let root = resolve_path(&path, &workspace);
    let read = std::fs::read_dir(&root).map_err(|e| {
        log::debug!("fs_read_dir({}) failed: {e}", root.display());
        e.to_string()
    })?;

    // Gate on a real repo: outside one the walk is pointless and would probe
    // each child for a nested `.git`, which trips macOS folder-access prompts.
    let git_decorations = git_decorations.unwrap_or(false) && in_git_repo(&root);
    let git_visible = if git_decorations {
        git_non_ignored_names(&root, show_hidden)
    } else {
        HashSet::new()
    };

    let mut entries: Vec<DirEntry> = read
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;

            // `metadata()` follows symlinks → it returns the target's stat in
            // one syscall (file_type + size + mtime all derived from it). We
            // fall back to `symlink_metadata` for broken symlinks so we don't
            // silently drop them from the listing.
            let (meta, was_symlink) = match std::fs::metadata(entry.path()) {
                Ok(m) => (Some(m), false),
                Err(_) => (entry.metadata().ok(), true),
            };
            let meta = meta?;

            let kind = if was_symlink {
                EntryKind::Symlink
            } else if meta.is_dir() {
                EntryKind::Dir
            } else {
                EntryKind::File
            };

            if name.starts_with('.') && !show_hidden {
                return None;
            }

            let size = meta.len();
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);

            let gitignored = git_decorations && !git_visible.contains(&name);
            Some(DirEntry {
                name,
                kind,
                size,
                mtime,
                gitignored,
            })
        })
        .collect();

    sort_dir_entries(&mut entries);

    Ok(entries)
}

/// Lists immediate subdirectories of `path`. Kept for the CwdBreadcrumb.
///
/// Symlinks to directories are included (matches shell `cd` semantics).
/// Hidden entries are filtered by dot-prefix only.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn list_subdirs(
    path: String,
    show_hidden: bool,
    workspace: Option<WorkspaceEnv>,
) -> Result<Vec<String>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    if let Some(profile_id) = workspace.ssh_profile_id() {
        #[cfg(not(feature = "desktop"))]
        {
            let _ = profile_id;
            return Err("SSH requires a desktop workspace in this build".into());
        }
        #[cfg(feature = "desktop")]
        {
            let manager = remote::manager::global_manager()?;
            let workspace = manager.workspace(profile_id).await?;
            let mut dirs = remote::sftp::read_dir(&workspace, &path, show_hidden)
                .await
                .map(|entries| {
                    entries
                        .into_iter()
                        .filter(|entry| entry.kind == remote::sftp::RemoteEntryKind::Dir)
                        .map(|entry| entry.name)
                        .collect::<Vec<_>>()
                })?;
            sort_names(&mut dirs);
            return Ok(dirs);
        }
    }
    let root = resolve_path(&path, &workspace);
    let read = std::fs::read_dir(&root).map_err(|e| {
        log::debug!("list_subdirs({}) read_dir failed: {e}", root.display());
        e.to_string()
    })?;

    let mut dirs: Vec<String> = read
        .filter_map(Result::ok)
        .filter(|entry| match entry.file_type() {
            Ok(t) if t.is_dir() => true,
            Ok(t) if t.is_symlink() => std::fs::metadata(entry.path())
                .map(|m| m.is_dir())
                .unwrap_or(false),
            _ => false,
        })
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| show_hidden || !name.starts_with('.'))
        .collect();

    sort_names(&mut dirs);
    Ok(dirs)
}

#[cfg(test)]
mod tests {
    use super::{natural_cmp, sort_dir_entries, DirEntry, EntryKind};
    use std::cmp::Ordering;

    fn sorted(mut names: Vec<&str>) -> Vec<&str> {
        names.sort_by(|a, b| natural_cmp(a, b));
        names
    }

    #[test]
    fn numbers_sort_by_value_without_overflow() {
        assert_eq!(
            sorted(vec!["17", "170", "18", "3", "20", "171", "9"]),
            vec!["3", "9", "17", "18", "20", "170", "171"],
        );
        assert_eq!(
            natural_cmp("file99999999999999999999", "file100000000000000000000"),
            Ordering::Less,
        );
    }

    #[test]
    fn embedded_numbers_case_and_leading_zeros_have_stable_order() {
        assert_eq!(
            sorted(vec!["File10", "file2", "file02", "file1"]),
            vec!["file1", "file2", "file02", "File10"],
        );
        assert_eq!(natural_cmp("École", "école"), Ordering::Equal);
        assert_eq!(sorted(vec!["나", "가", "다"]), vec!["가", "나", "다"]);
    }

    #[test]
    fn entry_sort_keeps_kind_groups_before_natural_names() {
        let mut entries = vec![
            entry("file2", EntryKind::File),
            entry("dir10", EntryKind::Dir),
            entry("link1", EntryKind::Symlink),
            entry("dir2", EntryKind::Dir),
            entry("file1", EntryKind::File),
        ];

        sort_dir_entries(&mut entries);

        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            vec!["dir2", "dir10", "link1", "file1", "file2"],
        );
    }

    fn entry(name: &str, kind: EntryKind) -> DirEntry {
        DirEntry {
            name: name.to_string(),
            kind,
            size: 0,
            mtime: 0,
            gitignored: false,
        }
    }
}
