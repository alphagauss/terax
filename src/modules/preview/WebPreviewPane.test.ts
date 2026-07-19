import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  scheduleWebPreviewSuspension,
  WEB_PREVIEW_SUSPEND_AFTER_MS,
} from "./WebPreviewPane";

/**
 * Source-level regression test for the preview iframe's security attributes.
 * Rendering this component for real requires jsdom + a working
 * useImperativeHandle stub; for a focused security check we just verify the
 * static JSX still carries the sandbox/referrerPolicy attributes — if a
 * future change silently removes them, this test fails.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "WebPreviewPane.tsx"), "utf8");
const iframeMatch = src.match(/<iframe[\s\S]*?\/>/);
// Strip JSX comments (`// …` inside `{…}` and `{/* … */}` blocks) so the
// assertions only see actual attribute syntax — the source explains in a
// comment why `allow-top-navigation` is intentionally omitted, which we
// don't want to match.
const iframeJsx = (iframeMatch?.[0] ?? "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");

describe("WebPreviewPane", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps a hidden iframe alive for five minutes", () => {
    expect(src).toMatch(
      /WEB_PREVIEW_SUSPEND_AFTER_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/,
    );
  });

  it("suspends only after the full five-minute grace period", () => {
    vi.useFakeTimers();
    const suspend = vi.fn();
    scheduleWebPreviewSuspension(suspend);

    vi.advanceTimersByTime(WEB_PREVIEW_SUSPEND_AFTER_MS - 1);
    expect(suspend).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(suspend).toHaveBeenCalledOnce();
  });

  it("cancels suspension when the preview becomes visible again", () => {
    vi.useFakeTimers();
    const suspend = vi.fn();
    const cancel = scheduleWebPreviewSuspension(suspend);

    cancel();
    vi.advanceTimersByTime(WEB_PREVIEW_SUSPEND_AFTER_MS);
    expect(suspend).not.toHaveBeenCalled();
  });

  it("declares an iframe in the source", () => {
    expect(iframeJsx).not.toBe("");
  });

  it("includes a sandbox attribute", () => {
    expect(iframeJsx).toMatch(/sandbox="[^"]*"/);
  });

  it("grants allow-scripts and allow-same-origin", () => {
    // These two are what makes a dev preview useful — strip either and dev
    // servers stop working.
    expect(iframeJsx).toMatch(/sandbox="[^"]*allow-scripts/);
    expect(iframeJsx).toMatch(/sandbox="[^"]*allow-same-origin/);
  });

  it("does NOT include allow-top-navigation* tokens", () => {
    // The whole point of sandboxing here: forbid the iframe from navigating
    // the parent Tauri webview to an attacker origin (which would expose
    // window.__TAURI__). Top-nav permissions must never be added.
    expect(iframeJsx).not.toMatch(/allow-top-navigation/);
  });

  it("does NOT include allow-popups-without-allow-popups-to-escape-sandbox combo", () => {
    // If popups are allowed, they MUST escape the sandbox cleanly — otherwise
    // a popup window inherits sandbox flags and we get hard-to-debug behavior.
    if (/allow-popups\b/.test(iframeJsx)) {
      expect(iframeJsx).toMatch(/allow-popups-to-escape-sandbox/);
    }
  });

  it("sets referrerPolicy to no-referrer", () => {
    expect(iframeJsx).toMatch(/referrerPolicy="no-referrer"/);
  });
});
