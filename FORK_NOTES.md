# Upstream Tracking

Original project: https://github.com/crynta/terax-ai.git
Initial base commit: 78a0b3dd79554ad4af89e61d97004f3475cd9953

## Sync policy

This project is an independent downstream project.
We do not fully merge upstream.
We selectively cherry-pick or manually port bug fixes, security fixes, and useful optimizations.

## Picked upstream commits

### 2026-07-10
merge upstream to main :6bdcd1ed40b633dfabb859957a8fcd8d9f8e5f7c

### 2026-07-14
Prepared on temporary branch `chore/upstream-merge-review-2026-07-14`.

- `9616cc8 feat(ai): add current frontier models`
  - `97f4e10 chore(deps): update AI SDK providers`
  - `e6753c4 feat(ai): refresh model catalog and capabilities`
- `882641e fix(ai): surface provider errors safely`
  - `c827e4e fix(ai): safely surface provider errors`
- `ae9e690 feat(editor): add dotenv syntax highlighting`
  - `198ac37 feat(editor): add dotenv syntax highlighting`
- `7649926 fix(editor): refine Kanagawa JSX colors`
  - `9501e01 fix(editor): refine Kanagawa JSX colors`
- `e63ca2f feat(editor): add independent font sizing`
  - `a7da039 feat(editor): add independent font sizing`
- `b9d6039 feat(bundle): open files via the OS "Open With" action`
  - `a0c70fb feat(bundle): open a file via Open With`
- `a2c8329 feat(bundle): open multiple files via "Open With", add launch-parse tests`
  - `3015c19 feat(bundle): open multiple files via Open With`
- `a069d6f build(deps): bump the npm-prod-minor-patch group with 4 updates`
  - `8ccfbf5 build(deps): update production npm dependencies`
- `3e654c3 build(deps): bump the cargo group in /src-tauri with 3 updates`
  - `a93507a build(deps): update Cargo dependencies`
- `841c726 build(deps-dev): bump the npm-dev group across 1 directory with 9 updates`
  - `389b205 build(deps-dev): update development npm dependencies`

Fork-specific adaptation:

- `f990e57 feat(settings): manage Open With registration`
  - Open With files are always routed to the deterministic Local primary window.
  - Windows General settings provides explicit Register and Remove actions.
  - Registration uses the current executable path, writes only the current-user Open With entry, and does not change default applications.
- `ef56f61 fix(bundle): stabilize Open With registration and routing`
  - Registration writes the current-user registry directly instead of spawning a console process for every supported extension.
  - File-open requests use a locked queue that the target Workspace drains atomically, so concurrent launches cannot overwrite each other.
  - The frontend opens drained files through a stable callback instead of cancelling them during an activation state update.
- `c13ada6 feat(bundle): add Terax Explorer context menus`
  - Manual registration adds an icon-bearing Open with Terax action for files and selected folders.
  - File context actions use the Windows Document selection model so single and multi-file selections are routed through the existing locked queue.
  - Manual unregistration removes the application association and both Explorer context menu entries.
- `61ef39e fix(settings): restore scoped window feedback`
  - The settings webview mounts its own toast renderer so Open With actions display success and error feedback.
  - The settings window uses the main window as its parent instead of being globally always-on-top.

Verification:

- `pnpm.cmd lint` passed with the existing warnings.
- `pnpm.cmd check-types` passed after the final dependency refresh and Open With fixes.
- `pnpm.cmd test` passed: 59 files, 385 tests.
- `pnpm.cmd build` passed.
- `cargo clippy --all-targets --locked -- -D warnings` passed.
- The Open With command and icon tests, multi-file launch tests, and locked request-queue test passed.
- The settings eager-loading tests passed after adding the toast renderer.
- `cargo test --locked` completed with 224 tests passing. Its only failure is the pre-existing Windows symlink escape test, which requires Developer Mode or administrator symlink privileges.


## Skipped upstream changes

- `0baf265 chore(release): v0.8.5`
  - Downstream versioning is maintained independently.
- `a7506be nix: update sources to 0.8.5`
  - This fork does not maintain the upstream Nix release path.
- `d6e3491 feat: directional pane swap`
  - Not needed for the downstream terminal workflow.
- `460657a fix: terminal swap layout`
  - Depends on the skipped directional pane swap feature.
