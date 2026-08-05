# File transfer architecture

This guide elaborates on `AGENTS.md`. If anything here conflicts with `AGENTS.md`, `AGENTS.md` wins.

## Scope

Terax supports background file and directory transfer between the Host and the immutable WSL or SSH environment selected when the Workspace process starts. The Rust backend owns task state, filesystem access, scheduling, and final publication. The webview only creates and controls tasks through typed Tauri commands.

Task execution is process-local, while low-frequency task history is persisted in `~/.terax/transfers` as one JSONL Journal per task. A process restart does not resume transferred bytes. Instead, an interrupted active task is recovered as failed with stable aggregate counts.

## Execution flow

Every task follows the same flow:

1. Normalize the request and bind it to the current Workspace environment.
2. Scan sources, reject unsupported entries, and build a strategy-independent manifest.
3. Reserve all final top-level destinations in the process.
4. Check destination conflicts and wait for explicit user decisions while retaining the destination reservation but not a data-transfer permit.
5. Wait for one of two execution permits in the current Workspace process.
6. Write each root to a task-owned sibling path named `.terax-part-<task-id>-<index>`.
7. Recheck source identity, transferred size, and the destination state covered by each conflict decision.
8. Publish new, replaced, or merged roots with the commit mode authorized for that task.
9. Remove only temporary paths owned by the task and release reservations.

Direct and Archive are explicit choices carried by the unified enqueue request. They share the same lifecycle, manifest, reservation, progress, and commit protocol. Terax never selects a strategy automatically and never silently falls back from Archive to Direct.

## Strategies

### Direct

Direct copies files individually. A directory is one aggregate task: recoverable file failures are recorded and other files continue, while connection loss, exhausted storage, an unreliable Journal, and commit failures stop the task. Child conflicts can be skipped or replaced, and either choice can be reused for the remaining conflicts in that execution. Skipped source entries never enter staging and preserve the existing destination. Failed files can be retried or ignored in the original aggregate row. Each retry rechecks the source and conflicts without reusing a previous bulk decision.

SSH transfers use a task-exclusive SFTP session, bounded in-flight requests, offset-based writes, and close-result verification. WSL Direct uses the Host filesystem bridge. Empty directories and portable permission and modification-time metadata are preserved.

### Archive

Archive builds a tar.gz stream and transfers it once across the environment boundary. Uploads are validated locally before transfer and safely extracted in a private remote work directory. Downloads are created remotely, then validated and extracted locally against the planner manifest. When the destination directory already exists, source-first merge preserves destination-only entries while replacing conflicts, and destination-first merge preserves source-only entries while keeping conflicts unchanged.

Archive rejects absolute paths, parent traversal, links, special files, duplicate manifest entries, unexpected entries, size mismatches, invalid gzip data, and excessive trailing data. SSH Archive requires Linux, bash, tar, gzip, and a private temporary directory. Missing tools produce an explicit failure.

## Safety and integrity

- WSL and SSH transfer paths must be normalized absolute paths without parent traversal or control characters. Explicit Explorer selections may be outside the profile's startup root.
- Symbolic links, hard links, sockets, devices, and other special files are not transferred.
- Final destinations are reserved with ancestor and descendant overlap checks before execution and checked again at commit time.
- A new destination uses no-replace publication. Existing targets are changed only by an explicit conflict decision. Direct directory merges also revalidate every reachable source path observed during conflict checking, including paths that were absent.
- Direct can expose roots one at a time. If a later root fails, already committed roots remain and the Workspace receives a filesystem-change event. Archive publishes all roots as one transaction and rolls them back together on failure.
- Cancel and failure cleanup only target paths derived from the task ID. After a root is successfully published, the same restricted cleanup path also removes its derived backup. A backup retained by a failed commit or rollback is recovery data and is never scheduled for generic cleanup. Remote cleanup additionally requires an exact canonical destination parent captured by the task, and never recursively removes a final destination.
- Direct rechecks planned source identity and file size. SSH transport provides packet integrity. Archive also validates gzip and the complete manifest. A second content-hash protocol is not included because the current threat model does not require it; adding one needs an explicit algorithm, performance budget, and user-visible contract.

## Failure and retry model

Task snapshots expose a stable error code, diagnostic detail, aggregate file counts, unresolved Direct file failures, and whether whole-task retry is meaningful. The frontend localizes the stable code and does not parse backend English text. Whole-task retry creates a new task from the original request. Direct file retry reuses the original aggregate task but creates a fresh execution identity and staging path.

Each SSH filesystem operation has a 15-second upper bound so a broken transport cannot hold an execution permit indefinitely. If disconnect prevents immediate cleanup, the current Workspace process waits up to ten minutes for the same stable host, port, and username endpoint to reconnect, then retries removal. Rebinding the same profile ID to another endpoint never transfers the cleanup authorization.

Deferred local, WSL, and SSH cleanup retains process-local task ownership until removal is confirmed. Manual history deletion, bulk clearing, and automatic pruning skip a task while any of its cleanup operations remain pending.

An abrupt process exit can still leave uniquely named target-side staging paths. They are never treated as completed destinations or reused. The Journal preserves the interrupted task as failed, but the first version does not provide byte-level resume.

## Resource bounds

- At most 2 tasks execute concurrently.
- At most 64 tasks may be non-terminal or retain pending cleanup ownership.
- At most 100 terminal history entries are retained.
- A request contains at most 1,024 sources.
- Each source or destination path contains at most 32 KiB.
- SSH transfer and cleanup sessions are separate from the Explorer's cached SFTP session.

These limits keep malformed IPC requests and an unattended task producer from creating unbounded memory, network, or file-descriptor pressure.

## IPC and events

- `transfer_enqueue` creates a Direct or Archive task according to `request.strategy`.
- `transfer_list` restores the current Workspace task history from Journals on first access.
- `transfer_resolve_conflict` submits a decision bound to the current task and conflict ID.
- `transfer_retry_failure` / `transfer_ignore_failure` update one Direct file failure in its aggregate task.
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
- SSH malformed-path rejection and task-owned cleanup escape rejection

Automated tests lock request limits, path boundaries, source identity, archive validation, no-replace and transactional commit, conflict preconditions, staging ownership, scheduler reservations, Journal replay, history bounds, structured errors, and frontend event convergence.

## See also

- [`AGENTS.md`](../../AGENTS.md) - architecture source of truth
- [Two-process model](two-process-model.md) - IPC ownership and command catalog
- [Security model](security-model.md) - Workspace and filesystem boundaries
- [Testing](../contributing/testing.md) - required quality checks and core-subsystem tests
