# Upstream Tracking

- Upstream repository: https://github.com/crynta/terax-ai.git
- Tracked upstream branch: `upstream/main`
- Initial base commit: `78a0b3dd79554ad4af89e61d97004f3475cd9953`

## Sync policy

This project is an independent downstream fork. Upstream changes are reviewed and selectively ported rather than merged wholesale.

## Temporary review: 2026-07-19

- Temporary branch: `chore/upstream-merge-review-2026-07-19`
- Tracked upstream branch: `upstream/main`
- Reviewed range: `a2c8329662ade6fef8c1e11f7353a7231256937d..fcff6c5b4cff4d00c85e6c2d587672d33f30ea38` (10 commits)
- Status: the requested `fcff6c5` cherry-pick and `ac88362` manual port are complete on the temporary branch; nothing has been merged back into downstream `main`.

### Decisions

- `3e9f374`, `0dc259d`, and `f1b92fc`: defer as one agent-tab-status feature chain. The final icon design supersedes the first badge design. Port the final behavior manually if desired because Workbench v2, terminal leaf ownership, and the existing agent notification store have diverged.
- `ac88362`: select for manual port. Restrict synthetic DA replies to leading startup queries and retain the regression tests. Completed in `8535f6c` after adapting the upstream change to the downstream `da_filter.rs`.
- `5c2f4cd`: defer for separate discussion. Its status-bar AI action and secondary-sidebar model diverge substantially from the downstream fork, so it should not be ported in this review.
- `7639523`: defer conditionally. Pi support is useful only if Pi is a supported downstream agent. If selected, port the extension installation, detector allowlist, icon, and localized hook row manually with ownership and attribution checks.
- `332a0c2`: defer. The collapsible alert list is a UX improvement without a correctness need and must be localized for this fork.
- `1e63968`: skip as a standalone change. It only follows Pi support, and attribution belongs in the downstream third-party notices if Pi is ported.
- `e5c3964`: selectively port documentation only. Removing the broken Star History embed is useful; the SignPath attribution must wait until release artifacts, rather than only the test workflow, are signed.
- `fcff6c5`: select for cherry-pick. It adds tests for pure logic modules and does not change production behavior. Cherry-picked as `6a195b2`.

### Downstream adaptations and follow-up

- Do not add a second terminal-agent signal store or listener. The downstream `AgentNotificationsBridge` already consumes `terax:agent-signal` and updates `useAgentStore`; tab indicators should reuse or deliberately consolidate that state.
- If the agent-tab feature is ported, ensure the idle phase is removed or excluded by `isAgentActivePty`; retaining an `idle` entry while checking key presence can keep a finished agent marked busy and prevent renderer-slot release.
- The Pi port needs tests for foreign-file refusal, atomic writes, symlinks, detector self-arming, and the actual installed Pi extension API.
- The README still says Windows builds are unsigned, while `.github/workflows/signpath-test.yml` signs only a manually dispatched test artifact. Do not claim production signing yet.

### Verification and blockers

- `upstream/main` was fetched successfully and is at `fcff6c5`.
- The selected source changes are limited to the `fcff6c5` test additions and the adapted `ac88362` PTY fix.
- `cargo fmt --all -- --check`, `cargo clippy --all-targets --locked -- -D warnings`, the focused `da_filter` tests, and the full frontend checks passed. Frontend lint still reports pre-existing warnings.
- Full `cargo test --locked` reached 229 passing tests and one known Windows failure in `authorize_spawn_cwd_blocks_symlink_escape` because the environment lacks the privilege required to create the test symlink.
- Remaining blockers: discuss `5c2f4cd` separately; Pi and agent-tab status remain deferred. These two requested changes are complete on this temporary branch and have not been merged into downstream `main`.

## Update workflow

For each upstream review, create a temporary branch and add a temporary update section to this file. Keep it current throughout the review so downstream adaptation can continue across multiple work sessions.

The temporary section must record:

- The temporary branch, tracked upstream branch, and reviewed commit or range.
- Each selected, skipped, or deferred upstream change and the reason for that decision.
- Downstream-specific adaptations, fixes, unresolved issues, and follow-up work.
- Verification already completed and any remaining merge blockers.

When the update is complete and ready to merge into downstream `main`, remove the temporary details and retain only the concise entry under Sync history.

## Sync history

- 2026-07-10: Synced selected upstream changes into downstream `main` at `6bdcd1ed40b633dfabb859957a8fcd8d9f8e5f7c`.
- 2026-07-14: Reviewed `upstream/main` through `a2c8329662ade6fef8c1e11f7353a7231256937d` and ported the accepted changes on `chore/upstream-merge-review-2026-07-14`.
