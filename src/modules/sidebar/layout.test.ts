import { describe, expect, it } from "vitest";
import {
  clampPanelWidth,
  PRIMARY_SIDEBAR_MIN_WIDTH,
  SECONDARY_SIDEBAR_MIN_WIDTH,
} from "./layout";

describe("clampPanelWidth", () => {
  it("keeps primary sidebars above their minimum width", () => {
    expect(clampPanelWidth(120, PRIMARY_SIDEBAR_MIN_WIDTH)).toBe(
      PRIMARY_SIDEBAR_MIN_WIDTH,
    );
  });

  it("rounds and preserves wide secondary sidebars", () => {
    expect(clampPanelWidth(742.6, SECONDARY_SIDEBAR_MIN_WIDTH)).toBe(743);
  });

  it("keeps secondary sidebars wide enough for interactive content", () => {
    expect(clampPanelWidth(200, SECONDARY_SIDEBAR_MIN_WIDTH)).toBe(
      SECONDARY_SIDEBAR_MIN_WIDTH,
    );
  });
});
