# Complex UI diagnosis and runtime debugging

Use this guide for frontend problems that are difficult to explain from source alone: a control is misplaced, a panel clips or overflows, a click reaches the wrong target, state appears stale, a component flashes or remounts, or a change works in one layout but not another.

The objective is not to find a CSS property to try. The objective is to turn a visual symptom into a small, testable statement about runtime state, identify the first layer where that statement becomes false, and fix that layer's contract.

## The diagnostic model

Treat a UI as five connected layers:

```text
input and events
        ↓
state and data
        ↓
component tree and lifecycle
        ↓
DOM, CSS, and layout geometry
        ↓
paint, compositing, and platform behavior
```

Start at the symptom, then move down this chain until the first incorrect fact appears. Do not jump directly to the last layer because the problem looks visual. A wrong state transition can look like a CSS bug, and a correct DOM can still be hidden by clipping, stacking, or compositing.

## Step 1: Define the failure precisely

Write a short reproduction contract before editing code:

```text
Given: [route, tab, theme, viewport, zoom, data]
When: [specific click, key, resize, navigation, or async completion]
Expected: [observable behavior]
Actual: [observable behavior]
Stable: [always, only after resize, only after reload, intermittent]
```

Capture the active route, window size, device scale or zoom, theme, sidebar and pane state, selected tab, focus target, and whether the app is a real Tauri WebView or a plain Vite page. If the app depends on Tauri IPC, a Vite fallback that stops before React mounts is not a valid reproduction.

Separate three questions:

1. Is the wrong element rendered?
2. Is the right element rendered with wrong geometry or style?
3. Is the right element correct but blocked by input, stacking, clipping, or platform behavior?

This prevents changing markup when the failure is only a hit-testing or state problem.

## Starting a Tauri runtime for debugging

Use the real Tauri process when the UI depends on `invoke()`, events, PTY state, filesystem state, or workspace bootstrap. Terax serves its Vite frontend at port `1420` and Tauri loads `http://localhost:1420` during development.

### Normal interactive development

Start this in a dedicated terminal and keep the process attached so its Rust and WebView errors remain visible:

```powershell
pnpm tauri dev
```

On Windows, PowerShell may resolve `pnpm` to a blocked `pnpm.ps1`. Use the command shim explicitly:

```powershell
pnpm.cmd tauri dev
```

Do not treat a plain `pnpm dev` page as equivalent. It is useful for CSS-only work, but Tauri IPC initialization may fail and leave an empty root node.

### WebView2 remote inspection on Windows

When direct inspection of the running WebView is required, set the WebView2 arguments before starting the Tauri process. Use a separate user-data directory so an already-running WebView2 browser process does not reuse a profile without the debug argument:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9223"
$env:WEBVIEW2_USER_DATA_FOLDER = "$env:TEMP\terax-webview-debug"
pnpm.cmd tauri dev
```

Keep this command in the foreground first. Background wrappers can hide startup errors, inherit a broken environment, or terminate the child process when the wrapper exits. Once the command is stable, a separate terminal or a carefully configured process supervisor can own it.

Verify the debugging endpoint from the same machine:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9223/json
```

The response should contain a page target with `webSocketDebuggerUrl`. A connection refusal means the Tauri process is not running, the debug argument was not applied, or the port is occupied. A target whose URL is not `http://localhost:1420/` is usually a different process or a stale target.

### Startup failure order

Check failures in this order:

1. Confirm that `pnpm.cmd tauri dev` stays alive long enough to print the Vite and Rust startup logs.
2. Check whether port `1420` is already in use. Reuse the existing development process only if it is the same source revision and runtime state.
3. Check whether another Terax window owns the workspace lock or single-instance state. Close the stale window or inspect the existing process instead of repeatedly launching copies.
4. If the WebView is blank, inspect the console for Tauri IPC errors before diagnosing React layout.
5. If port `9223` refuses connections, restart with a fresh `WEBVIEW2_USER_DATA_FOLDER` and confirm the environment variables are set in the process that starts Tauri.
6. If a background launch exits immediately, rerun it in the foreground. Do not infer a UI failure from a process that never completed startup.

The same principle applies on macOS and Linux: first establish a foreground `pnpm tauri dev` session, then use the platform WebView inspector or remote-debugging mechanism supported by that WebView. Do not assume WebView2 environment variables work outside Windows.

## Step 2: Classify the symptom

Use the symptom to choose the first runtime probe.

| Symptom | First probe | Typical causes |
| --- | --- | --- |
| Wrong position, size, gap, or overflow | `getBoundingClientRect`, `scrollWidth`, computed layout styles | flex shrink, intrinsic width, padding, border, transform, scrollbar track |
| Element visible but not clickable | `elementFromPoint`, `getComputedStyle`, pointer-events, stacking context | overlay, z-index context, invisible sibling, disabled state |
| Click or key reaches the wrong component | event path, focused element, listener ownership, propagation | bubbling, stale handler, portal, focus trap |
| Correct action but stale or missing UI | state snapshot, props, keys, effect timing, network or IPC result | stale closure, wrong key, conditional mount, race, failed command |
| Flash, remount, lost focus, or reset scroll | mount identity, React keys, visibility, layout shifts | parent type change, unstable key, conditional provider, Strict Mode |
| Works only after resize or theme change | before and after geometry and style snapshots | missing measurement, stale CSS variable, observer timing, hidden layout |
| Slow, janky, or delayed interaction | render count, long tasks, layout reads and writes, network or IPC timing | render loop, forced layout, large subtree, duplicate subscription |
| Screen reader or keyboard inconsistency | accessibility tree, role, name, focus order, tab index | visual-only control, hidden focus target, incorrect ARIA contract |

Classification is a starting point, not a conclusion. Confirm it with runtime evidence.

## Step 3: Build an evidence table

For each hypothesis, record one observation that would prove or disprove it:

| Hypothesis | Observable evidence | Result |
| --- | --- | --- |
| A descendant is wider than its container | descendant `scrollWidth > clientWidth` | confirmed or rejected |
| An overlay intercepts the click | `elementFromPoint(x, y)` differs from intended target | confirmed or rejected |
| A component remounted | mount/unmount log or changed DOM identity | confirmed or rejected |
| State is stale | rendered value differs from store/prop snapshot | confirmed or rejected |
| A platform scrollbar changes geometry | computed scrollbar and client dimensions differ by a stable delta | confirmed or rejected |

Prefer one bounded inspection that answers several related questions over many speculative selector changes. Keep raw measurements with the reproduction so the fix can be checked against the same state.

## Step 4: Inspect runtime DOM and geometry

Use the real page runtime. For Tauri, connect to the WebView's developer tools when possible. For ordinary browser pages, use the browser inspector or its runtime evaluation. Read the DOM in bounded queries and include an element path so the result can be mapped back to source.

```js
const describe = (element) => {
  const path = [];
  for (let node = element; node && path.length < 7; node = node.parentElement) {
    let part = node.tagName.toLowerCase();
    if (node.id) part += `#${node.id}`;
    if (node.classList.length) {
      part += `.${Array.from(node.classList).slice(0, 4).join(".")}`;
    }
    path.unshift(part);
  }

  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return {
    path: path.join(" > "),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
    scroll: {
      width: element.scrollWidth,
      clientWidth: element.clientWidth,
      height: element.scrollHeight,
      clientHeight: element.clientHeight,
    },
    layout: {
      display: style.display,
      position: style.position,
      boxSizing: style.boxSizing,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      width: style.width,
      height: style.height,
      minWidth: style.minWidth,
      minHeight: style.minHeight,
      transform: style.transform,
      visibility: style.visibility,
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
      zIndex: style.zIndex,
    },
  };
};

Array.from(document.querySelectorAll("*"))
  .filter((element) => element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight)
  .slice(0, 100)
  .map(describe);
```

For a geometry problem, inspect the first incorrect descendant and every ancestor with `overflow`, flex or grid sizing, transforms, or positioning. A one or two pixel delta is evidence, not harmless noise. It often identifies a border, scrollbar track, fractional transform, or child that ignores the parent box.

For hit testing, inspect the actual point rather than guessing from the DOM order:

```js
const rect = target.getBoundingClientRect();
const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
({ target, hit, path: hit && describe(hit) });
```

For a missing or stale view, compare the rendered DOM with the component's current props, store snapshot, URL, and IPC or network result. The first disagreement identifies the layer to investigate.

## Step 5: Inspect styles and ownership

Computed style tells you what won. Inline style tells you what a component or library requested. Source CSS tells you what could win under a different state. Inspect all three.

Pay special attention to:

- `!important` rules and selectors outside CSS layers.
- Parent padding and borders combined with `box-sizing`.
- Flex and grid children missing `min-width: 0` or `min-height: 0`.
- Absolute children positioned against an unexpected containing block.
- `transform`, zoom wrappers, and fractional pixel rounding.
- Hidden mounted panes that still participate in measurement or observers.
- Portals and overlay layers that create a different stacking or event context.
- Third-party inline dimensions that are only partially overridden.

For a two-dimensional widget, compare the parent track and child thumb or slider on both axes. A generic rule that sets both width and height on vertical and horizontal elements is a common source of persistent small overflow.

## Step 6: Trace interaction and lifecycle

When the geometry is correct but behavior is wrong, inspect the event and lifecycle path:

```js
({ active: document.activeElement, target: event.target, current: event.currentTarget, path: event.composedPath() });
```

For React behavior, temporarily log mount, unmount, key, and the relevant state transition at the narrowest component boundary. Look for:

- An unstable or index key that changes component identity.
- A parent element type that changes when async data arrives.
- An effect that subscribes twice or closes over stale state.
- A portal or overlay that captures focus or pointer events.
- A hidden component that remains mounted and continues measuring or listening.
- A resize or observer callback that writes layout and immediately triggers itself again.

Remove temporary logging after the cause is established. The final fix should make the lifecycle contract explicit rather than retain debug side effects.

## Step 7: Change the contract, not the symptom

Choose the smallest layer that owns the failure:

1. Correct data, state transition, or IPC result when the rendered value is wrong.
2. Correct component identity or lifecycle when state resets, flashes, or loses focus.
3. Correct DOM structure when ownership, semantics, or event boundaries are wrong.
4. Correct component-level layout when geometry is wrong.
5. Correct shared CSS only when the rule is truly a shared contract.
6. Use clipping or scrollbar hiding only when clipping or hidden scrolling is the intended behavior.

Avoid broad global selectors, arbitrary pixel offsets, duplicate wrappers, and `overflow: hidden` patches that conceal a child geometry error. If a third-party library owns inline styles, override only the axis or state that is part of Terax's contract and keep parent and child dimensions consistent.

## Step 8: Verify the invariant

Reproduce the original contract after HMR or reload and check the same measurements. Then test the nearby state transitions that can invalidate the fix:

- resize and pane drag
- theme and zoom changes
- tab switch and hidden pane activation
- focus, keyboard navigation, selection, and pointer interaction
- loading, empty, error, and long-content states
- repeated mount and unmount
- platform-specific WebView behavior

A screenshot confirms appearance, but measurements and interaction checks confirm behavior. For overflow, verify both the inner element and the ancestor scroll container. For hit testing, verify `elementFromPoint` and keyboard focus. For state bugs, verify the rendered value after the async transition that originally exposed the issue.

## Common traps

- Checking only `document.documentElement.scrollWidth`; nested scroll containers are independent.
- Inspecting a Vite fallback instead of the Tauri WebView when IPC controls mounting.
- Treating a tiny geometry delta as rounding noise.
- Changing CSS before proving that the correct component and state are rendered.
- Using a screenshot as proof that an element is clickable or that no hidden overflow exists.
- Validating only the active pane when hidden tabs remain mounted in Terax.
- Fixing an event symptom with `stopPropagation` before identifying the competing target.
- Adding a memo, effect dependency, or timeout without measuring the render or lifecycle behavior it is meant to change.

## Completion checklist

- [ ] The exact runtime state and reproduction contract are recorded.
- [ ] The symptom is classified and at least one competing hypothesis was rejected with evidence.
- [ ] The first incorrect layer is identified: input, state, lifecycle, DOM/CSS, layout, or platform paint.
- [ ] Runtime geometry, computed style, hit testing, or state snapshots support the diagnosis.
- [ ] The fix changes the owning contract and does not merely hide the symptom.
- [ ] Resize, focus, keyboard, hidden panes, async transitions, and relevant platform states were checked.
- [ ] `pnpm lint`, `pnpm check-types`, and `pnpm test` were run as appropriate.
