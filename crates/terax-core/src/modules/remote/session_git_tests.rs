//! 显式指定已有 SSH profile 才运行的隔离集成测试，凭据只通过原生秘密存储读取。
//! 在远端临时目录创建仓库，验证实际 SSH 执行与控制通道，结束时清理测试数据。

use super::*;
use crate::modules::proc::cancellation::{ProcessCancellation, PROCESS_CANCELLED};
use crate::modules::remote::git_service::{GitBatchKind, GitRemoteAction};

async fn connect_fixture() -> Result<Arc<RemoteWorkspace>, String> {
    let id = std::env::var("TERAX_TEST_SSH_PROFILE").map_err(|e| e.to_string())?;
    let mut profile = crate::modules::remote::profile::load(&id)?;
    profile.root_path = Some("/tmp".into());
    let secrets = secrets::SecretsState::default();
    let secret = secrets::get_value(
        &secrets,
        crate::modules::remote::profile::SECRET_SERVICE,
        &id,
    )?;
    let app = crate::modules::remote::RemoteHost {
        secrets,
        events: crate::events::EventSink::new(|event, _| {
            if event == "terax://ssh-host-key" {
                Err("test requires an already trusted SSH host key".into())
            } else {
                Ok(())
            }
        }),
    };
    let known_hosts = dirs::home_dir()
        .ok_or("missing home")?
        .join(".terax/ssh/known_hosts");
    RemoteWorkspace::connect(
        ConnectRequest {
            profile,
            secret,
            proxy_secret_override: None,
        },
        app,
        Arc::new(HostKeyVerifier::new(known_hosts)),
        CancellationToken::new(),
        Arc::new(Mutex::new(Some(ForegroundIntent::None))),
        Arc::new(AtomicBool::new(false)),
        Arc::new(SshTrafficMeter::default()),
    )
    .await
    .map(|connected| connected.workspace)
    .map_err(|failure| failure.message)
}

async fn exec(
    workspace: &RemoteWorkspace,
    directory: &str,
    script: &str,
) -> Result<Vec<u8>, String> {
    let output = workspace
        .exec(script, Some(directory), Duration::from_secs(30))
        .await?;
    if output.exit_code != Some(0) {
        return Err(format!(
            "SSH fixture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(output.stdout)
}

async fn exercise(workspace: &Arc<RemoteWorkspace>, directory: &str) -> Result<(), String> {
    exec(workspace, directory, "set -e; git init -q --bare origin; git init -q -b main repo; cd repo; git config user.name Test; git config user.email test@example.com; git config commit.gpgsign false; echo seed >file; git add file; git commit -qm seed; git remote add origin ../origin; git push -qu origin main").await?;
    let repo = format!("{directory}/repo");
    let fetch = |control: Arc<ProcessCancellation>| {
        let repo = repo.clone();
        let workspace = workspace.clone();
        async move {
            super::super::tasks::git_batch::execute(
                &workspace,
                &repo,
                GitBatchKind::RemoteAction {
                    action: GitRemoteAction::Fetch,
                },
                Some(&control),
            )
            .await
        }
    };
    let values = fetch(Arc::new(ProcessCancellation::default())).await?;
    if values.len() != 1 || values[0].exit_code != 0 {
        return Err("SSH fetch did not preserve its result frame".into());
    }
    exec(workspace, &repo, "git remote set-url origin ../missing").await?;
    let values = fetch(Arc::new(ProcessCancellation::default())).await?;
    if values[0].exit_code == 0 || values[0].stderr.is_empty() {
        return Err("SSH fetch lost Git failure output".into());
    }
    exec(workspace, &repo, "git remote set-url origin ../origin").await?;
    // 子进程忽略 TERM，必须由后续进程组 KILL 清理；有限循环确保失败时也不会永久驻留。
    let hook = "#!/bin/sh\n(sh -c 'trap \"\" TERM; echo $$ >child-pid; ps -o pgid= -p $$ | tr -d \" \" >group-id; touch child-ready; i=0; while [ ! -f release ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done; [ ! -f release ] || echo alive >survived') &\nwait\n";
    exec(
        workspace,
        &repo,
        &format!(
            "printf %s {} >.git/hooks/pre-push; chmod +x .git/hooks/pre-push",
            shell_quote(hook)
        ),
    )
    .await?;
    for disconnect in [false, true] {
        exec(
            workspace,
            &repo,
            "rm -f child-ready child-pid group-id release survived",
        )
        .await?;
        let control = Arc::new(ProcessCancellation::default());
        let task_workspace = workspace.clone();
        let task_repo = repo.clone();
        let task_control = control.clone();
        let task = tokio::spawn(async move {
            super::super::tasks::git_batch::execute(
                &task_workspace,
                &task_repo,
                GitBatchKind::RemoteAction {
                    action: GitRemoteAction::Push,
                },
                Some(&task_control),
            )
            .await
        });
        exec(workspace, &repo, "i=0; while [ ! -f child-ready ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done; test -f child-ready").await?;
        if disconnect {
            workspace.disconnect().await;
        }
        let cancelled = tokio::task::spawn_blocking(move || control.cancel())
            .await
            .map_err(|e| e.to_string())?;
        let outcome = tokio::time::timeout(Duration::from_secs(15), task)
            .await
            .map_err(|_| "SSH Git did not settle")?
            .map_err(|e| e.to_string())?;
        if disconnect {
            if cancelled == Ok(true)
                || outcome.is_ok()
                || outcome
                    .as_ref()
                    .is_err_and(|error| error == PROCESS_CANCELLED)
            {
                return Err(
                    "disconnected SSH operation incorrectly reported confirmed cancellation".into(),
                );
            }
        } else {
            if cancelled != Ok(true)
                || !outcome
                    .as_ref()
                    .is_err_and(|error| error == PROCESS_CANCELLED)
            {
                return Err(format!(
                    "SSH cancellation failed: {cancelled:?}, result={:?}",
                    outcome.err()
                ));
            }
            exec(workspace, &repo, "touch release; sleep 0.3; test ! -f survived; child=$(cat child-pid); test ! -r /proc/$child/stat || test \"$(cut -d ' ' -f 3 /proc/$child/stat)\" = Z").await?;
        }
    }
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires TERAX_TEST_SSH_PROFILE and explicit authorization for that server"]
async fn ssh_git_network_completion_failure_cancellation_and_disconnect() -> Result<(), String> {
    let workspace = connect_fixture().await?;
    let directory = exec(&workspace, "/tmp", "mktemp -d /tmp/terax-git-test.XXXXXXXX").await?;
    let directory = String::from_utf8(directory)
        .map_err(|e| e.to_string())?
        .trim()
        .to_owned();
    if !directory.starts_with("/tmp/terax-git-test.") || directory["/tmp/".len()..].contains('/') {
        return Err("invalid temporary test directory".into());
    }
    let result = exercise(&workspace, &directory).await;
    let cleanup = if workspace.is_closed() {
        connect_fixture().await?
    } else {
        workspace.clone()
    };
    let pid_file = format!("{directory}/repo/group-id");
    let stop = crate::modules::proc::group::posix_group_kill_command(&pid_file, false);
    let stopped = exec(&cleanup, "/tmp", &stop).await;
    let removed = exec(
        &cleanup,
        "/tmp",
        &format!("rm -rf -- {}", shell_quote(&directory)),
    )
    .await;
    cleanup.disconnect().await;
    workspace.disconnect().await;
    stopped?;
    removed?;
    result
}
