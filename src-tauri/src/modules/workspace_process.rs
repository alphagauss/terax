use crate::modules::storage::{write_atomic, FileLock};
use crate::modules::workspace::{validate_wsl_distro_name, WorkspaceEnv};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use uuid::Uuid;

const ENV_ARG: &str = "--terax-workspace-env";
const POLICY_ARG: &str = "--terax-workspace-policy";
const DIR_ARG: &str = "--terax-launch-dir";
const GEOMETRY_ARG: &str = "--terax-window-geometry";
const REGISTRY_LOCK: &str = "terax-workspace-registry.lock";
const WINDOW_MODE_KEY: &str = "workspaceWindowMode";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkspacePolicy {
    Fresh,
    Recent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WorkspaceWindowMode {
    Single,
    Multiple,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBootstrap {
    pub schema_version: u32,
    pub id: String,
    pub is_primary: bool,
    pub env: WorkspaceEnv,
    pub environment_key: String,
    pub launch_dir: Option<String>,
    pub launch_files: Vec<String>,
    pub state_path: String,
    pub window_state_filename: String,
    pub window_geometry: Option<WindowGeometry>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowGeometry {
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchRequest {
    env: WorkspaceEnv,
    policy: WorkspacePolicy,
    launch_paths: Vec<PathBuf>,
    window_geometry: Option<WindowGeometry>,
}

struct EnvironmentIdentity {
    key: String,
    filename_key: String,
}

enum StateKind {
    Single,
    Extra(Uuid),
}

pub struct WorkspaceProcessState {
    bootstrap: WorkspaceBootstrap,
    _lock: FileLock,
}

pub enum InitializeOutcome {
    Opened(Box<WorkspaceProcessState>),
    ActivatedExisting,
}

fn parse_env(raw: &str) -> Result<WorkspaceEnv, String> {
    if raw == "local" {
        return Ok(WorkspaceEnv::Local);
    }
    if let Some(distro) = raw.strip_prefix("wsl:") {
        validate_wsl_distro_name(distro)?;
        return Ok(WorkspaceEnv::Wsl {
            distro: distro.to_string(),
        });
    }
    if let Some(profile_id) = raw.strip_prefix("ssh:") {
        if profile_id.is_empty()
            || profile_id.contains(['/', '\\'])
            || profile_id.chars().any(char::is_control)
        {
            return Err("invalid SSH profile id".to_string());
        }
        return Ok(WorkspaceEnv::Ssh {
            profile_id: profile_id.to_string(),
        });
    }
    Err(format!("invalid Workspace environment: {raw}"))
}

pub fn parse_args(args: impl IntoIterator<Item = String>) -> Result<LaunchRequest, String> {
    let mut env = None;
    let mut policy = None;
    let mut launch_dir = None;
    let mut positional = Vec::new();
    let mut window_geometry = None;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let target = match arg.as_str() {
            ENV_ARG | POLICY_ARG | DIR_ARG | GEOMETRY_ARG => Some(
                args.next()
                    .ok_or_else(|| format!("missing value for {arg}"))?,
            ),
            _ => None,
        };
        match arg.as_str() {
            ENV_ARG => {
                if env.is_some() {
                    return Err(format!("duplicate {ENV_ARG}"));
                }
                env = Some(parse_env(target.as_deref().unwrap())?);
            }
            POLICY_ARG => {
                if policy.is_some() {
                    return Err(format!("duplicate {POLICY_ARG}"));
                }
                policy = Some(match target.as_deref().unwrap() {
                    "fresh" => WorkspacePolicy::Fresh,
                    "recent" => WorkspacePolicy::Recent,
                    value => return Err(format!("invalid Workspace policy: {value}")),
                });
            }
            DIR_ARG => {
                if launch_dir.is_some() {
                    return Err(format!("duplicate {DIR_ARG}"));
                }
                launch_dir = Some(PathBuf::from(target.unwrap()));
            }
            GEOMETRY_ARG => {
                if window_geometry.is_some() {
                    return Err(format!("duplicate {GEOMETRY_ARG}"));
                }
                window_geometry = Some(parse_window_geometry(target.as_deref().unwrap())?);
            }
            _ if arg.starts_with('-') => return Err(format!("unknown argument: {arg}")),
            _ => positional.push(PathBuf::from(arg)),
        }
    }

    let has_internal =
        env.is_some() || policy.is_some() || launch_dir.is_some() || window_geometry.is_some();
    if has_internal && !positional.is_empty() {
        return Err(
            "internal Workspace arguments cannot be combined with positional paths".to_string(),
        );
    }
    if !has_internal {
        return Ok(LaunchRequest {
            env: WorkspaceEnv::Local,
            policy: if positional.is_empty() {
                WorkspacePolicy::Recent
            } else {
                WorkspacePolicy::Fresh
            },
            launch_paths: positional,
            window_geometry: None,
        });
    }

    let env = env.ok_or_else(|| format!("{ENV_ARG} is required"))?;
    let policy = policy.ok_or_else(|| format!("{POLICY_ARG} is required"))?;
    if launch_dir.is_some() && (env != WorkspaceEnv::Local || policy != WorkspacePolicy::Fresh) {
        return Err("launch directory requires a fresh Local Workspace".to_string());
    }
    Ok(LaunchRequest {
        env,
        policy,
        launch_paths: launch_dir.into_iter().collect(),
        window_geometry,
    })
}

fn parse_window_geometry(raw: &str) -> Result<WindowGeometry, String> {
    let mut values = raw.split(',');
    let width = values
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value >= 420 && *value <= 10_000)
        .ok_or_else(|| "invalid window width".to_string())?;
    let height = values
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value >= 280 && *value <= 10_000)
        .ok_or_else(|| "invalid window height".to_string())?;
    let x = values
        .next()
        .and_then(|value| value.parse::<i32>().ok())
        .ok_or_else(|| "invalid window x position".to_string())?;
    let y = values
        .next()
        .and_then(|value| value.parse::<i32>().ok())
        .ok_or_else(|| "invalid window y position".to_string())?;
    if values.next().is_some() {
        return Err("invalid window geometry".to_string());
    }
    Ok(WindowGeometry {
        width,
        height,
        x,
        y,
    })
}

fn state_filename(environment: &EnvironmentIdentity, kind: &StateKind) -> String {
    let suffix = match kind {
        StateKind::Single => "single".to_string(),
        StateKind::Extra(id) => id.to_string(),
    };
    format!(
        "terax-workspace.{}.{}.json",
        environment.filename_key, suffix
    )
}

fn lock_filename(environment: &EnvironmentIdentity, kind: &StateKind) -> String {
    state_filename(environment, kind).replace(".json", ".lock")
}

fn window_state_filename(environment: &EnvironmentIdentity, kind: &StateKind) -> String {
    state_filename(environment, kind).replacen("terax-workspace.", "terax-window-state.", 1)
}

fn parse_extra_state_filename(name: &str) -> Option<Uuid> {
    let raw = name
        .strip_prefix("terax-workspace.")?
        .strip_suffix(".json")?;
    let (_, suffix) = raw.rsplit_once('.')?;
    Uuid::parse_str(suffix).ok()
}

fn parse_legacy_state_filename(name: &str) -> Option<Uuid> {
    let raw = name
        .strip_prefix("terax-workspace.")?
        .strip_suffix(".json")?;
    if raw.contains('.') {
        return None;
    }
    Uuid::parse_str(raw).ok()
}

fn canonical_launch_target(paths: Vec<PathBuf>) -> Result<(Option<String>, Vec<String>), String> {
    let mut dir = None;
    let mut files = Vec::new();
    for path in paths {
        let canonical = fs::canonicalize(&path)
            .map_err(|e| format!("launch path {} is invalid: {e}", path.display()))?;
        if canonical.is_dir() {
            if dir.is_none() {
                dir = Some(crate::modules::fs::to_canon(&canonical));
            }
            continue;
        }
        if canonical.is_file() {
            if dir.is_none() {
                dir = canonical.parent().map(crate::modules::fs::to_canon);
            }
            files.push(crate::modules::fs::to_canon(&canonical));
            continue;
        }
        return Err(format!(
            "launch path is not a file or directory: {}",
            canonical.display()
        ));
    }
    Ok((dir, files))
}

fn ssh_profile(profile_id: &str) -> Result<crate::modules::remote::models::SshProfile, String> {
    let path = crate::modules::app_data::directory(crate::modules::app_data::Directory::Shared)?
        .join("terax-ssh-profiles.json");
    let value: Value = serde_json::from_slice(
        &fs::read(&path)
            .map_err(|e| format!("cannot read SSH profiles {}: {e}", path.display()))?,
    )
    .map_err(|e| format!("invalid SSH profiles store: {e}"))?;
    let profile = value
        .as_object()
        .and_then(|map| map.get(&format!("profile:{profile_id}")))
        .ok_or_else(|| format!("SSH profile not found: {profile_id}"))?;
    serde_json::from_value(profile.clone()).map_err(|e| format!("invalid SSH profile: {e}"))
}

fn environment_identity(env: &WorkspaceEnv) -> Result<EnvironmentIdentity, String> {
    let key = match env {
        WorkspaceEnv::Local => "local".to_string(),
        WorkspaceEnv::Wsl { distro } => format!("wsl:{distro}"),
        WorkspaceEnv::Ssh { profile_id } => {
            let profile = ssh_profile(profile_id)?;
            format!(
                "ssh:{}:{}:{}",
                profile.host.to_ascii_lowercase(),
                profile.port,
                profile.username
            )
        }
    };
    let filename_key = match env {
        WorkspaceEnv::Local => "local".to_string(),
        WorkspaceEnv::Wsl { distro } => format!("wsl-{}", filename_component(distro)),
        WorkspaceEnv::Ssh { .. } => format!("ssh-{}", filename_component(&key["ssh:".len()..])),
    };
    Ok(EnvironmentIdentity { key, filename_key })
}

fn filename_component(value: &str) -> String {
    let mut result = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_' {
            result.push(char::from(byte));
        } else {
            result.push('_');
            result.push_str(&format!("{byte:02x}"));
        }
    }
    if result.len() <= 120 {
        result
    } else {
        Uuid::new_v5(&Uuid::NAMESPACE_URL, value.as_bytes()).to_string()
    }
}

fn validate_environment(env: &WorkspaceEnv) -> Result<(), String> {
    match env {
        WorkspaceEnv::Local => Ok(()),
        WorkspaceEnv::Wsl { distro } => {
            #[cfg(windows)]
            {
                let installed = crate::modules::workspace::list_distros_blocking()?;
                if installed.iter().any(|item| item.name == *distro) {
                    Ok(())
                } else {
                    Err(format!("WSL distribution is not installed: {distro}"))
                }
            }
            #[cfg(not(windows))]
            {
                Err(format!(
                    "WSL Workspace is unavailable on this platform: {distro}"
                ))
            }
        }
        WorkspaceEnv::Ssh { profile_id } => {
            ssh_profile(profile_id)?.validate()?;
            Ok(())
        }
    }
}

fn window_mode() -> WorkspaceWindowMode {
    let Ok(path) = crate::modules::app_data::directory(crate::modules::app_data::Directory::Shared)
        .map(|root| root.join("terax-settings.json"))
    else {
        return WorkspaceWindowMode::Single;
    };
    let Ok(value) = fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .ok_or(())
    else {
        return WorkspaceWindowMode::Single;
    };
    if value.get(WINDOW_MODE_KEY).and_then(Value::as_str) == Some("multiple") {
        WorkspaceWindowMode::Multiple
    } else {
        WorkspaceWindowMode::Single
    }
}

fn ensure_state(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    write_atomic(path, b"{}").map_err(|error| error.to_string())
}

fn remove_stale_state(state_path: &Path, lock_path: &Path, window_state_root: &Path, id: Uuid) {
    if let Err(error) = fs::remove_file(state_path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            log::warn!(
                "cannot remove stale Workspace state {}: {error}",
                state_path.display()
            );
            return;
        }
    }
    if let Err(error) = fs::remove_file(lock_path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            log::warn!(
                "cannot remove stale Workspace lock {}: {error}",
                lock_path.display()
            );
        }
    }
    let names = [
        state_path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.replacen("terax-workspace.", "terax-window-state.", 1)),
        Some(format!("terax-window-state.{id}.json")),
    ];
    for name in names.into_iter().flatten() {
        let window_state = window_state_root.join(name);
        if let Err(error) = fs::remove_file(&window_state) {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!(
                    "cannot remove stale window state {}: {error}",
                    window_state.display()
                );
            }
        }
    }
}

fn cleanup_extra_states(root: &Path, window_state_root: &Path) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let Some(id) =
            parse_extra_state_filename(name).or_else(|| parse_legacy_state_filename(name))
        else {
            continue;
        };
        let lock_path = path.with_extension("lock");
        let Some(lock) = FileLock::try_acquire(&lock_path).map_err(|error| error.to_string())?
        else {
            continue;
        };
        drop(lock);
        remove_stale_state(&path, &lock_path, window_state_root, id);
    }
    Ok(())
}

fn single_id(environment: &EnvironmentIdentity) -> Uuid {
    Uuid::new_v5(
        &Uuid::NAMESPACE_URL,
        format!("terax-workspace-single:{}", environment.key).as_bytes(),
    )
}

fn make_state(
    environment: &EnvironmentIdentity,
    kind: StateKind,
    lock: FileLock,
    env: WorkspaceEnv,
    launch_dir: Option<String>,
    launch_files: Vec<String>,
    launch_geometry: Option<WindowGeometry>,
) -> Result<WorkspaceProcessState, String> {
    let is_primary = matches!(&kind, StateKind::Single);
    let id = match kind {
        StateKind::Single => single_id(environment),
        StateKind::Extra(id) => id,
    };
    let root =
        crate::modules::app_data::directory(crate::modules::app_data::Directory::Workspaces)?;
    let state_path = root.join(state_filename(environment, &kind));
    ensure_state(&state_path)?;
    let window_state_filename = window_state_filename(environment, &kind);
    let window_state_path =
        crate::modules::app_data::directory(crate::modules::app_data::Directory::WindowState)?
            .join(&window_state_filename);
    Ok(WorkspaceProcessState {
        bootstrap: WorkspaceBootstrap {
            schema_version: 3,
            id: id.to_string(),
            is_primary,
            env,
            environment_key: environment.key.clone(),
            launch_dir,
            launch_files,
            state_path: state_path.to_string_lossy().into_owned(),
            window_state_filename,
            window_geometry: (!window_state_path.exists())
                .then_some(launch_geometry)
                .flatten(),
        },
        _lock: lock,
    })
}

pub fn initialize(root: &Path, request: LaunchRequest) -> Result<InitializeOutcome, String> {
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    validate_environment(&request.env)?;
    let environment = environment_identity(&request.env)?;
    let (launch_dir, launch_files) = canonical_launch_target(request.launch_paths)?;
    let launch_geometry = request.window_geometry;
    let window_state_root =
        crate::modules::app_data::directory(crate::modules::app_data::Directory::WindowState)?;
    let _registry = FileLock::acquire(&root.join(REGISTRY_LOCK), Duration::from_secs(5))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Workspace registry is busy".to_string())?;
    cleanup_extra_states(root, &window_state_root)?;

    let _policy = request.policy;
    let single_kind = StateKind::Single;
    let single_lock_path = root.join(lock_filename(&environment, &single_kind));
    match FileLock::try_acquire(&single_lock_path).map_err(|error| error.to_string())? {
        Some(lock) => Ok(InitializeOutcome::Opened(Box::new(make_state(
            &environment,
            single_kind,
            lock,
            request.env,
            launch_dir,
            launch_files,
            launch_geometry,
        )?))),
        None if request.env == WorkspaceEnv::Local && !launch_files.is_empty() => {
            crate::modules::shared_store::request_workspace_file_open(
                &environment.key,
                &single_id(&environment).to_string(),
                &launch_files,
            )?;
            Ok(InitializeOutcome::ActivatedExisting)
        }
        None if window_mode() == WorkspaceWindowMode::Single => {
            crate::modules::shared_store::request_workspace_activation(
                &environment.key,
                &single_id(&environment).to_string(),
            )?;
            Ok(InitializeOutcome::ActivatedExisting)
        }
        None => {
            let id = Uuid::new_v4();
            let kind = StateKind::Extra(id);
            let lock = FileLock::try_acquire(&root.join(lock_filename(&environment, &kind)))
                .map_err(|error| error.to_string())?
                .expect("new UUID lock cannot be occupied");
            Ok(InitializeOutcome::Opened(Box::new(make_state(
                &environment,
                kind,
                lock,
                request.env,
                launch_dir,
                launch_files,
                launch_geometry,
            )?)))
        }
    }
}

pub fn route_local_open_files(files: &[String]) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }
    let environment = EnvironmentIdentity {
        key: "local".to_string(),
        filename_key: "local".to_string(),
    };
    crate::modules::shared_store::request_workspace_file_open(
        &environment.key,
        &single_id(&environment).to_string(),
        files,
    )
}

impl WorkspaceProcessState {
    pub fn bootstrap(&self) -> &WorkspaceBootstrap {
        &self.bootstrap
    }

    pub fn assert_ssh_tunnel_owner(&self, profile_id: &str) -> Result<(), String> {
        assert_ssh_tunnel_owner(self.bootstrap.is_primary, &self.bootstrap.env, profile_id)
    }
}

fn assert_ssh_tunnel_owner(
    is_primary: bool,
    environment: &WorkspaceEnv,
    profile_id: &str,
) -> Result<(), String> {
    if !is_primary {
        return Err("SSH tunnels are managed by the primary Workspace window".into());
    }
    match environment {
        WorkspaceEnv::Ssh {
            profile_id: active_profile,
        } if active_profile == profile_id => Ok(()),
        WorkspaceEnv::Ssh { .. } => Err("SSH tunnel profile does not match this Workspace".into()),
        _ => Err("SSH tunnels require an SSH Workspace".into()),
    }
}

#[tauri::command]
pub fn get_workspace_bootstrap(
    state: tauri::State<'_, WorkspaceProcessState>,
) -> WorkspaceBootstrap {
    state.bootstrap.clone()
}

#[tauri::command]
pub fn take_workspace_open_files(
    state: tauri::State<'_, WorkspaceProcessState>,
) -> Result<Vec<String>, String> {
    crate::modules::shared_store::take_workspace_file_open(
        &state.bootstrap.environment_key,
        &state.bootstrap.id,
    )
}

fn env_arg(env: &WorkspaceEnv) -> String {
    match env {
        WorkspaceEnv::Local => "local".to_string(),
        WorkspaceEnv::Wsl { distro } => format!("wsl:{distro}"),
        WorkspaceEnv::Ssh { profile_id } => format!("ssh:{profile_id}"),
    }
}

fn spawn_args(
    env: &WorkspaceEnv,
    policy: WorkspacePolicy,
    launch_dir: Option<&str>,
    window_geometry: Option<WindowGeometry>,
) -> Result<Vec<String>, String> {
    parse_env(&env_arg(env))?;
    if launch_dir.is_some() && (*env != WorkspaceEnv::Local || policy != WorkspacePolicy::Fresh) {
        return Err("launch directory requires a fresh Local Workspace".to_string());
    }
    let mut args = vec![
        ENV_ARG.to_string(),
        env_arg(env),
        POLICY_ARG.to_string(),
        match policy {
            WorkspacePolicy::Fresh => "fresh",
            WorkspacePolicy::Recent => "recent",
        }
        .to_string(),
    ];
    if let Some(path) = launch_dir {
        let (canonical, files) = canonical_launch_target(vec![PathBuf::from(path)])?;
        if !files.is_empty() {
            return Err("launch directory must be a directory".to_string());
        }
        let canonical = canonical.expect("launch directory was provided");
        args.push(DIR_ARG.to_string());
        args.push(canonical);
    }
    if let Some(geometry) = window_geometry {
        args.push(GEOMETRY_ARG.to_string());
        args.push(format!(
            "{},{},{},{}",
            geometry.width, geometry.height, geometry.x, geometry.y
        ));
    }
    Ok(args)
}

#[tauri::command]
pub fn spawn_workspace_process(
    env: WorkspaceEnv,
    policy: WorkspacePolicy,
    launch_dir: Option<String>,
    window_geometry: Option<WindowGeometry>,
) -> Result<u32, String> {
    let args = spawn_args(&env, policy, launch_dir.as_deref(), window_geometry)?;
    #[cfg(target_os = "linux")]
    let executable = std::env::var_os("APPIMAGE")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or(std::env::current_exe().map_err(|e| e.to_string())?);
    #[cfg(not(target_os = "linux"))]
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;

    let child = Command::new(executable)
        .args(args)
        .spawn()
        .map_err(|e| format!("failed to start Workspace process: {e}"))?;
    Ok(child.id())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_rejects_unknown_duplicate_and_conflicting_arguments() {
        assert!(parse_args(["--unknown".to_string()]).is_err());
        assert!(parse_args([
            ENV_ARG.to_string(),
            "local".to_string(),
            ENV_ARG.to_string(),
            "local".to_string(),
            POLICY_ARG.to_string(),
            "fresh".to_string(),
        ])
        .is_err());
        assert!(parse_args([
            ENV_ARG.to_string(),
            "wsl:Ubuntu".to_string(),
            POLICY_ARG.to_string(),
            "fresh".to_string(),
            DIR_ARG.to_string(),
            ".".to_string(),
        ])
        .is_err());
    }

    #[test]
    fn positional_directory_is_fresh_local() {
        let request = parse_args([".".to_string()]).unwrap();
        assert_eq!(request.env, WorkspaceEnv::Local);
        assert_eq!(request.policy, WorkspacePolicy::Fresh);
        assert_eq!(request.launch_paths, vec![PathBuf::from(".")]);
        assert_eq!(request.window_geometry, None);
    }

    #[test]
    fn launch_file_uses_its_parent_and_is_preserved() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("example.rs");
        fs::write(&file, b"fn main() {}").unwrap();

        let (dir, files) = canonical_launch_target(vec![file.clone()]).unwrap();
        assert_eq!(dir, Some(crate::modules::fs::to_canon(root.path())));
        assert_eq!(files, vec![crate::modules::fs::to_canon(&file)]);
    }

    #[test]
    fn multiple_file_arguments_are_fresh_local() {
        let request = parse_args(["one.rs".to_string(), "two.rs".to_string()]).unwrap();
        assert_eq!(request.env, WorkspaceEnv::Local);
        assert_eq!(request.policy, WorkspacePolicy::Fresh);
        assert_eq!(
            request.launch_paths,
            vec![PathBuf::from("one.rs"), PathBuf::from("two.rs")]
        );
    }

    #[test]
    fn multiple_launch_files_all_open() {
        let root = tempfile::tempdir().unwrap();
        let one = root.path().join("one.rs");
        let two = root.path().join("two.rs");
        fs::write(&one, b"one").unwrap();
        fs::write(&two, b"two").unwrap();

        let (dir, files) = canonical_launch_target(vec![one.clone(), two.clone()]).unwrap();
        assert_eq!(dir, Some(crate::modules::fs::to_canon(root.path())));
        assert_eq!(
            files,
            vec![
                crate::modules::fs::to_canon(&one),
                crate::modules::fs::to_canon(&two),
            ]
        );
    }

    #[test]
    fn parser_accepts_valid_window_geometry() {
        let request = parse_args([
            ENV_ARG.to_string(),
            "local".to_string(),
            POLICY_ARG.to_string(),
            "fresh".to_string(),
            GEOMETRY_ARG.to_string(),
            "1200,800,40,72".to_string(),
        ])
        .unwrap();
        assert_eq!(
            request.window_geometry,
            Some(WindowGeometry {
                width: 1200,
                height: 800,
                x: 40,
                y: 72,
            })
        );
    }

    #[test]
    fn extra_state_filename_does_not_match_single_state() {
        let id = Uuid::new_v4();
        assert_eq!(
            parse_extra_state_filename(&format!("terax-workspace.local.{id}.json")),
            Some(id)
        );
        assert_eq!(
            parse_extra_state_filename("terax-workspace.local.single.json"),
            None
        );
    }

    #[test]
    fn single_state_has_a_stable_id() {
        let environment = EnvironmentIdentity {
            key: "local".to_string(),
            filename_key: "local".to_string(),
        };
        assert_eq!(single_id(&environment), single_id(&environment));
    }

    #[test]
    fn only_the_primary_matching_ssh_workspace_owns_tunnels() {
        let ssh = WorkspaceEnv::Ssh {
            profile_id: "prod".to_string(),
        };
        assert!(assert_ssh_tunnel_owner(true, &ssh, "prod").is_ok());
        assert!(assert_ssh_tunnel_owner(false, &ssh, "prod").is_err());
        assert!(assert_ssh_tunnel_owner(true, &ssh, "staging").is_err());
        assert!(assert_ssh_tunnel_owner(true, &WorkspaceEnv::Local, "prod").is_err());
    }

    #[test]
    fn filename_component_is_windows_safe_and_keeps_short_names_readable() {
        assert_eq!(filename_component("Ubuntu"), "Ubuntu");
        assert_eq!(filename_component("dev@example:22"), "dev_40example_3a22");
    }

    #[test]
    fn window_state_uses_the_matching_workspace_name() {
        let environment = EnvironmentIdentity {
            key: "local".to_string(),
            filename_key: "local".to_string(),
        };
        assert_eq!(
            window_state_filename(&environment, &StateKind::Single),
            "terax-window-state.local.single.json"
        );
    }

    #[test]
    fn cleanup_removes_unlocked_extra_state_and_keeps_locked_state() {
        let root = tempfile::tempdir().unwrap();
        let windows = tempfile::tempdir().unwrap();
        let environment = EnvironmentIdentity {
            key: "local".to_string(),
            filename_key: "local".to_string(),
        };
        let stale = Uuid::new_v4();
        let live = Uuid::new_v4();
        let stale_kind = StateKind::Extra(stale);
        let live_kind = StateKind::Extra(live);
        let stale_path = root.path().join(state_filename(&environment, &stale_kind));
        let live_path = root.path().join(state_filename(&environment, &live_kind));
        fs::write(&stale_path, b"{}").unwrap();
        fs::write(&live_path, b"{}").unwrap();
        let live_lock =
            FileLock::try_acquire(&root.path().join(lock_filename(&environment, &live_kind)))
                .unwrap()
                .unwrap();
        cleanup_extra_states(root.path(), windows.path()).unwrap();
        assert!(!stale_path.exists());
        assert!(live_path.exists());
        drop(live_lock);
    }
}
