// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ViewStateScope } from "@/modules/view-state";
import { resetViewCachesForTests } from "@/modules/view-state/cache";
import {
  searchContent,
  cancelContentSearch,
  type ContentSearchResponse,
} from "./api";
import { WorkspaceSearchPanel } from "./WorkspaceSearchPanel";

vi.mock("./api", () => ({
  searchContent: vi.fn(),
  cancelContentSearch: vi.fn(async () => {}),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/modules/explorer/lib/iconResolver", () => ({
  fileIconUrl: () => "",
}));

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  resetViewCachesForTests();
  vi.mocked(searchContent)
    .mockReset()
    .mockResolvedValue({
      hits: [
        {
          path: "/repo/a.ts",
          rel: "a.ts",
          line: 1,
          text: "needle",
          ranges: [],
        },
      ],
      truncated: false,
      filesScanned: 1,
    });
  vi.mocked(cancelContentSearch).mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const render = async (space = "a", visible = true) =>
  act(async () =>
    root.render(
      <ViewStateScope
        kind="sidebar"
        scope={space}
        view="search"
        visible={visible}
      >
        <WorkspaceSearchPanel
          rootPath="/repo"
          visible={visible}
          onOpenHit={() => {}}
        />
      </ViewStateScope>,
    ),
  );
async function query(value: string) {
  const input = container.querySelector("input");
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  if (!input || !setter) throw new Error("缺少查询输入框");
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => vi.advanceTimersByTimeAsync(250));
}

it("切换 Space 和侧栏恢复查询、结果与折叠状态，只有重新查询才读取", async () => {
  await render();
  await query("needle");
  const group = container.querySelector<HTMLButtonElement>(
    '[data-view-row="a.ts"]',
  );
  if (!group) throw new Error("缺少结果分组");
  await act(async () => group.click());
  await render("b");
  expect(container.querySelector("input")?.value).toBe("");
  await render("a", false);
  await render();
  expect(container.querySelector("input")?.value).toBe("needle");
  expect(
    container
      .querySelector('[data-view-row="a.ts"]')
      ?.getAttribute("aria-expanded"),
  ).toBe("false");
  expect(searchContent).toHaveBeenCalledTimes(1);
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="refresh"]')
      ?.click(),
  );
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(searchContent).toHaveBeenCalledTimes(2);
});

it("切走取消进行中的查询，迟到结果不能覆盖其他 Space，也不在切回时重放", async () => {
  let finish!: (value: ContentSearchResponse) => void;
  vi.mocked(searchContent).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  await query("pending");
  await render("b");
  expect(cancelContentSearch).toHaveBeenCalledWith("/repo");
  await act(async () =>
    finish({ hits: [], truncated: false, filesScanned: 1 }),
  );
  expect(container.querySelector("input")?.value).toBe("");
  await render();
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(container.querySelector("input")?.value).toBe("pending");
  expect(searchContent).toHaveBeenCalledTimes(1);
});
