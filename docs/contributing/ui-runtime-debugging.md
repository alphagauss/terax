# Complex UI diagnosis and runtime debugging

This guide is primarily for Codex and other agents operating in restricted execution environments. Its commands and recovery steps account for filesystem sandboxes, GUI-launch approval, detached child processes, and browser-control capability boundaries.

Use this guide for frontend problems that are difficult to explain from source alone: a control is misplaced, a panel clips or overflows, a click reaches the wrong target, state appears stale, a component flashes or remounts, or a change works in one layout but not another.

The objective is not to find a CSS property to try. The objective is to turn a visual symptom into a small, testable statement about runtime state, identify the first layer where that statement becomes false, and fix that layer's contract.

Before editing, record a short reproduction contract:

```text
Given: [route, tab, theme, viewport, zoom, data]
When: [specific click, key, resize, navigation, or async completion]
Expected: [observable behavior]
Actual: [observable behavior]
Stable: [always, only after resize, only after reload, intermittent]
```

Include only state relevant to the issue, such as viewport, theme, active tab, pane visibility, focus, and whether the runtime is the real Tauri WebView. A plain Vite page is not a valid reproduction when startup depends on Tauri IPC.

## Starting a Tauri runtime for debugging

Use the real Tauri process when the UI depends on `invoke()`, events, PTY state, filesystem state, or workspace bootstrap. A plain frontend dev server is not equivalent because Tauri IPC may fail before the application mounts.

### Shortest reliable Codex procedure on Windows

This procedure is written for Codex and other restricted execution environments. Follow these steps in order. Do not add a background launcher, a second Vite process, or a process supervisor until this path works.

1. Read `src-tauri/tauri.conf.json`. Note `build.beforeDevCommand` and `build.devUrl`. The Tauri CLI runs `beforeDevCommand` itself, so do not start that frontend command separately. Terax uses `pnpm dev` and `http://localhost:1420`.
2. Close older development instances of this application. An existing WebView2 process can reuse its browser profile without the new debugging argument, and a project can also enforce a workspace lock or single-instance policy.
3. Request permission to run the Tauri development command outside the sandbox. A Tauri development command is a GUI launch, even when started through a shell tool. The execution environment must permit `terax.exe` to create WebView2 child processes.
4. In the approved execution context, run the following commands as one foreground shell command from the project root:

   ```powershell
   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9223"
   $env:WEBVIEW2_USER_DATA_FOLDER = "$env:TEMP\tauri-webview-debug"
   pnpm.cmd tauri dev
   ```

   Use `pnpm.cmd` on Windows because PowerShell can resolve `pnpm` to a blocked `pnpm.ps1`. For npm, Yarn, Bun, or Cargo-only projects, replace only the final launch command.
5. Keep the foreground command running. From a separate shell call, verify the WebView2 target:

   ```powershell
   Invoke-RestMethod http://127.0.0.1:9223/json |
     Select-Object title, url, webSocketDebuggerUrl
   ```

Start DOM or CSS inspection only after this returns the application page and a `webSocketDebuggerUrl`. Connect a compatible DevTools or CDP client to that exact target. The expected Terax target URL is `http://localhost:1420/`.

The success condition is simple:

```text
tauri dev remains running
        +
the native window renders the expected project
        +
http://127.0.0.1:9223/json returns its WebView target
```

### Restricted-environment failure signature

Setting the WebView2 environment variables correctly is not enough when the parent process remains sandboxed. Codex can observe a partially successful launch that looks like an application or CDP configuration bug.

The misleading failure observed in a restricted environment was:

```text
Vite listens on 127.0.0.1:1420
        +
terax.exe remains alive
        +
the temporary EBWebView directory is created
        +
no WebView2 child remains alive
        +
the Crashpad directory contains a new report
        +
127.0.0.1:9223 refuses connections
```

Do not interpret this state as a Vite host problem, a missing Tauri IPC shim, or proof that the remote-debugging argument is unsupported. Relaunch the same foreground command with GUI permission before changing project configuration. A successful launch produces a live `msedgewebview2.exe` process whose command line uses the requested user-data directory, and `/json` returns the application target.

When diagnosing process inheritance, inspect only processes created by the current launch. On Windows, confirm the parent chain and WebView2 arguments with `Get-CimInstance Win32_Process` when permitted. Do not kill every `msedgewebview2.exe`: Windows Search, Microsoft 365, Codex, and other applications may own unrelated instances.

### Connecting a debugging client

The `/json` response is the handoff between application startup and browser inspection. Select the entry whose `type` is `page` and whose `url` matches `build.devUrl`, then connect a compatible CDP client to that entry's exact `webSocketDebuggerUrl`.

Do not assume that a browser automation skill automatically discovers an arbitrary WebView2 CDP port. Codex's in-app Browser can be available while its browser list contains only the in-app browser and omits the WebView2 target. In that case, the Tauri debugging setup is still healthy if `/json` returns the correct target. Use a CDP-capable client that can attach to the returned WebSocket URL. Do not open `http://localhost:1420` as a substitute because that creates a separate browser page without Tauri IPC.

For a minimal runtime verification, confirm all of the following through CDP before diagnosing UI behavior:

- `location.href` equals the expected `build.devUrl`.
- `document.querySelector("#root")` has mounted children.
- `window.__TAURI_INTERNALS__` exists.
- The document title or visible workspace state matches the native Terax window.
- Console errors do not show a workspace bootstrap or Tauri IPC failure.

### Stopping the debug session

Keep track of the `cargo` and `terax.exe` process IDs created by the current foreground launch. Stop the foreground command normally when possible. If an agent-side command wrapper is terminated but its children remain alive, stop only those recorded process IDs, using the same elevated execution context that launched them. Verify that ports `1420` and `9223` no longer have listeners owned by the debug session.

Do not clean up by process name. Unrelated Cargo builds, installed Terax instances, or WebView2 hosts may be running at the same time.

### If the five steps fail

Use the foreground output as the source of truth and fix only the first failing layer:

1. If `pnpm.cmd tauri dev` exits, read that terminal's first error. Do not retry through `Start-Process`, `cmd /c`, or another background wrapper.
2. If the frontend port is occupied, identify the existing listener. Reuse it only when it belongs to the same checkout and revision; otherwise close that stale development process, then run the five steps again.
3. If the native window opens but `/json` refuses the connection, confirm the two WebView2 environment variables were set in the same PowerShell before `tauri dev`. When an agent launched the command, also confirm that the execution environment permits GUI and WebView2 child processes. Close the app and retry once with a fresh temporary user-data folder name.
4. If `/json` returns the wrong target, another WebView owns the port or profile. Close it or choose another debug port, then restart once.
5. If the native page is blank but `/json` works, inspect its console for Tauri IPC or bootstrap errors. Do not diagnose layout until the application root has mounted.

Do not run `pnpm dev` and `pnpm tauri dev` together unless the Tauri configuration explicitly lacks `beforeDevCommand`. Do not kill processes by name. Confirm the owning port and project first.

On macOS and Linux, keep the same sequence: read `tauri.conf.json`, run one foreground `tauri dev`, verify the native page, then attach the inspector supported by that platform WebView. The WebView2 environment variables above are Windows-only.

## Runtime inspection

After the real WebView is attached, use the smallest probe that can confirm the suspected failure:

| Symptom | Runtime evidence |
| --- | --- |
| Wrong size or overflow | Element and ancestor rectangles, client size, scroll size, computed overflow and sizing styles |
| Visible but not clickable | `elementFromPoint`, pointer events, stacking context, active overlays |
| Stale or missing UI | Rendered DOM compared with current state, props, IPC result, and active route |
| Remount, lost focus, or reset scroll | DOM identity, React key, mount lifecycle, and `document.activeElement` |
| Resize-only failure | Measurements before and after resize, pane activation, theme, or zoom change |

Keep reads bounded to the affected element and its ownership chain. Record the measurements that prove or reject the hypothesis, then repeat the same probe after the change. A screenshot verifies appearance, not hit testing, overflow, focus, or state correctness.

## Completion

- Reproduce the original state in the real Tauri WebView.
- Identify the first incorrect layer before editing.
- Verify the fix with the same runtime evidence.
- Check only nearby transitions relevant to the bug, such as resize, hidden pane activation, focus, or async completion.
- Remove temporary logging and stop the recorded debug processes.
- Run the checks appropriate to the changed code: `pnpm lint`, `pnpm check-types`, `pnpm test`, and relevant Rust checks.
