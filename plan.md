# Workspace window mode

## Goal

Keep one persistent `single` workspace state per environment. Default to one
window per environment, and allow users to opt into multiple windows.

## Behavior

- Environment identity: Local; WSL distro; SSH host, port, and username.
- Single-window mode (default): open the environment's `single` state. If it
  is already locked, request that the owning window show and focus itself.
- Multi-window mode: first use the environment's `single` state. If it is
  locked, create a UUID state for the additional window.
- At every startup, delete every unlocked UUID workspace state, its lock, and
  its UUID-specific window-state file. Never delete a `single` state.
- A new window without saved geometry inherits the launching window's size and
  opens 32 physical pixels down and right. Saved geometry continues to win.
- Changing modes affects subsequent opens only. Existing windows are never
  closed. Existing multi-window instances finish naturally when switching
  back to single-window mode.

## Activation message

An occupied single-window lock writes a transient `workspaceActivation` value
to the shared settings store. It includes an environment key and request ID.
Each window processes each request ID once; the matching window calls show and
focus.

## UI

General settings exposes `Single window per environment` and `Multiple
windows per environment`, defaulting to single-window mode. Command Palette
hides `New Window` while single-window mode is selected.

## Verification

- Rust tests cover state names, cleanup, single/multi selection, lock reuse,
  and activation requests.
- Frontend tests cover preference decoding and Command Palette visibility.
- Run frontend lint, type checks, and tests; run Rust clippy and tests.
