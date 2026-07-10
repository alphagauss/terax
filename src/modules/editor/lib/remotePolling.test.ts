import { describe, expect, it } from "vitest";
import { fileFingerprintChanged } from "./remotePolling";

describe("fileFingerprintChanged", () => {
  it("does not reload before the initial read establishes a baseline", () => {
    expect(fileFingerprintChanged(null, null, { mtime: 1, size: 10 })).toBe(
      false,
    );
  });

  it("uses stat mtime and size without reading unchanged content", () => {
    expect(fileFingerprintChanged(10, 20, { mtime: 10, size: 20 })).toBe(
      false,
    );
    expect(fileFingerprintChanged(10, 20, { mtime: 11, size: 20 })).toBe(
      true,
    );
    expect(fileFingerprintChanged(10, 20, { mtime: 10, size: 21 })).toBe(
      true,
    );
  });
});
