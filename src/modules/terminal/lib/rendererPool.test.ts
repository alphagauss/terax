import { visibleBindingsRequireAnotherSlot } from "@/modules/terminal/lib/rendererPool";
import { describe, expect, it } from "vitest";

describe("renderer pool visibility policy", () => {
  it("grows when every existing renderer belongs to a visible terminal", () => {
    expect(
      visibleBindingsRequireAnotherSlot([
        { bound: true, visible: true },
        { bound: true, visible: true },
      ]),
    ).toBe(true);
  });

  it("reuses a slot when a hidden or unbound renderer exists", () => {
    expect(
      visibleBindingsRequireAnotherSlot([
        { bound: true, visible: true },
        { bound: true, visible: false },
      ]),
    ).toBe(false);
    expect(
      visibleBindingsRequireAnotherSlot([
        { bound: true, visible: true },
        { bound: false, visible: false },
      ]),
    ).toBe(false);
  });
});
