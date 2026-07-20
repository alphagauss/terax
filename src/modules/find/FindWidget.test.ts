import { describe, expect, it } from "vitest";
import { isFindKeyboardEventComposing } from "./FindWidget";

describe("FindWidget keyboard handling", () => {
  it("leaves active IME composition keys to the input method", () => {
    expect(
      isFindKeyboardEventComposing({ isComposing: true, keyCode: 13 }),
    ).toBe(true);
    expect(
      isFindKeyboardEventComposing({ isComposing: false, keyCode: 229 }),
    ).toBe(true);
    expect(
      isFindKeyboardEventComposing({ isComposing: false, keyCode: 13 }),
    ).toBe(false);
  });
});
