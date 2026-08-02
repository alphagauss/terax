//! Python 解释器的轻量发现与探测。
//!
//! 本模块只枚举项目直属虚拟环境、已激活环境、PATH、Conda 和系统注册入口，
//! 不递归扫描磁盘，也不创建、修改或激活 Python 环境。所有外部进程都有时间和输出上限。

use crate::modules::proc;
use crate::modules::remote;
use crate::modules::shell;
use crate::modules::workspace::{authorize_spawn_cwd, WorkspaceEnv, WorkspaceRegistry};
use serde::{Deserialize, Serialize};
use shared_child::SharedChild;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(3);
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_OUTPUT_BYTES: u64 = 1024 * 1024;
const MAX_CANDIDATES: usize = 64;
const MAX_KNOWN_VIRTUAL_ENVS: usize = 24;
const MAX_KNOWN_INSTALLS: usize = 24;

const PROBE_CODE: &str = "import json,os,sys; print(json.dumps({'path':sys.executable,'prefix':sys.prefix,'basePrefix':getattr(sys,'base_prefix',sys.prefix),'version':'.'.join(map(str,sys.version_info[:3])),'source':sys.argv[1],'isConda':os.path.isdir(os.path.join(sys.prefix,'conda-meta'))}, ensure_ascii=False))";

const REMOTE_DISCOVERY_SCRIPT: &str = r#"
candidate_count=0
probe() {
  candidate=$1
  source=$2
  [ "$candidate_count" -ge 64 ] && return 0
  [ -x "$candidate" ] || return 0
  candidate_count=$((candidate_count + 1))
  "$candidate" -I -c "$TERAX_PYTHON_PROBE" "$source" 2>/dev/null || true
}

virtual_count=0
probe_virtual() {
  [ "$virtual_count" -ge 24 ] && return 0
  [ -x "$1" ] || return 0
  virtual_count=$((virtual_count + 1))
  probe "$1" virtualEnv
}

probe "$PWD/.venv/bin/python" workspace
probe "$PWD/venv/bin/python" workspace
probe "$PWD/env/bin/python" workspace
[ -n "${VIRTUAL_ENV:-}" ] && probe "$VIRTUAL_ENV/bin/python" activated
[ -n "${CONDA_PREFIX:-}" ] && probe "$CONDA_PREFIX/bin/python" conda

if [ -n "${WORKON_HOME:-}" ]; then
  for candidate in "$WORKON_HOME"/*/bin/python; do probe_virtual "$candidate"; done
fi
for candidate in \
  "$HOME"/.virtualenvs/*/bin/python \
  "$HOME"/.local/share/virtualenvs/*/bin/python \
  "$HOME"/.cache/pypoetry/virtualenvs/*/bin/python \
  "$HOME"/Library/Caches/pypoetry/virtualenvs/*/bin/python
do
  probe_virtual "$candidate"
done

path_python=
for command_name in python3 python; do
  candidate=$(command -v "$command_name" 2>/dev/null || true)
  [ -n "$candidate" ] || continue
  [ -n "$path_python" ] || path_python=$candidate
  probe "$candidate" path
done

for candidate in \
  "$HOME/miniconda3/bin/python" \
  "$HOME/anaconda3/bin/python" \
  "$HOME/miniforge3/bin/python" \
  "$HOME/mambaforge/bin/python" \
  "$HOME"/miniconda3/envs/*/bin/python \
  "$HOME"/anaconda3/envs/*/bin/python \
  "$HOME"/miniforge3/envs/*/bin/python \
  "$HOME"/mambaforge/envs/*/bin/python \
  "$HOME"/.conda/envs/*/bin/python
do
  if [ -z "$path_python" ] && [ -x "$candidate" ]; then path_python=$candidate; fi
  probe "$candidate" conda
done

for candidate in \
  "$HOME"/.local/share/uv/python/*/bin/python \
  "$HOME"/.pyenv/versions/*/bin/python \
  "$HOME"/.rye/py/*/bin/python
do
  probe "$candidate" path
done

conda_cmd=$(command -v conda 2>/dev/null || true)
if [ -n "$conda_cmd" ] && [ -n "$path_python" ]; then
  conda env list --json 2>/dev/null |
    "$path_python" -I -c "import json,sys; [print(x) for x in json.load(sys.stdin).get('envs', [])]" 2>/dev/null |
    while IFS= read -r prefix; do probe "$prefix/bin/python" conda; done
fi
"#;

/// 解释器所代表的环境类型。
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PythonEnvironmentKind {
    WorkspaceVirtualEnv,
    VirtualEnv,
    Conda,
    System,
}

/// 解释器被发现的来源，用于稳定排序和前端分组。
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PythonInterpreterSource {
    Workspace,
    Activated,
    VirtualEnv,
    Conda,
    Launcher,
    Registry,
    Path,
    Manual,
}

/// 已通过真实进程探测的 Python 解释器。
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonInterpreter {
    pub path: String,
    pub environment_root: String,
    pub version: String,
    pub name: String,
    pub kind: PythonEnvironmentKind,
    pub source: PythonInterpreterSource,
}

#[derive(Clone, Debug)]
struct Candidate {
    path: PathBuf,
    source: PythonInterpreterSource,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeRecord {
    path: String,
    prefix: String,
    base_prefix: String,
    version: String,
    source: PythonInterpreterSource,
    is_conda: bool,
}

struct CappedOutput {
    success: bool,
    stdout: Vec<u8>,
}

/// 按当前 Workspace 环境和可选项目根目录发现可用解释器。
///
/// 项目根目录必须已经获得 Workspace 授权。Local 直接访问宿主机，WSL 与 SSH
/// 通过各自现有的一次性 Shell 边界执行固定只读脚本。
#[tauri::command]
pub async fn python_list_interpreters(
    root: Option<String>,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<Vec<PythonInterpreter>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    authorize_spawn_cwd(&registry, root.as_deref(), &workspace)?;
    tauri::async_runtime::spawn_blocking(move || discover(root.as_deref(), workspace))
        .await
        .map_err(|error| error.to_string())?
}

/// 探测一个用户明确选择的解释器路径。
///
/// 该命令不保存路径，也不导入第三方包，仅返回解释器自身的稳定元数据。
#[tauri::command]
pub async fn python_probe_interpreter(
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<PythonInterpreter, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    tauri::async_runtime::spawn_blocking(move || probe_explicit(&path, workspace))
        .await
        .map_err(|error| error.to_string())?
}

/// 将发现任务路由到宿主机或远端 POSIX Workspace 实现。
fn discover(root: Option<&str>, workspace: WorkspaceEnv) -> Result<Vec<PythonInterpreter>, String> {
    if workspace.is_wsl() || workspace.is_ssh() {
        return discover_posix_workspace(root, workspace);
    }
    discover_local(root.map(Path::new))
}

/// 在宿主机执行有限入口枚举，并在全局截止时间内逐个验证候选解释器。
fn discover_local(root: Option<&Path>) -> Result<Vec<PythonInterpreter>, String> {
    let deadline = Instant::now() + DISCOVERY_TIMEOUT;
    let env = effective_environment();
    let mut candidates = Vec::new();
    if let Some(root) = root {
        for name in [".venv", "venv", "env"] {
            push_candidate(
                &mut candidates,
                virtual_env_interpreter_in(&root.join(name)),
                PythonInterpreterSource::Workspace,
            );
        }
    }

    if let Some(path) = env.get("VIRTUAL_ENV") {
        push_candidate(
            &mut candidates,
            virtual_env_interpreter_in(Path::new(path)),
            PythonInterpreterSource::Activated,
        );
    }
    if let Some(path) = env.get("CONDA_PREFIX") {
        push_candidate(
            &mut candidates,
            conda_interpreter_in(Path::new(path)),
            PythonInterpreterSource::Conda,
        );
    }

    add_path_candidates(&mut candidates, &env);
    #[cfg(windows)]
    add_windows_registry_candidates(&mut candidates);
    add_known_conda_candidates(&mut candidates);
    add_managed_install_candidates(&mut candidates, &env);
    add_known_virtualenv_candidates(&mut candidates, &env);
    let mut interpreters = Vec::new();
    let mut probed = HashSet::new();
    prepare_candidates(&mut candidates);
    probe_candidates(&candidates, deadline, &mut probed, &mut interpreters);

    // 先验证无需额外子进程即可获得的候选，避免 Conda 或 launcher 卡顿时
    // 把已经发现的 PATH、注册表和项目解释器一起饿死。
    #[cfg(windows)]
    {
        add_py_launcher_candidates(&mut candidates, &env, deadline);
        prepare_candidates(&mut candidates);
        probe_candidates(&candidates, deadline, &mut probed, &mut interpreters);
    }
    add_conda_environment_candidates(&mut candidates, &env, deadline);
    prepare_candidates(&mut candidates);
    probe_candidates(&candidates, deadline, &mut probed, &mut interpreters);

    if interpreters.is_empty() && remaining_timeout(deadline).is_none() {
        return Err("Python interpreter discovery timed out".to_string());
    }
    finish_interpreters(&mut interpreters, cfg!(windows));
    Ok(interpreters)
}

/// 在 WSL 或 SSH 的固定 POSIX 脚本中发现解释器，不把远端路径交给宿主机解析。
fn discover_posix_workspace(
    root: Option<&str>,
    workspace: WorkspaceEnv,
) -> Result<Vec<PythonInterpreter>, String> {
    let command = format!(
        "TERAX_PYTHON_PROBE={}\n{REMOTE_DISCOVERY_SCRIPT}",
        remote::session::shell_quote(PROBE_CODE),
    );
    let output = shell::run_blocking_inner(
        command,
        root.map(str::to_string),
        workspace,
        DISCOVERY_TIMEOUT,
    )?;
    if output.timed_out {
        return Err("Python interpreter discovery timed out".to_string());
    }
    let mut interpreters = output
        .stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<ProbeRecord>(line).ok())
        .map(interpreter_from_probe)
        .collect::<Vec<_>>();
    finish_interpreters(&mut interpreters, false);
    Ok(interpreters)
}

/// 在解释器所属运行环境内验证用户明确给出的绝对路径。
fn probe_explicit(path: &str, workspace: WorkspaceEnv) -> Result<PythonInterpreter, String> {
    if workspace.is_wsl() || workspace.is_ssh() {
        if !path.starts_with('/') {
            return Err("Python interpreter must be an absolute path".to_string());
        }
        let command = format!(
            "{} -I -c {} manual",
            remote::session::shell_quote(path),
            remote::session::shell_quote(PROBE_CODE),
        );
        let output = shell::run_blocking_inner(command, None, workspace, COMMAND_TIMEOUT)?;
        if output.timed_out {
            return Err("Python interpreter probe timed out".to_string());
        }
        let record = output
            .stdout
            .lines()
            .find_map(|line| serde_json::from_str::<ProbeRecord>(line).ok())
            .ok_or_else(|| "The selected path is not a usable Python interpreter".to_string())?;
        return Ok(interpreter_from_probe(record));
    }

    let path = PathBuf::from(path.trim());
    if !path.is_absolute() || !path.is_file() {
        return Err("Python interpreter must be an existing absolute file".to_string());
    }
    probe_local_candidate(
        &Candidate {
            path,
            source: PythonInterpreterSource::Manual,
        },
        COMMAND_TIMEOUT,
    )
    .ok_or_else(|| "The selected path is not a usable Python interpreter".to_string())
}

/// 启动单个宿主机候选并解析其自报元数据，失败候选不会中断整体发现。
fn probe_local_candidate(candidate: &Candidate, timeout: Duration) -> Option<PythonInterpreter> {
    let mut command = Command::new(&candidate.path);
    command.args(["-I", "-c", PROBE_CODE, source_name(candidate.source)]);
    let output = run_capped(&mut command, timeout).ok()?;
    if !output.success {
        return None;
    }
    let mut record: ProbeRecord = serde_json::from_slice(&output.stdout).ok()?;
    record.source = candidate.source;
    Some(interpreter_from_probe(record))
}

/// 根据解释器自身的 prefix 信息和发现来源判定环境类型与展示名称。
fn interpreter_from_probe(record: ProbeRecord) -> PythonInterpreter {
    let kind = if record.source == PythonInterpreterSource::Workspace {
        PythonEnvironmentKind::WorkspaceVirtualEnv
    } else if record.source == PythonInterpreterSource::Conda || record.is_conda {
        PythonEnvironmentKind::Conda
    } else if path_identity(&record.prefix, cfg!(windows))
        != path_identity(&record.base_prefix, cfg!(windows))
    {
        PythonEnvironmentKind::VirtualEnv
    } else {
        PythonEnvironmentKind::System
    };
    let root_name = Path::new(&record.prefix)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("Python");
    let name = match kind {
        PythonEnvironmentKind::WorkspaceVirtualEnv | PythonEnvironmentKind::VirtualEnv => {
            root_name.to_string()
        }
        PythonEnvironmentKind::Conda => {
            if matches!(
                root_name.to_ascii_lowercase().as_str(),
                "anaconda3" | "miniconda3" | "miniforge3" | "mambaforge"
            ) {
                "base".to_string()
            } else {
                root_name.to_string()
            }
        }
        PythonEnvironmentKind::System => format!("Python {}", short_version(&record.version)),
    };
    PythonInterpreter {
        path: record.path,
        environment_root: record.prefix,
        version: record.version,
        name,
        kind,
        source: record.source,
    }
}

/// 按来源稳定排序，并以环境根目录去除同一解释器的多个发现入口。
fn finish_interpreters(interpreters: &mut Vec<PythonInterpreter>, windows: bool) {
    interpreters.sort_by(|left, right| {
        source_priority(left.source)
            .cmp(&source_priority(right.source))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.path.cmp(&right.path))
    });
    let mut seen = HashSet::new();
    interpreters
        .retain(|interpreter| seen.insert(path_identity(&interpreter.environment_root, windows)));
}

fn source_priority(source: PythonInterpreterSource) -> u8 {
    match source {
        PythonInterpreterSource::Workspace => 0,
        PythonInterpreterSource::Activated => 1,
        PythonInterpreterSource::VirtualEnv => 2,
        PythonInterpreterSource::Conda => 3,
        PythonInterpreterSource::Launcher => 4,
        PythonInterpreterSource::Path => 5,
        PythonInterpreterSource::Registry => 6,
        PythonInterpreterSource::Manual => 7,
    }
}

fn source_name(source: PythonInterpreterSource) -> &'static str {
    match source {
        PythonInterpreterSource::Workspace => "workspace",
        PythonInterpreterSource::Activated => "activated",
        PythonInterpreterSource::VirtualEnv => "virtualEnv",
        PythonInterpreterSource::Conda => "conda",
        PythonInterpreterSource::Launcher => "launcher",
        PythonInterpreterSource::Registry => "registry",
        PythonInterpreterSource::Path => "path",
        PythonInterpreterSource::Manual => "manual",
    }
}

fn short_version(version: &str) -> &str {
    version
        .rsplit_once('.')
        .map(|(short, _)| short)
        .unwrap_or(version)
}

/// 返回标准 venv 或 virtualenv 环境中的解释器路径。
fn virtual_env_interpreter_in(environment: &Path) -> PathBuf {
    #[cfg(windows)]
    return environment.join("Scripts").join("python.exe");
    #[cfg(not(windows))]
    return environment.join("bin").join("python");
}

/// 返回 Conda 环境中的解释器路径。
///
/// Windows Conda 与 venv 的目录布局不同，解释器位于环境根目录而不是 Scripts。
fn conda_interpreter_in(environment: &Path) -> PathBuf {
    #[cfg(windows)]
    return environment.join("python.exe");
    #[cfg(not(windows))]
    return environment.join("bin").join("python");
}

fn push_candidate(candidates: &mut Vec<Candidate>, path: PathBuf, source: PythonInterpreterSource) {
    if path.is_file() {
        candidates.push(Candidate { path, source });
    }
}

fn dedupe_candidates(candidates: &mut Vec<Candidate>) {
    let mut seen = HashSet::new();
    candidates.retain(|candidate| {
        seen.insert(path_identity(
            &candidate.path.to_string_lossy(),
            cfg!(windows),
        ))
    });
}

/// 去重并按探测成本排序候选，确保直接入口不会被大量环境枚举结果饿死。
fn prepare_candidates(candidates: &mut Vec<Candidate>) {
    dedupe_candidates(candidates);
    candidates.sort_by_key(|candidate| probe_priority(candidate.source));
    candidates.truncate(MAX_CANDIDATES);
}

fn probe_priority(source: PythonInterpreterSource) -> u8 {
    match source {
        PythonInterpreterSource::Workspace => 0,
        PythonInterpreterSource::Activated => 1,
        PythonInterpreterSource::Path => 2,
        PythonInterpreterSource::Registry => 3,
        PythonInterpreterSource::Launcher => 4,
        PythonInterpreterSource::Conda => 5,
        PythonInterpreterSource::VirtualEnv => 6,
        PythonInterpreterSource::Manual => 7,
    }
}

/// 在共享截止时间内只探测尚未处理的候选，并保留已经获得的部分结果。
fn probe_candidates(
    candidates: &[Candidate],
    deadline: Instant,
    probed: &mut HashSet<String>,
    interpreters: &mut Vec<PythonInterpreter>,
) {
    for candidate in candidates {
        let identity = path_identity(&candidate.path.to_string_lossy(), cfg!(windows));
        if !probed.insert(identity) {
            continue;
        }
        let Some(timeout) = remaining_timeout(deadline) else {
            break;
        };
        if let Some(interpreter) = probe_local_candidate(candidate, timeout) {
            interpreters.push(interpreter);
        }
    }
}

fn path_identity(path: &str, windows: bool) -> String {
    let normalized = path.replace('\\', "/");
    if windows {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

/// 读取进程环境，并在 Unix GUI 启动场景中补充登录 Shell 环境。
fn effective_environment() -> HashMap<String, String> {
    let env = std::env::vars()
        .map(|(key, value)| (normalize_environment_key(&key, cfg!(windows)), value))
        .collect::<HashMap<_, _>>();
    #[cfg(unix)]
    let mut env = env;
    #[cfg(unix)]
    if let Some(login) = capture_login_environment() {
        env.extend(login);
    }
    env
}

/// 将 Windows 环境变量键统一为大写，避免普通 HashMap 丢失系统的大小写不敏感语义。
fn normalize_environment_key(key: &str, windows: bool) -> String {
    if windows {
        key.to_ascii_uppercase()
    } else {
        key.to_string()
    }
}

#[cfg(unix)]
fn capture_login_environment() -> Option<HashMap<String, String>> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    for (script, nul_terminated) in [("/usr/bin/env -0", true), ("/usr/bin/env", false)] {
        let mut command = Command::new(&shell);
        command.args(["-l", "-c", script]);
        let Ok(output) = run_capped(&mut command, COMMAND_TIMEOUT) else {
            continue;
        };
        if !output.success {
            continue;
        }
        let values = parse_environment_output(&output.stdout, nul_terminated);
        if !values.is_empty() {
            return Some(values);
        }
    }
    None
}

/// 解析登录环境输出，优先使用 NUL 边界并兼容不支持 `env -0` 的 BSD 系统。
#[cfg(unix)]
fn parse_environment_output(output: &[u8], nul_terminated: bool) -> HashMap<String, String> {
    let text = String::from_utf8_lossy(output);
    let entries = text.split(if nul_terminated { '\0' } else { '\n' });
    entries
        .filter_map(|entry| {
            let entry = entry.trim_end_matches('\r');
            let (key, value) = entry.split_once('=')?;
            (!key.is_empty()).then(|| (key.to_string(), value.to_string()))
        })
        .collect()
}

/// 从当前进程 PATH 中加入无需额外枚举命令的直接入口。
fn add_path_candidates(candidates: &mut Vec<Candidate>, env: &HashMap<String, String>) {
    let path = env.get("PATH").cloned();
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    for command in ["python3", "python"] {
        if let Ok(found) = which::which_in(command, path.clone(), &cwd) {
            push_candidate(candidates, found, PythonInterpreterSource::Path);
        }
    }
}

/// 浅层枚举常见 venv、virtualenv、Pipenv 与 Poetry 环境目录，不递归扫描磁盘。
fn add_known_virtualenv_candidates(candidates: &mut Vec<Candidate>, env: &HashMap<String, String>) {
    let mut roots = env
        .get("WORKON_HOME")
        .map(PathBuf::from)
        .into_iter()
        .collect::<Vec<_>>();
    if let Some(home) = dirs::home_dir() {
        roots.extend([
            home.join(".virtualenvs"),
            home.join(".local").join("share").join("virtualenvs"),
            home.join(".cache").join("pypoetry").join("virtualenvs"),
            home.join("Library")
                .join("Caches")
                .join("pypoetry")
                .join("virtualenvs"),
        ]);
    }
    if let Some(local_app_data) = env.get("LOCALAPPDATA") {
        roots.push(
            Path::new(local_app_data)
                .join("pypoetry")
                .join("Cache")
                .join("virtualenvs"),
        );
    }
    let mut discovered = 0;
    for root in roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for environment in entries.flatten().map(|entry| entry.path()) {
            if discovered >= MAX_KNOWN_VIRTUAL_ENVS {
                return;
            }
            if environment.join("pyvenv.cfg").is_file() {
                let interpreter = virtual_env_interpreter_in(&environment);
                if !interpreter.is_file() {
                    continue;
                }
                push_candidate(candidates, interpreter, PythonInterpreterSource::VirtualEnv);
                discovered += 1;
            }
        }
    }
}

/// 返回不需要调用 Conda 命令即可确定的常见安装根。
fn known_conda_roots() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let roots = ["miniconda3", "anaconda3", "miniforge3", "mambaforge"]
        .into_iter()
        .map(|name| home.join(name))
        .collect::<Vec<_>>();
    #[cfg(windows)]
    let roots = {
        let mut roots = roots;
        roots.extend(
            ["miniconda3", "anaconda3", "miniforge3", "mambaforge"]
                .into_iter()
                .map(|name| home.join("scoop").join("apps").join(name).join("current")),
        );
        roots
    };
    roots
}

/// 加入 Conda 基础环境，以及 Scoop 等安装器管理的已知根目录。
fn add_known_conda_candidates(candidates: &mut Vec<Candidate>) {
    for root in known_conda_roots() {
        push_candidate(
            candidates,
            conda_interpreter_in(&root),
            PythonInterpreterSource::Conda,
        );
    }
}

/// 浅层枚举 CPython、uv、pyenv 与 Scoop 的已知安装目录。
fn add_managed_install_candidates(candidates: &mut Vec<Candidate>, _env: &HashMap<String, String>) {
    let mut roots = Vec::new();
    if let Some(home) = dirs::home_dir() {
        #[cfg(windows)]
        {
            push_candidate(
                candidates,
                home.join("scoop")
                    .join("apps")
                    .join("python")
                    .join("current")
                    .join("python.exe"),
                PythonInterpreterSource::Path,
            );
            roots.extend([
                home.join(".pyenv").join("pyenv-win").join("versions"),
                home.join("scoop").join("persist").join("uv").join("python"),
            ]);
        }
        #[cfg(not(windows))]
        roots.extend([
            home.join(".local").join("share").join("uv").join("python"),
            home.join(".pyenv").join("versions"),
            home.join(".rye").join("py"),
        ]);
    }
    #[cfg(windows)]
    {
        if let Some(local_app_data) = _env.get("LOCALAPPDATA") {
            roots.push(Path::new(local_app_data).join("Programs").join("Python"));
        }
        if let Some(app_data) = _env.get("APPDATA") {
            roots.push(Path::new(app_data).join("uv").join("python"));
        }
    }

    let mut discovered = 0;
    for root in roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for installation in entries.flatten().map(|entry| entry.path()) {
            if discovered >= MAX_KNOWN_INSTALLS {
                return;
            }
            if push_managed_candidate(candidates, &installation) {
                discovered += 1;
            }
        }
    }
}

/// 按系统 Python 安装布局加入版本管理器入口，至少找到一个候选时返回 true。
fn push_managed_candidate(candidates: &mut Vec<Candidate>, installation: &Path) -> bool {
    let previous_len = candidates.len();
    #[cfg(windows)]
    push_candidate(
        candidates,
        installation.join("python.exe"),
        PythonInterpreterSource::Path,
    );
    #[cfg(not(windows))]
    {
        push_candidate(
            candidates,
            installation.join("bin").join("python3"),
            PythonInterpreterSource::Path,
        );
        push_candidate(
            candidates,
            installation.join("bin").join("python"),
            PythonInterpreterSource::Path,
        );
    }
    candidates.len() > previous_len
}

/// 通过 Conda 自身枚举命名环境，所有命令共享发现阶段的剩余时间。
fn add_conda_environment_candidates(
    candidates: &mut Vec<Candidate>,
    env: &HashMap<String, String>,
    deadline: Instant,
) {
    let mut executables = Vec::new();
    if let Some(path) = env.get("CONDA_EXE") {
        let path = PathBuf::from(path);
        if path.is_file() {
            executables.push(path);
        }
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if let Ok(path) = which::which_in("conda", env.get("PATH").cloned(), cwd) {
        executables.push(path);
    }
    for root in known_conda_roots() {
        #[cfg(windows)]
        let executable = root.join("Scripts").join("conda.exe");
        #[cfg(not(windows))]
        let executable = root.join("bin").join("conda");
        if executable.is_file() {
            executables.push(executable);
        }
    }
    let mut seen = HashSet::new();
    for executable in executables {
        let Some(timeout) = remaining_timeout(deadline) else {
            break;
        };
        if !seen.insert(path_identity(&executable.to_string_lossy(), cfg!(windows))) {
            continue;
        }
        let mut command = Command::new(executable);
        command.args(["env", "list", "--json"]);
        let Ok(output) = run_capped(&mut command, timeout) else {
            continue;
        };
        if !output.success {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&output.stdout) else {
            continue;
        };
        let Some(envs) = value.get("envs").and_then(serde_json::Value::as_array) else {
            continue;
        };
        for prefix in envs.iter().filter_map(serde_json::Value::as_str) {
            push_candidate(
                candidates,
                conda_interpreter_in(Path::new(prefix)),
                PythonInterpreterSource::Conda,
            );
        }
    }
}

/// 调用 Windows Python launcher 枚举其注册的解释器路径。
#[cfg(windows)]
fn add_py_launcher_candidates(
    candidates: &mut Vec<Candidate>,
    env: &HashMap<String, String>,
    deadline: Instant,
) {
    let Some(timeout) = remaining_timeout(deadline) else {
        return;
    };
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let Ok(launcher) = which::which_in("py.exe", env.get("PATH").cloned(), cwd) else {
        return;
    };
    let mut command = Command::new(launcher);
    command.arg("-0p");
    let Ok(output) = run_capped(&mut command, timeout) else {
        return;
    };
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        if let Some(path) = windows_path_from_launcher_line(line) {
            push_candidate(candidates, path, PythonInterpreterSource::Launcher);
        }
    }
}

/// 从旧版与新版 Windows Python launcher 的列表行中提取绝对路径。
#[cfg(windows)]
fn windows_path_from_launcher_line(line: &str) -> Option<PathBuf> {
    let bytes = line.as_bytes();
    let index = (0..bytes.len().saturating_sub(2)).find(|index| {
        bytes[*index].is_ascii_alphabetic()
            && bytes[*index + 1] == b':'
            && matches!(bytes[*index + 2], b'\\' | b'/')
    })?;
    let value = line[index..]
        .trim()
        .trim_end_matches('*')
        .trim()
        .trim_matches('"');
    let path = PathBuf::from(value);
    path.is_file().then_some(path)
}

/// 枚举 PEP 514 与 Microsoft Store lookaside 注册表中的 Python 安装。
#[cfg(windows)]
fn add_windows_registry_candidates(candidates: &mut Vec<Candidate>) {
    use winreg::enums::{
        HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
    };
    use winreg::RegKey;

    let mut add_core = |root: &RegKey, key: &str, view| {
        let Ok(core) = root.open_subkey_with_flags(key, KEY_READ | view) else {
            return;
        };
        for tag in core.enum_keys().flatten() {
            let Ok(install) =
                core.open_subkey_with_flags(format!(r"{tag}\InstallPath"), KEY_READ | view)
            else {
                continue;
            };
            let executable = install
                .get_value::<String, _>("ExecutablePath")
                .ok()
                .map(PathBuf::from)
                .or_else(|| {
                    install
                        .get_value::<String, _>("")
                        .ok()
                        .map(|path| Path::new(&path).join("python.exe"))
                });
            if let Some(executable) = executable {
                push_candidate(candidates, executable, PythonInterpreterSource::Registry);
            }
        }
    };

    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let root = RegKey::predef(hive);
        for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
            let Ok(python) = root.open_subkey_with_flags(r"SOFTWARE\Python", KEY_READ | view)
            else {
                continue;
            };
            for company in python.enum_keys().flatten() {
                add_core(&root, &format!(r"SOFTWARE\Python\{company}"), view);
            }
        }
    }

    // Microsoft Store 安装使用无法通过常规 PythonCore 枚举得到的 lookaside 键。
    let machine = RegKey::predef(HKEY_LOCAL_MACHINE);
    for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
        add_core(
            &machine,
            r"SOFTWARE\Microsoft\AppModel\Lookaside\user\Software\Python\PythonCore",
            view,
        );
    }
}

/// 计算单次命令在发现阶段总截止时间内可使用的等待时长。
fn remaining_timeout(deadline: Instant) -> Option<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .map(|remaining| remaining.min(COMMAND_TIMEOUT))
        .filter(|remaining| !remaining.is_zero())
}

/// 执行子进程并同时限制等待时间和管道读取量，避免发现阶段被异常程序拖住。
fn run_capped(command: &mut Command, timeout: Duration) -> Result<CappedOutput, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    proc::hide_console(command);
    let child = Arc::new(SharedChild::spawn(command).map_err(|error| error.to_string())?);
    let stdout = child
        .take_stdout()
        .ok_or_else(|| "Python command stdout was unavailable".to_string())?;
    let stderr = child
        .take_stderr()
        .ok_or_else(|| "Python command stderr was unavailable".to_string())?;
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.take(MAX_OUTPUT_BYTES + 1).read_to_end(&mut bytes);
        bytes
    });
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.take(MAX_OUTPUT_BYTES + 1).read_to_end(&mut bytes);
        bytes
    });
    let (sender, receiver) = mpsc::channel();
    let waiter = Arc::clone(&child);
    thread::spawn(move || {
        let _ = sender.send(waiter.wait());
    });
    let status = match receiver.recv_timeout(timeout) {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => return Err(error.to_string()),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Python command timed out".to_string());
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            return Err("Python command waiter disconnected".to_string());
        }
    };
    let stdout = stdout_reader.join().unwrap_or_default();
    let _ = stderr_reader.join();
    if stdout.len() as u64 > MAX_OUTPUT_BYTES {
        return Err("Python command output exceeded the limit".to_string());
    }
    Ok(CappedOutput {
        success: status.success(),
        stdout,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpreter_kind_and_name_follow_probe_identity() {
        let workspace = interpreter_from_probe(ProbeRecord {
            path: "/repo/.venv/bin/python".to_string(),
            prefix: "/repo/.venv".to_string(),
            base_prefix: "/usr".to_string(),
            version: "3.12.4".to_string(),
            source: PythonInterpreterSource::Workspace,
            is_conda: false,
        });
        assert_eq!(workspace.kind, PythonEnvironmentKind::WorkspaceVirtualEnv);
        assert_eq!(workspace.name, ".venv");

        let virtual_env = interpreter_from_probe(ProbeRecord {
            path: "/home/user/.virtualenvs/tool/bin/python".to_string(),
            prefix: "/home/user/.virtualenvs/tool".to_string(),
            base_prefix: "/usr".to_string(),
            version: "3.13.1".to_string(),
            source: PythonInterpreterSource::VirtualEnv,
            is_conda: false,
        });
        assert_eq!(virtual_env.kind, PythonEnvironmentKind::VirtualEnv);
        assert_eq!(virtual_env.name, "tool");

        let system = interpreter_from_probe(ProbeRecord {
            path: "/usr/bin/python3".to_string(),
            prefix: "/usr".to_string(),
            base_prefix: "/usr".to_string(),
            version: "3.11.9".to_string(),
            source: PythonInterpreterSource::Path,
            is_conda: false,
        });
        assert_eq!(system.kind, PythonEnvironmentKind::System);
        assert_eq!(system.name, "Python 3.11");

        let custom_conda = interpreter_from_probe(ProbeRecord {
            path: "/opt/custom/bin/python".to_string(),
            prefix: "/opt/custom".to_string(),
            base_prefix: "/opt/custom".to_string(),
            version: "3.12.8".to_string(),
            source: PythonInterpreterSource::Path,
            is_conda: true,
        });
        assert_eq!(custom_conda.kind, PythonEnvironmentKind::Conda);
        assert_eq!(custom_conda.name, "custom");
    }

    #[test]
    fn sorting_prefers_workspace_then_activated_then_conda() {
        let make = |source, root: &str| PythonInterpreter {
            path: format!("{root}/bin/python"),
            environment_root: root.to_string(),
            version: "3.12.0".to_string(),
            name: root.to_string(),
            kind: PythonEnvironmentKind::VirtualEnv,
            source,
        };
        let mut interpreters = vec![
            make(PythonInterpreterSource::Conda, "/conda"),
            make(PythonInterpreterSource::Workspace, "/workspace"),
            make(PythonInterpreterSource::Activated, "/active"),
        ];
        finish_interpreters(&mut interpreters, false);
        assert_eq!(
            interpreters
                .iter()
                .map(|value| value.source)
                .collect::<Vec<_>>(),
            vec![
                PythonInterpreterSource::Workspace,
                PythonInterpreterSource::Activated,
                PythonInterpreterSource::Conda,
            ]
        );
    }

    #[test]
    fn environment_identity_deduplicates_equivalent_paths() {
        let mut interpreters = vec![
            PythonInterpreter {
                path: "C:/Python/python.exe".to_string(),
                environment_root: "C:/Python".to_string(),
                version: "3.12.0".to_string(),
                name: "Python 3.12".to_string(),
                kind: PythonEnvironmentKind::System,
                source: PythonInterpreterSource::Path,
            },
            PythonInterpreter {
                path: "c:\\python\\python.exe".to_string(),
                environment_root: "c:\\python".to_string(),
                version: "3.12.0".to_string(),
                name: "Python 3.12".to_string(),
                kind: PythonEnvironmentKind::System,
                source: PythonInterpreterSource::Registry,
            },
        ];
        finish_interpreters(&mut interpreters, true);
        assert_eq!(interpreters.len(), 1);
    }

    #[test]
    fn windows_environment_keys_are_normalized_before_hash_lookup() {
        assert_eq!(normalize_environment_key("Path", true), "PATH");
        assert_eq!(normalize_environment_key("Conda_Exe", true), "CONDA_EXE");
        assert_eq!(normalize_environment_key("Path", false), "Path");
    }

    #[test]
    fn candidate_probe_order_prefers_direct_entries() {
        let mut candidates = vec![
            Candidate {
                path: PathBuf::from("virtual-python"),
                source: PythonInterpreterSource::VirtualEnv,
            },
            Candidate {
                path: PathBuf::from("conda-python"),
                source: PythonInterpreterSource::Conda,
            },
            Candidate {
                path: PathBuf::from("path-python"),
                source: PythonInterpreterSource::Path,
            },
            Candidate {
                path: PathBuf::from("workspace-python"),
                source: PythonInterpreterSource::Workspace,
            },
        ];

        prepare_candidates(&mut candidates);

        assert_eq!(
            candidates
                .iter()
                .map(|candidate| candidate.source)
                .collect::<Vec<_>>(),
            vec![
                PythonInterpreterSource::Workspace,
                PythonInterpreterSource::Path,
                PythonInterpreterSource::Conda,
                PythonInterpreterSource::VirtualEnv,
            ]
        );
    }

    #[cfg(windows)]
    #[test]
    fn conda_and_virtualenv_use_distinct_windows_layouts() {
        let root = Path::new(r"C:\env");
        assert_eq!(
            virtual_env_interpreter_in(root),
            PathBuf::from(r"C:\env\Scripts\python.exe")
        );
        assert_eq!(
            conda_interpreter_in(root),
            PathBuf::from(r"C:\env\python.exe")
        );
    }

    #[cfg(windows)]
    #[test]
    fn launcher_parser_ignores_quotes_and_default_marker() {
        let executable = std::env::current_exe().expect("current test executable");
        let line = format!(r#" -V:3.13 *    "{}" *"#, executable.display());
        assert_eq!(windows_path_from_launcher_line(&line), Some(executable));
    }
}
