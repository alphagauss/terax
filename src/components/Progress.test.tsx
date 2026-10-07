// @vitest-environment happy-dom
import { Progress } from "@/components/ui/progress";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";

it("进度条的可访问性数值和状态与可见进度一致，未知总量不伪装为零进度", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<Progress value={20} aria-label="进度" />),
    );
    const progress = container.querySelector('[role="progressbar"]');
    expect(progress?.getAttribute("data-state")).toBe("loading");
    expect(progress?.getAttribute("aria-valuenow")).toBe("20");
    expect(progress?.getAttribute("aria-valuetext")).toBe("20%");

    await act(async () =>
      root.render(<Progress value={null} aria-label="进度" />),
    );
    expect(progress?.getAttribute("data-state")).toBe("indeterminate");
    expect(progress?.hasAttribute("aria-valuenow")).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});
