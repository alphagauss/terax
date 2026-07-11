import { describe, expect, it } from "vitest";
import {
  canChangeSession,
  shouldPublishSnapshot,
} from "./sessionLifecycle";

describe("AI session snapshot lifecycle", () => {
  it.each(["submitted", "streaming"] as const)(
    "does not publish while %s",
    (status) => {
      expect(shouldPublishSnapshot(status, 0, true)).toBe(false);
    },
  );

  it("keeps the run lock while an approval is pending", () => {
    expect(shouldPublishSnapshot("ready", 1, true)).toBe(false);
  });

  it.each(["ready", "error"] as const)(
    "publishes a completed dirty run in %s",
    (status) => {
      expect(shouldPublishSnapshot(status, 0, true)).toBe(true);
    },
  );

  it("does not publish an untouched hydrated session", () => {
    expect(shouldPublishSnapshot("ready", 0, false)).toBe(false);
  });

  it("blocks session changes while the active run lock is held", () => {
    expect(canChangeSession(true)).toBe(false);
    expect(canChangeSession(false)).toBe(true);
  });
});
