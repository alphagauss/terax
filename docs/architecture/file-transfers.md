# File transfer architecture

This guide elaborates on `AGENTS.md`. If anything here conflicts with `AGENTS.md`, `AGENTS.md` wins.

## Scope

Terax supports background file and directory transfer between the Host and the immutable WSL or SSH environment selected when the Workspace process starts. The Rust backend owns task state, filesystem access, scheduling, and final publication. The webview only creates and controls tasks through typed Tauri commands.

The current implementation is intentionally process-local. Tasks survive panel unmounts but not application process termination. Durable restart recovery, resumable journals, directory synchronization, and a two-pane file manager require separate product and persistence designs and are not part of this transfer foundation.

## Execution flow

Every task follows the same flow:

1. Normalize the request and bind it to the current Workspace environment.
2. Scan sources, reject unsupported entries, and build a strategy-independent manifest.
3. Reserve all final top-level destinations in the process.
4. Wait for one of two execution permits in the current Workspace process.
5. Write each root to a task-owned sibling path named `.terax-part-<task-id>-<index>`.
6. Recheck source identity and transferred size.
7. Publish each root with an operating-system no-replace rename.
8. Remove only staging paths owned by the task and release reservations.

Direct and Archive are separate user choices and separate enqueue commands. They share the same lifecycle, manifest, reservation, progress, and commit protocol. Terax never selects a strategy automatically and never silently falls back from Archive to Direct.

## Strategies

### Direct

Direct copies files individually. SSH transfers use a task-exclusive SFTP session, bounded in-flight requests, offset-based writes, and close-result verification. WSL Direct uses the Host filesystem bridge. Empty directories and portable permission and modification-time metadata are preserved.

### Archive

Archive builds a tar.gz stream and transfers it once across the environment boundary. Uploads are validated locally before transfer and safely extracted in a private remote work directory. Downloads are created remotely, then validated and extracted locally against the planner manifest.

Archive rejects absolute paths, parent traversal, links, special files, duplicate manifest entries, unexpected entries, size mismatches, invalid gzip data, and excessive trailing data. SSH Archive requires Linux, bash, tar, gzip, and a private temporary directory. Missing tools produce an explicit failure.

## Safety and integrity

- WSL and SSH paths must be normalized absolute paths inside the current Workspace root.
- Symbolic links, hard links, sockets, devices, and other special files are not transferred.
- Final destinations are reserved before execution and checked again at commit time.
- Final publication never overwrites an existing path.
- A multi-root task can expose roots one at a time. If a later root fails, already committed roots remain and the Workspace receives a filesystem-change event.
- Cancel and failure cleanup only target paths derived from the task ID. They never recursively remove a final destination.
- Direct rechecks planned source identity and file size. SSH transport provides packet integrity. Archive also validates gzip and the complete manifest. A second content-hash protocol is not included because the current threat model does not require it; adding one needs an explicit algorithm, performance budget, and user-visible contract.

## Failure and retry model

Task snapshots expose a stable error code, diagnostic detail, and whether retry is meaningful. The frontend localizes the stable code and does not parse backend English text. Retry creates a new task from the original request and never reuses incomplete staging.

Each SSH filesystem operation has a 15-second upper bound so a broken transport cannot hold an execution permit indefinitely. If disconnect prevents immediate cleanup, the current Workspace process waits up to ten minutes for the same profile to reconnect, opens a new task-exclusive SFTP session, and retries removal.

An abrupt process exit can still leave uniquely named staging paths because the task model is not durable. These paths are never treated as completed destinations and are not reused. Durable crash cleanup belongs with a future journal and restart-recovery design.

## Resource bounds

- At most 2 tasks execute concurrently.
- At most 64 non-terminal tasks are retained.
- At most 100 terminal history entries are retained.
- A request contains at most 1,024 sources.
- Each source or destination path contains at most 32 KiB.
- SSH transfer and cleanup sessions are separate from the Explorer's cached SFTP session.

These limits keep malformed IPC requests and an unattended task producer from creating unbounded memory, network, or file-descriptor pressure.

## IPC and events

- `transfer_enqueue_direct` and `transfer_enqueue_archive` create tasks.
- `transfer_list` restores the current process-local task list.
- `transfer_pause`, `transfer_resume`, and `transfer_cancel` control active tasks.
- `transfer_retry` creates a new task from a failed or canceled task.
- `transfer_remove` removes a terminal history entry.
- `terax://transfer-updated` carries complete task snapshots.
- `terax://transfer-removed` removes a pruned or manually removed entry.

The Rust manager is the only task-state authority. Frontend state is a projection of list results and events.

## Verification matrix

The implementation was exercised in real Tauri Workspace processes against local WSL and an authorized Linux SSH host:

- Direct and Archive upload and download of nested directories, Unicode names, and empty files
- SHA-256 comparison of transferred file contents in both directions
- pause and resume of a 64 MiB Direct transfer
- queued and running cancellation with staging cleanup
- existing-destination rejection without overwrite
- missing-source retry after the source appears
- WSL destination-full failure without publishing partial output
- SSH connection loss, bounded failure convergence, reconnect cleanup, retry, and final hash verification
- SSH Workspace-root escape rejection before server access

Automated tests lock request limits, path boundaries, source identity, archive validation, no-replace commit, staging ownership, scheduler reservations, history bounds, structured errors, and frontend event convergence.

## See also

- [`AGENTS.md`](../../AGENTS.md) - architecture source of truth
- [Two-process model](two-process-model.md) - IPC ownership and command catalog
- [Security model](security-model.md) - Workspace and filesystem boundaries
- [Testing](../contributing/testing.md) - required quality checks and core-subsystem tests
