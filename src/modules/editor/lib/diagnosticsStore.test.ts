import { beforeEach, describe, expect, it } from "vitest";
import { useDiagnosticsStore } from "./diagnosticsStore";

describe("diagnostics ownership", () => {
  beforeEach(() => {
    useDiagnosticsStore.setState({ byPath: {}, ownerByPath: {} });
  });

  it("ignores reports and cleanup from a non-owner view", () => {
    const store = useDiagnosticsStore.getState();
    store.claim("file.ts", "focused");
    store.report("file.ts", "focused", { errors: 1, warnings: 2 });
    store.report("file.ts", "background", { errors: 0, warnings: 0 });
    store.clear("file.ts", "background");

    expect(useDiagnosticsStore.getState().byPath["file.ts"]).toEqual({
      errors: 1,
      warnings: 2,
    });
  });

  it("transfers ownership without letting the previous view clear it", () => {
    const store = useDiagnosticsStore.getState();
    store.claim("file.ts", "first");
    store.report("file.ts", "first", { errors: 1, warnings: 0 });
    store.claim("file.ts", "second");
    store.clear("file.ts", "first");
    store.report("file.ts", "second", { errors: 0, warnings: 1 });

    expect(useDiagnosticsStore.getState().byPath["file.ts"]).toEqual({
      errors: 0,
      warnings: 1,
    });
  });
});
