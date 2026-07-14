import { describe, expect, it } from "vitest";
import {
  clampPanelWidth,
  PRIMARY_SIDEBAR_MAX_WIDTH,
  PRIMARY_SIDEBAR_MIN_WIDTH,
  SECONDARY_SIDEBAR_MAX_WIDTH,
  SECONDARY_SIDEBAR_MIN_WIDTH,
} from "./layout";

describe("clampPanelWidth", () => {
  it("clamps primary sidebar widths to the usable range", () => {
    expect(
      clampPanelWidth(
        120,
        PRIMARY_SIDEBAR_MIN_WIDTH,
        PRIMARY_SIDEBAR_MAX_WIDTH,
      ),
    ).toBe(PRIMARY_SIDEBAR_MIN_WIDTH);
    expect(
      clampPanelWidth(
        520,
        PRIMARY_SIDEBAR_MIN_WIDTH,
        PRIMARY_SIDEBAR_MAX_WIDTH,
      ),
    ).toBe(PRIMARY_SIDEBAR_MAX_WIDTH);
  });

  it("rounds and preserves secondary sidebar widths inside its range", () => {
    expect(
      clampPanelWidth(
        342.6,
        SECONDARY_SIDEBAR_MIN_WIDTH,
        SECONDARY_SIDEBAR_MAX_WIDTH,
      ),
    ).toBe(343);
  });

  it("keeps secondary sidebars wide enough for interactive content", () => {
    expect(
      clampPanelWidth(
        200,
        SECONDARY_SIDEBAR_MIN_WIDTH,
        SECONDARY_SIDEBAR_MAX_WIDTH,
      ),
    ).toBe(SECONDARY_SIDEBAR_MIN_WIDTH);
  });
});
