import { describe, expect, it } from "vitest";
import {
  isRecoverableRemoteExit,
  REMOTE_TRANSPORT_CLOSED_EXIT_CODE,
} from "./exit";

describe("remote terminal exit classification", () => {
  it("keeps transport loss distinct from a normal bash exit", () => {
    expect(isRecoverableRemoteExit(REMOTE_TRANSPORT_CLOSED_EXIT_CODE)).toBe(
      true,
    );
    expect(isRecoverableRemoteExit(0)).toBe(false);
    expect(isRecoverableRemoteExit(143)).toBe(false);
  });
});
