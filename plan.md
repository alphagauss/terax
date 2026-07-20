# SSH Profiles and tunnel management redesign

## Goal

Replace the overloaded Remote SSH dialog with three clear surfaces:

1. **Settings > Remote** manages persistent SSH profiles and credentials.
2. **Workspace environment selector** chooses or reconnects an SSH workspace.
3. **Tunnel manager** controls runtime tunnels from the status bar, but only in the SSH environment's primary window.

The Remote tab is inserted after Agents and before About. The design must remain compact, translated, and usable in the 900 by 700 Settings window.

## Ownership model

- A tunnel belongs to the primary `single` Workspace process for one SSH environment, not to every window using that profile.
- Extra windows cannot create, edit, stop, or list the primary window's tunnels. Their status-bar control explains that the primary window owns tunnel management.
- Rust enforces ownership for every tunnel command. Hiding controls in React is not an authorization boundary.
- Tunnels remain runtime state. They stop when the primary process exits and are restored only across reconnects in that process. Saved tunnel templates and auto-start are out of scope.

## UI design

### Remote settings

- Add a full-width Remote section with a profile list and a detail editor.
- Keep profile name, host, port, user, authentication, and credential storage in the basic form.
- Put remote root, proxy, keepalive, and reconnect behavior in an Advanced section.
- Include Import, New, Save, Delete, and a direct action to open an SSH workspace.
- Keep tunnel controls out of Settings.

### Status bar tunnel manager

- Add a tunnel count/status control immediately left of the AI status pill.
- In the primary SSH window it opens a dedicated tunnel manager dialog, not a small dropdown.
- The dialog lists name, direction, bind endpoint, target endpoint, status, traffic, and actions.
- New and edit share one compact form. Dynamic tunnels hide target fields.
- Editing an active tunnel is labelled "Apply and restart": validate first, stop the old listener, start the replacement, and restore the old configuration when replacement startup fails.
- Extra SSH windows show a disabled owner hint. Local and WSL windows do not show the control.

## Backend design

- Expose primary-window identity in the Workspace bootstrap state.
- Add one central ownership check for tunnel commands: primary Workspace, SSH environment, and matching profile id are all required.
- Add tunnel lifecycle events for started, updated, failed, and stopped states. Do not emit per-byte events.
- Add an update command with restart and rollback semantics.
- Keep byte counters inexpensive: refresh them only while the manager is visible.

## Reproduction contract

Given: a 900 by 700 Settings window and an SSH profile with password, key, and advanced options.

When: opening Settings > Remote, selecting profiles, editing values, and resizing within the supported minimum window size.

Expected: the profile editor remains readable, scrolls only within its intended regions, and all primary actions remain visible.

Given: one primary SSH Workspace and one extra Workspace for the same SSH environment.

When: creating, updating, stopping, reconnecting, and closing tunnels.

Expected: only the primary window can mutate tunnels; the extra window cannot bypass that rule; lifecycle changes are reflected immediately; a failed update restores the previous tunnel when possible.

## Verification

- Add focused TypeScript and Rust tests for primary ownership, update rollback, and tunnel payload validation.
- Run `pnpm lint`, `pnpm check-types`, `pnpm test`, Rust formatting and targeted tunnel/workspace tests, then the full required Rust checks when feasible.
- Start the real Tauri application with WebView debugging, measure the old and new affected layouts, and verify the primary and extra-window tunnel flows in the actual WebView.
