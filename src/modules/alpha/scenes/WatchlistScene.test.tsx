// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  search: vi.fn(async ({ offset }: { offset: number }) => ({
    items: [{ vt_symbol: `${offset}.SSE`, name: `证券 ${offset}` }],
    total: 31,
  })),
}));
vi.mock("@/modules/alpha/api", () => ({
  getAlphaSecurities: mocks.search,
  getAlphaWatchlist: async () => [],
  setAlphaWatchlistSymbol: vi.fn(),
}));
vi.mock("@/modules/alpha/query", () => ({
  alphaQueryKeys: { securities: ["alpha", "securities"] },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
import { WatchlistScene } from "@/modules/alpha/scenes/WatchlistScene";

it("搜索能访问首批之后的证券，重新搜索会回到第一页", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <WatchlistScene visible symbol="000001.SZSE" onSelect={() => {}} />
        </QueryClientProvider>,
      ),
    );
    await settle();
    const input = container.querySelector("input");
    const form = container.querySelector("form");
    if (!input || !form) throw new Error("missing search form");
    const search = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      });
      await settle();
    };
    await search("银行");
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "desk.next")
        ?.click();
    });
    await settle();
    expect(mocks.search).toHaveBeenLastCalledWith({
      q: "银行",
      limit: 30,
      offset: 30,
    });
    expect(container.textContent).toContain("证券 30");
    expect(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "desk.next",
      )?.disabled,
    ).toBe(true);
    await search("证券");
    expect(mocks.search).toHaveBeenLastCalledWith({
      q: "证券",
      limit: 30,
      offset: 0,
    });
  } finally {
    act(() => root.unmount());
    client.clear();
  }
});
