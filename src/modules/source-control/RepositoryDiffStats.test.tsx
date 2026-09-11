// @vitest-environment happy-dom

import { TooltipProvider } from "@/components/controls/tooltip";
import i18n, { preloadEn } from "@/i18n";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { RepositoryDiffStats } from "./RepositoryDiffStats";

it("animates scope changes and refreshed counts while preserving scope until the repository changes", async () => {
  await preloadEn();
  await i18n.changeLanguage("en");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (added: number, repo = "first") =>
    act(async () =>
      root.render(
        <TooltipProvider>
          <RepositoryDiffStats
            key={repo}
            stats={{
              worktree: { added: 10, removed: 2, incomplete: false },
              index: { added, removed: 1, incomplete: false },
            }}
          />
        </TooltipProvider>,
      ),
    );
  try {
    await render(3);
    expect(container.querySelector("button")?.textContent).toBe("Modified");
    expect(container.querySelector(".file-edit-number-motion")).toBeNull();
    await act(async () => container.querySelector("button")?.click());
    expect(container.querySelector("button")?.textContent).toBe("Staged");
    expect(container.querySelectorAll(".file-edit-number-motion")).toHaveLength(
      2,
    );
    await render(7);
    expect(container.querySelector("button")?.textContent).toBe("Staged");
    expect(container.querySelector(".file-edit-number-new")?.textContent).toBe(
      "+7",
    );
    expect(container.querySelector(".file-edit-number-old")?.textContent).toBe(
      "+3",
    );
    await render(12000);
    expect(container.querySelector(".file-edit-number-new")?.textContent).toBe(
      "+9999",
    );
    await render(1);
    expect(container.querySelector(".file-edit-number-old")?.textContent).toBe(
      "+9999",
    );
    expect(container.querySelector(".file-edit-number-new")?.textContent).toBe(
      "+1",
    );
    await render(7, "second");
    expect(container.querySelector("button")?.textContent).toBe("Modified");
    expect(container.querySelector(".file-edit-number-motion")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
