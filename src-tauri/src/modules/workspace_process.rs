use crate::modules::storage::{write_atomic, FileLock};
use crate::modules::workspace::{validate_wsl_distro_name, WorkspaceEnv};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const SCHEMA_VERSION: u32 = 1;
const ENV_ARG: &str = "--terax-workspace-env";
const POLICY_ARG: &str = "--terax-workspace-policy";
const ID_ARG: &str = "--terax-workspace-id";
const DIR_ARG: &str = "--terax-launch-dir";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkspacePolicy {
    Fresh,
    Recent,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBootstrap {
    pub schema_version: u32,
    pub id: String,
    pub env: WorkspaceEnv,
    pub launch_dir: Option<String>,
    pub state_filename: String,
    pub window_state_filename: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceMetadata {
    schema_version: u32,
    id: String,
    env: WorkspaceEnv,
    created_at: u64,
    last_opened_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchRequest {
    env: WorkspaceEnv,
    policy: WorkspacePolicy,
    workspace_id: Option<Uuid>,
    launch_dir: Option<PathBuf>,
}

pub struct WorkspaceProcessState {
    bootstrap: WorkspaceBootstrap,
    _lock: FileLock,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
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
    let mut workspace_id = None;
    let mut launch_dir = None;
    let mut positional = None;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let target = match arg.as_str() {
            ENV_ARG | POLICY_ARG | ID_ARG | DIR_ARG => Some(
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
            ID_ARG => {
                if workspace_id.is_some() {
                    return Err(format!("duplicate {ID_ARG}"));
                }
                let raw = target.as_deref().unwrap();
                let id = Uuid::parse_str(raw).map_err(|_| "workspace id must be a UUID")?;
                if id.to_string() != raw {
                    return Err("workspace id must use canonical lowercase format".to_string());
                }
                workspace_id = Some(id);
            }
            DIR_ARG => {
                if launch_dir.is_some() {
                    return Err(format!("duplicate {DIR_ARG}"));
                }
                launch_dir = Some(PathBuf::from(target.unwrap()));
            }
            _ if arg.starts_with('-') => return Err(format!("unknown argument: {arg}")),
            _ => {
                if positional.is_some() {
                    return Err("only one launch directory may be provided".to_string());
                }
                positional = Some(PathBuf::from(arg));
            }
        }
    }

    let has_internal =
        env.is_some() || policy.is_some() || workspace_id.is_some() || launch_dir.is_some();
    if has_internal && positional.is_some() {
        return Err(
            "internal Workspace arguments cannot be combined with a positional directory"
                .to_string(),
        );
    }
    if !has_internal {
        return Ok(LaunchRequest {
            env: WorkspaceEnv::Local,
            policy: if positional.is_some() {
                WorkspacePolicy::Fresh
            } else {
                WorkspacePolicy::Recent
            },
            workspace_id: None,
            launch_dir: positional,
        });
    }

    let env = env.ok_or_else(|| format!("{ENV_ARG} is required"))?;
    let policy = policy.ok_or_else(|| format!("{POLICY_ARG} is required"))?;
    if workspace_id.is_some() && policy != WorkspacePolicy::Recent {
        return Err("explicit workspace id requires recent policy".to_string());
    }
    if launch_dir.is_some() && (env != WorkspaceEnv::Local || policy != WorkspacePolicy::Fresh) {
        return Err("launch directory requires a fresh Local Workspace".to_string());
    }
    Ok(LaunchRequest {
        env,
        policy,
        workspace_id,
        launch_dir,
    })
}

fn state_filename(id: Uuid) -> String {
    format!("terax-workspace.{id}.json")
}

fn lock_filename(id: Uuid) -> String {
    format!("terax-workspace.{id}.lock")
}

fn read_metadata(path: &Path, expected: Uuid) -> Result<WorkspaceMetadata, String> {
    let value: Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let metadata: WorkspaceMetadata = serde_json::from_value(value).map_err(|e| e.to_string())?;
    if metadata.schema_version != SCHEMA_VERSION
        || metadata.id != expected.to_string()
        || metadata.created_at > metadata.last_opened_at
    {
        return Err("Workspace metadata does not match its filename".to_string());
    }
    Ok(metadata)
}

fn scan(root: &Path) -> Result<Vec<(Uuid, WorkspaceMetadata)>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let Some(raw_id) = name
            .strip_prefix("terax-workspace.")
            .and_then(|value| value.strip_suffix(".json"))
        else {
            continue;
        };
        let Ok(id) = Uuid::parse_str(raw_id) else {
            log::warn!("ignoring invalid Workspace filename: {}", path.display());
            continue;
        };
        match read_metadata(&path, id) {
            Ok(metadata) => result.push((id, metadata)),
            Err(error) => log::warn!("ignoring invalid Workspace metadata: {error}"),
        }
    }
    result.sort_by(|(left_id, left), (right_id, right)| {
        right
            .last_opened_at
            .cmp(&left.last_opened_at)
            .then_with(|| right.created_at.cmp(&left.created_at))
            .then_with(|| left_id.cmp(right_id))
    });
    Ok(result)
}

fn write_metadata(root: &Path, metadata: &WorkspaceMetadata) -> Result<(), String> {
    let id = Uuid::parse_str(&metadata.id).map_err(|e| e.to_string())?;
    let path = root.join(state_filename(id));
    let mut map = if path.exists() {
        let value: Value = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        value
            .as_object()
            .cloned()
            .ok_or_else(|| "Workspace state must be a JSON object".to_string())?
    } else {
        Map::new()
    };
    let metadata_value = serde_json::to_value(metadata).map_err(|e| e.to_string())?;
    for (key, value) in metadata_value.as_object().unwrap() {
        map.insert(key.clone(), value.clone());
    }
    write_atomic(&path, &serde_json::to_vec(&map).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

fn migrate_legacy_workspace_state(root: &Path, id: Uuid, env: &WorkspaceEnv) -> Result<(), String> {
    if *env != WorkspaceEnv::Local {
        return Ok(());
    }
    let marker = root.join(".workspace-v1-migration-complete");
    if marker.is_file() {
        return Ok(());
    }
    let _lock = FileLock::acquire(
        &root.join(".workspace-v1-migration.lock"),
        Duration::from_secs(5),
    )
    .map_err(|error| error.to_string())?
    .ok_or_else(|| "legacy Workspace migration is still running".to_string())?;
    if marker.is_file() {
        return Ok(());
    }

    let legacy_current = root.join("terax-spaces.json");
    let backup = root.join("terax-spaces.v0.backup.json");
    let legacy_path = if legacy_current.exists() {
        legacy_current
    } else {
        backup.clone()
    };

    let target_path = root.join(state_filename(id));
    let mut target = serde_json::from_slice::<Value>(
        &fs::read(&target_path).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?
    .as_object()
    .cloned()
    .ok_or_else(|| "Workspace state must be a JSON object".to_string())?;
    let already_initialized = target
        .get("spaces")
        .and_then(Value::as_array)
        .is_some_and(|spaces| !spaces.is_empty());

    if !already_initialized {
        if legacy_path.exists() {
            let legacy_bytes = fs::read(&legacy_path).map_err(|error| error.to_string())?;
            let legacy = serde_json::from_slice::<Value>(&legacy_bytes)
                .map_err(|error| format!("invalid legacy Spaces store: {error}"))?
                .as_object()
                .cloned()
                .ok_or_else(|| "legacy Spaces store must be a JSON object".to_string())?;

            if let Some(Value::Array(spaces)) = legacy.get("spaces") {
                let normalized = spaces
                    .iter()
                    .cloned()
                    .map(|mut space| {
                        if let Some(map) = space.as_object_mut() {
                            map.remove("env");
                        }
                        space
                    })
                    .collect();
                target.insert("spaces".to_string(), Value::Array(normalized));
            }
            if let Some(active) = legacy.get("activeId") {
                target.insert("activeSpaceId".to_string(), active.clone());
            }
            for (key, value) in &legacy {
                if let Some(space_id) = key.strip_prefix("state:") {
                    target.insert(format!("spaceState:{space_id}"), value.clone());
                }
            }
        }
        target.insert("migration:legacySpaces".to_string(), Value::Bool(true));
        write_atomic(
            &target_path,
            &serde_json::to_vec(&target).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
    }

    if backup.exists() && !backup.is_file() {
        return Err(format!(
            "legacy Spaces backup is not a file: {}",
            backup.display()
        ));
    }
    if legacy_path.exists() && legacy_path != backup && !backup.exists() {
        let bytes = fs::read(&legacy_path).map_err(|error| error.to_string())?;
        write_atomic(&backup, &bytes).map_err(|error| error.to_string())?;
    }
    write_atomic(&marker, b"1\n").map_err(|error| error.to_string())
}

fn canonical_launch_dir(path: Option<PathBuf>) -> Result<Option<String>, String> {
    let Some(path) = path else {
        return Ok(None);
    };
    let canonical = fs::canonicalize(&path)
        .map_err(|e| format!("launch directory {} is invalid: {e}", path.display()))?;
    if !canonical.is_dir() {
        return Err(format!(
            "launch path is not a directory: {}",
            canonical.display()
        ));
    }
    Ok(Some(crate::modules::fs::to_canon(&canonical)))
}

fn validate_environment(root: &Path, env: &WorkspaceEnv) -> Result<(), String> {
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
            let path = root.join("terax-ssh-profiles.json");
            let value: Value = serde_json::from_slice(
                &fs::read(&path)
                    .map_err(|e| format!("cannot read SSH profiles {}: {e}", path.display()))?,
            )
            .map_err(|e| format!("invalid SSH profiles store: {e}"))?;
            if value
                .as_object()
                .is_some_and(|map| map.contains_key(&format!("profile:{profile_id}")))
            {
                Ok(())
            } else {
                Err(format!("SSH profile not found: {profile_id}"))
            }
        }
    }
}

pub fn initialize(root: &Path, request: LaunchRequest) -> Result<WorkspaceProcessState, String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    validate_environment(root, &request.env)?;
    let launch_dir = canonical_launch_dir(request.launch_dir)?;
    let selected = if let Some(id) = request.workspace_id {
        let metadata = read_metadata(&root.join(state_filename(id)), id)?;
        if metadata.env != request.env {
            return Err("explicit Workspace environment does not match metadata".to_string());
        }
        Some((id, metadata))
    } else if request.policy == WorkspacePolicy::Recent {
        scan(root)?
            .into_iter()
            .find(|(_, metadata)| metadata.env == request.env)
    } else {
        None
    };

    let timestamp = now_millis();
    let (id, mut metadata, lock) = if let Some((id, mut metadata)) = selected {
        match FileLock::try_acquire(&root.join(lock_filename(id))).map_err(|e| e.to_string())? {
            Some(lock) => {
                metadata.last_opened_at = timestamp;
                (id, metadata, lock)
            }
            None if request.workspace_id.is_some() => {
                return Err("explicit Workspace is already open".to_string())
            }
            None => {
                let id = Uuid::new_v4();
                let lock = FileLock::try_acquire(&root.join(lock_filename(id)))
                    .map_err(|e| e.to_string())?
                    .expect("new UUID lock cannot be occupied");
                (
                    id,
                    WorkspaceMetadata {
                        schema_version: SCHEMA_VERSION,
                        id: id.to_string(),
                        env: request.env.clone(),
                        created_at: timestamp,
                        last_opened_at: timestamp,
                    },
                    lock,
                )
            }
        }
    } else {
        let id = Uuid::new_v4();
        let lock = FileLock::try_acquire(&root.join(lock_filename(id)))
            .map_err(|e| e.to_string())?
            .expect("new UUID lock cannot be occupied");
        (
            id,
            WorkspaceMetadata {
                schema_version: SCHEMA_VERSION,
                id: id.to_string(),
                env: request.env.clone(),
                created_at: timestamp,
                last_opened_at: timestamp,
            },
            lock,
        )
    };
    metadata.last_opened_at = timestamp;
    write_metadata(root, &metadata)?;
    if let Err(error) = migrate_legacy_workspace_state(root, id, &request.env) {
        log::warn!("legacy Workspace state migration deferred: {error}");
    }
    Ok(WorkspaceProcessState {
        bootstrap: WorkspaceBootstrap {
            schema_version: SCHEMA_VERSION,
            id: id.to_string(),
            env: request.env,
            launch_dir,
            state_filename: state_filename(id),
            window_state_filename: format!("terax-window-state.{id}.json"),
        },
        _lock: lock,
    })
}

impl WorkspaceProcessState {
    pub fn bootstrap(&self) -> &WorkspaceBootstrap {
        &self.bootstrap
    }
}

#[tauri::command]
pub fn get_workspace_bootstrap(
    state: tauri::State<'_, WorkspaceProcessState>,
) -> WorkspaceBootstrap {
    state.bootstrap.clone()
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
        let canonical = canonical_launch_dir(Some(PathBuf::from(path)))?
            .expect("launch directory was provided");
        args.push(DIR_ARG.to_string());
        args.push(canonical);
    }
    Ok(args)
}

#[tauri::command]
pub fn spawn_workspace_process(
    env: WorkspaceEnv,
    policy: WorkspacePolicy,
    launch_dir: Option<String>,
) -> Result<u32, String> {
    let args = spawn_args(&env, policy, launch_dir.as_deref())?;
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
    use std::process::Command;

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
        assert_eq!(request.launch_dir, Some(PathBuf::from(".")));
    }

    #[test]
    fn recent_reuses_unlocked_workspace_and_fresh_never_does() {
        let root = tempfile::tempdir().unwrap();
        let recent = parse_args(Vec::<String>::new()).unwrap();
        let first = initialize(root.path(), recent.clone()).unwrap();
        let first_id = first.bootstrap.id.clone();
        drop(first);
        let restored = initialize(root.path(), recent).unwrap();
        assert_eq!(restored.bootstrap.id, first_id);
        drop(restored);
        let fresh = initialize(
            root.path(),
            LaunchRequest {
                env: WorkspaceEnv::Local,
                policy: WorkspacePolicy::Fresh,
                workspace_id: None,
                launch_dir: None,
            },
        )
        .unwrap();
        assert_ne!(fresh.bootstrap.id, first_id);
    }

    #[test]
    fn locked_most_recent_workspace_creates_fresh_without_falling_back() {
        let root = tempfile::tempdir().unwrap();
        let request = parse_args(Vec::<String>::new()).unwrap();
        let first = initialize(root.path(), request.clone()).unwrap();
        let second = initialize(root.path(), request).unwrap();
        assert_ne!(first.bootstrap.id, second.bootstrap.id);
    }

    #[test]
    fn explicit_workspace_cannot_be_opened_twice() {
        let root = tempfile::tempdir().unwrap();
        let first = initialize(root.path(), parse_args(Vec::<String>::new()).unwrap()).unwrap();
        let id = Uuid::parse_str(&first.bootstrap.id).unwrap();
        let request = LaunchRequest {
            env: WorkspaceEnv::Local,
            policy: WorkspacePolicy::Recent,
            workspace_id: Some(id),
            launch_dir: None,
        };
        assert!(initialize(root.path(), request).is_err());
    }

    #[test]
    fn child_arguments_are_strict_and_do_not_include_secrets() {
        let args = spawn_args(
            &WorkspaceEnv::Ssh {
                profile_id: "ssh-profile".to_string(),
            },
            WorkspacePolicy::Recent,
            None,
        )
        .unwrap();
        assert_eq!(args, [ENV_ARG, "ssh:ssh-profile", POLICY_ARG, "recent"]);
        assert!(args.iter().all(|arg| !arg.contains("password")));
    }

    #[test]
    fn first_local_workspace_migrates_legacy_spaces_without_space_env() {
        let root = tempfile::tempdir().unwrap();
        fs::write(
            root.path().join("terax-spaces.json"),
            serde_json::to_vec(&serde_json::json!({
                "spaces": [{
                    "id": "default",
                    "name": "Default",
                    "root": "C:/work",
                    "env": { "kind": "wsl", "distro": "Ubuntu" },
                    "createdAt": 1,
                    "updatedAt": 2
                }],
                "activeId": "default",
                "state:default": { "tabs": [], "activeTabIndex": 0 }
            }))
            .unwrap(),
        )
        .unwrap();

        let state = initialize(root.path(), parse_args(Vec::<String>::new()).unwrap()).unwrap();
        let value: Value = serde_json::from_slice(
            &fs::read(root.path().join(&state.bootstrap.state_filename)).unwrap(),
        )
        .unwrap();

        assert_eq!(value["activeSpaceId"], "default");
        assert!(value["spaceState:default"].is_object());
        assert!(value["spaces"][0].get("env").is_none());
        assert!(root.path().join("terax-spaces.v0.backup.json").exists());
        assert!(root
            .path()
            .join(".workspace-v1-migration-complete")
            .exists());
    }

    #[test]
    fn legacy_spaces_do_not_overwrite_initialized_workspace() {
        let root = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        let metadata = WorkspaceMetadata {
            schema_version: SCHEMA_VERSION,
            id: id.to_string(),
            env: WorkspaceEnv::Local,
            created_at: 1,
            last_opened_at: 1,
        };
        write_metadata(root.path(), &metadata).unwrap();
        let target = root.path().join(state_filename(id));
        let mut value: Value = serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
        value.as_object_mut().unwrap().insert(
            "spaces".to_string(),
            serde_json::json!([{ "id": "current" }]),
        );
        write_atomic(&target, &serde_json::to_vec(&value).unwrap()).unwrap();
        fs::write(
            root.path().join("terax-spaces.json"),
            br#"{"spaces":[{"id":"legacy"}]}"#,
        )
        .unwrap();

        migrate_legacy_workspace_state(root.path(), id, &WorkspaceEnv::Local).unwrap();
        let after: Value = serde_json::from_slice(&fs::read(target).unwrap()).unwrap();
        assert_eq!(after["spaces"][0]["id"], "current");
        assert!(after.get("migration:legacySpaces").is_none());
    }

    #[test]
    fn empty_first_local_workspace_is_selected_for_ui_state_migration() {
        let root = tempfile::tempdir().unwrap();
        let state = initialize(root.path(), parse_args(Vec::<String>::new()).unwrap()).unwrap();
        let value: Value = serde_json::from_slice(
            &fs::read(root.path().join(&state.bootstrap.state_filename)).unwrap(),
        )
        .unwrap();

        assert_eq!(value["migration:legacySpaces"], true);
        assert!(root
            .path()
            .join(".workspace-v1-migration-complete")
            .is_file());
    }

    #[test]
    fn workspace_backup_failure_does_not_create_marker() {
        let root = tempfile::tempdir().unwrap();
        let id = Uuid::new_v4();
        write_metadata(
            root.path(),
            &WorkspaceMetadata {
                schema_version: SCHEMA_VERSION,
                id: id.to_string(),
                env: WorkspaceEnv::Local,
                created_at: 1,
                last_opened_at: 1,
            },
        )
        .unwrap();
        fs::write(root.path().join("terax-spaces.json"), br#"{"spaces":[]}"#).unwrap();
        fs::create_dir(root.path().join("terax-spaces.v0.backup.json")).unwrap();

        assert!(migrate_legacy_workspace_state(root.path(), id, &WorkspaceEnv::Local).is_err());
        assert!(!root
            .path()
            .join(".workspace-v1-migration-complete")
            .is_file());
    }

    #[test]
    fn subprocess_workspace_lock_helper() {
        let Some(root) = std::env::var_os("TERAX_WORKSPACE_TEST_ROOT") else {
            return;
        };
        let id = Uuid::parse_str(&std::env::var("TERAX_WORKSPACE_TEST_ID").unwrap()).unwrap();
        let request = LaunchRequest {
            env: WorkspaceEnv::Local,
            policy: WorkspacePolicy::Recent,
            workspace_id: Some(id),
            launch_dir: None,
        };
        let error = match initialize(Path::new(&root), request) {
            Ok(_) => panic!("subprocess unexpectedly acquired an open Workspace"),
            Err(error) => error,
        };
        assert!(error.contains("already open"));
    }

    #[test]
    fn workspace_lock_is_exclusive_across_processes_and_reusable() {
        let root = tempfile::tempdir().unwrap();
        let held = initialize(root.path(), parse_args(Vec::<String>::new()).unwrap()).unwrap();
        let id = held.bootstrap.id.clone();
        let status = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("modules::workspace_process::tests::subprocess_workspace_lock_helper")
            .arg("--nocapture")
            .env("TERAX_WORKSPACE_TEST_ROOT", root.path())
            .env("TERAX_WORKSPACE_TEST_ID", &id)
            .status()
            .unwrap();
        assert!(status.success());

        drop(held);
        let reopened = initialize(
            root.path(),
            LaunchRequest {
                env: WorkspaceEnv::Local,
                policy: WorkspacePolicy::Recent,
                workspace_id: Some(Uuid::parse_str(&id).unwrap()),
                launch_dir: None,
            },
        )
        .unwrap();
        assert_eq!(reopened.bootstrap.id, id);
    }
}
