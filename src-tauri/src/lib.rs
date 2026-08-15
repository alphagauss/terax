//! Terax Tauri 后端入口。
//!
//! 本模块注册原生命令、共享状态和插件，并建立 WebView 与系统能力之间的边界。

pub mod menu;
pub mod modules;

use modules::{
    agent, ai_sessions, alpha, app_data, auxiliary_window, fs, git, history, lsp, markdown_images,
    net, open_with, pty, python, remote, secrets, shared_store, shell, transfers, workspace,
    workspace_process,
};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, PhysicalPosition, PhysicalSize, State};
use tauri_plugin_window_state::StateFlags;

/// Drained on first read so HMR / re-mounts can't replay the launch dir.
#[derive(Default)]
struct LaunchDir(Mutex<Option<String>>);

/// Drained on first read so HMR / re-mounts cannot replay launch files.
#[derive(Default)]
struct LaunchFiles(Mutex<Vec<String>>);

#[tauri::command]
fn get_launch_dir(state: State<'_, LaunchDir>) -> Option<String> {
    state.0.lock().expect("LaunchDir mutex poisoned").take()
}

#[tauri::command]
fn get_launch_files(state: State<'_, LaunchFiles>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().expect("LaunchFiles mutex poisoned"))
}

/// 切换触发命令的当前窗口全屏状态。
///
/// 直接在原生端完成读取和写入，避免前端两次 IPC 之间的窗口状态发生变化。
#[tauri::command]
fn toggle_fullscreen(window: tauri::Window) -> Result<(), String> {
    let fullscreen = window.is_fullscreen().map_err(|error| error.to_string())?;
    window
        .set_fullscreen(!fullscreen)
        .map_err(|error| error.to_string())
}

/// 将触发命令的当前窗口设置为指定的全屏状态。
///
/// 禅模式使用显式目标值恢复进入前状态，不能使用可能受并发调用影响的反转语义。
#[tauri::command]
fn set_fullscreen(window: tauri::Window, fullscreen: bool) -> Result<(), String> {
    window
        .set_fullscreen(fullscreen)
        .map_err(|error| error.to_string())
}

/// 启动 Terax 原生进程并注册共享状态、插件和全部 IPC 命令。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    {
        let args: Vec<String> = std::env::args().collect();
        if args.get(1).map(String::as_str) == Some("__terax_notify") {
            if let (Some(agent), Some(event)) = (args.get(2), args.get(3)) {
                agent::emit_conout_marker(agent, event);
            }
            use std::io::Write;
            let mut out = std::io::stdout();
            let _ = out.write_all(b"{}");
            let _ = out.flush();
            std::process::exit(0);
        }
    }

    let request = workspace_process::parse_args(std::env::args().skip(1)).unwrap_or_else(|error| {
        eprintln!("Terax startup error: {error}");
        std::process::exit(2);
    });
    let workspace_dir =
        app_data::directory(app_data::Directory::Workspaces).unwrap_or_else(|error| {
            eprintln!("Terax startup error: {error}");
            std::process::exit(2);
        });
    let workspace_process = match workspace_process::initialize(&workspace_dir, request) {
        Ok(workspace_process::InitializeOutcome::Opened(state)) => *state,
        Ok(workspace_process::InitializeOutcome::ActivatedExisting) => std::process::exit(0),
        Err(error) => {
            eprintln!("Terax startup error: {error}");
            std::process::exit(2);
        }
    };
    let cli_dir = workspace_process.bootstrap().launch_dir.clone();
    let launch_files = workspace_process.bootstrap().launch_files.clone();
    let window_geometry = workspace_process.bootstrap().window_geometry;
    let show_loading_window =
        workspace_process::should_show_loading_window(&workspace_process.bootstrap().env);
    let window_state_path = app_data::directory(app_data::Directory::WindowState)
        .map(|directory| directory.join(&workspace_process.bootstrap().window_state_filename))
        .unwrap_or_else(|error| {
            eprintln!("Terax startup error: {error}");
            std::process::exit(2);
        });
    if let Some(parent) = window_state_path.parent() {
        std::fs::create_dir_all(parent).unwrap_or_else(|error| {
            eprintln!("Terax startup error: create {}: {error}", parent.display());
            std::process::exit(2);
        });
    }
    workspace::init_launch_cwd(cli_dir.as_deref());

    let builder = tauri::Builder::default();
    #[cfg(target_os = "linux")]
    let builder = builder.plugin(tauri_plugin_clipboard_manager::init());
    builder
        .plugin(tauri_plugin_process::init())
        // 不恢复 VISIBLE。本地窗口等待前端首屏挂载，远端窗口在 Ready 阶段显示加载反馈。
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_filename(window_state_path.to_string_lossy().into_owned())
                // 每个进程只恢复完整 Workspace 窗口，辅助窗口始终按业务定义定位。
                .with_filter(|label| label == "main")
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
                .clear_targets()
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Folder {
                        path: app_data::directory(app_data::Directory::Logs).unwrap_or_else(
                            |error| {
                                eprintln!("Terax startup error: {error}");
                                std::process::exit(2);
                            },
                        ),
                        file_name: None,
                    },
                ))
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|_app| {
            // Localized native menu bar, built from the persisted `language`
            // preference. No-op off macOS.
            #[cfg(target_os = "macos")]
            {
                let _ = menu::build_menu(_app.handle());
            }
            _app.manage(shared_store::SharedStoreState::new(_app.handle())?);
            Ok(())
        })
        .manage(pty::PtyState::default())
        .manage(workspace_process)
        .manage(ai_sessions::AiSessionsState::default())
        .manage(remote::RemoteState::default())
        .manage(shell::ShellState::default())
        .manage(transfers::TransferState::default())
        .manage(secrets::SecretsState::default())
        .manage(fs::watch::FsWatchState::default())
        .manage(history::HistoryState::default())
        .manage(alpha::AlphaProxyState::default())
        .manage(lsp::LspState::default())
        .manage(markdown_images::MarkdownImageState::default())
        .manage(fs::grep::ContentSearchState::default())
        .manage({
            let registry = workspace::WorkspaceRegistry::default();
            workspace::bootstrap_registry(&registry);
            if let Some(ref launch_dir) = cli_dir {
                let _ = registry.authorize(launch_dir);
            }
            for file in &launch_files {
                if let Some(parent) = PathBuf::from(file).parent() {
                    let _ = registry.authorize(parent);
                }
            }
            registry
        })
        .manage(LaunchDir(Mutex::new(cli_dir)))
        .manage(LaunchFiles(Mutex::new(launch_files)))
        .invoke_handler(tauri::generate_handler![
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            pty::pty_close_all,
            pty::pty_has_foreground_process,
            pty::pty_has_foreground_job,
            pty::pty_shell_name,
            pty::pty_list_shells,
            remote::commands::ssh_runtime_connect,
            remote::commands::ssh_runtime_disconnect,
            remote::commands::ssh_runtime_snapshot,
            remote::commands::ssh_confirm_host_key,
            remote::commands::ssh_import_config,
            remote::commands::ssh_tunnel_start,
            remote::commands::ssh_tunnel_stop,
            remote::commands::ssh_tunnel_update,
            remote::commands::ssh_tunnel_list,
            transfers::commands::transfer_enqueue,
            transfers::commands::transfer_resolve_conflict,
            transfers::commands::transfer_ignore_failure,
            transfers::commands::transfer_retry_failure,
            transfers::commands::transfer_list,
            transfers::commands::transfer_pause,
            transfers::commands::transfer_resume,
            transfers::commands::transfer_cancel,
            transfers::commands::transfer_retry,
            transfers::commands::transfer_remove,
            transfers::commands::transfer_clear_completed,
            transfers::commands::transfer_clear_all,
            fs::tree::list_subdirs,
            fs::tree::fs_read_dir,
            fs::file::fs_read_file,
            fs::file::fs_read_binary,
            fs::file::fs_file_version,
            fs::file::fs_write_file,
            fs::file::fs_write_file_checked,
            fs::file::fs_stat,
            fs::file::fs_canonicalize,
            markdown_images::markdown_image_prepare,
            markdown_images::markdown_image_release,
            markdown_images::markdown_image_save_as,
            fs::mutate::fs_create_file,
            fs::mutate::fs_create_dir,
            fs::mutate::fs_rename,
            fs::mutate::fs_delete,
            fs::mutate::fs_trash,
            fs::mutate::fs_copy,
            fs::watch::fs_watch_add,
            fs::watch::fs_watch_remove,
            lsp::lsp_detect,
            lsp::lsp_host_pid,
            lsp::lsp_resolve_root,
            lsp::lsp_spawn,
            lsp::lsp_send,
            lsp::lsp_kill,
            fs::search::fs_search,
            fs::search::fs_list_files,
            fs::grep::fs_grep,
            fs::grep::fs_grep_interactive,
            fs::grep::fs_glob,
            git::commands::git_resolve_repo,
            git::commands::git_panel_snapshot,
            git::commands::git_status,
            git::commands::git_diff,
            git::commands::git_quick_diff_baseline,
            git::commands::git_diff_content,
            git::commands::git_stage,
            git::commands::git_unstage,
            git::commands::git_discard,
            git::commands::git_commit,
            git::commands::git_undo_commit,
            git::commands::git_fetch,
            git::commands::git_pull_ff_only,
            git::commands::git_push,
            git::commands::git_log,
            git::commands::git_show_commit,
            git::commands::git_commit_message,
            git::commands::git_commit_files,
            git::commands::git_commit_file_diff,
            git::commands::git_remote_url,
            git::commands::git_list_branches,
            git::commands::git_checkout_branch,
            shell::shell_run_command,
            shell::shell_session_open,
            shell::shell_session_run,
            shell::shell_session_close,
            shell::shell_bg_spawn,
            shell::shell_bg_logs,
            shell::shell_bg_kill,
            shell::shell_bg_list,
            workspace::wsl_list_distros,
            workspace::wsl_default_distro,
            workspace::wsl_home,
            workspace::workspace_authorize,
            workspace::workspace_current_dir,
            workspace_process::get_workspace_bootstrap,
            workspace_process::take_workspace_open_files,
            workspace_process::spawn_workspace_process,
            ai_sessions::ai_sessions_list,
            ai_sessions::ai_session_read,
            ai_sessions::ai_session_commit,
            ai_sessions::ai_session_delete,
            ai_sessions::ai_session_run_acquire,
            ai_sessions::ai_session_run_release,
            shared_store::shared_store_read,
            shared_store::shared_store_set,
            shared_store::shared_store_delete,
            shared_store::shared_store_mutate,
            shared_store::shared_store_revision,
            open_with::open_with_register,
            open_with::open_with_unregister,
            get_launch_dir,
            get_launch_files,
            toggle_fullscreen,
            set_fullscreen,
            auxiliary_window::open_auxiliary_window,
            agent::agent_enable_hooks,
            agent::agent_hooks_status,
            secrets::secrets_get,
            secrets::secrets_set,
            secrets::secrets_delete,
            secrets::secrets_get_all,
            net::lm_ping,
            net::ai_http_request,
            net::ai_http_stream,
            history::history_suggest,
            history::history_commands,
            history::history_record,
            history::history_list,
            python::python_list_interpreters,
            python::python_probe_interpreter,
            menu::apply_menu_language,
            alpha::commands::alpha_status,
            alpha::commands::alpha_set_python_path,
            alpha::commands::alpha_check_python,
            alpha::commands::alpha_set_auto_start,
            alpha::commands::alpha_start,
            alpha::commands::alpha_stop,
            alpha::commands::alpha_restart,
            alpha::commands::alpha_http_request,
            alpha::commands::alpha_ws_open,
            alpha::commands::alpha_ws_send,
            alpha::commands::alpha_ws_close,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |app, event| {
            if let tauri::RunEvent::Ready = event {
                alpha::schedule_runtime_coordination();
                if let Some(main) = app.get_webview_window("main") {
                    if let Some(geometry) = window_geometry {
                        let _ = main.set_size(PhysicalSize::new(geometry.width, geometry.height));
                        let _ = main.set_position(PhysicalPosition::new(geometry.x, geometry.y));
                    }
                    if show_loading_window {
                        let _ = main.show();
                    }
                }
            }
            // Servers exit on stdin EOF, but destructors are not guaranteed
            // on process exit; kill explicitly.
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<alpha::AlphaProxyState>() {
                    state.close_all();
                }
                if let Some(state) = app.try_state::<lsp::LspState>() {
                    state.kill_all();
                }
            }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                let files = urls
                    .iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .filter_map(|path| std::fs::canonicalize(path).ok())
                    .filter(|path| path.is_file())
                    .map(|path| fs::to_canon(&path))
                    .collect::<Vec<_>>();
                let _ = workspace_process::route_local_open_files(&files);
            }
        });
}
