import { requestAlpha } from "@/modules/alpha/native";
import {
  changeWatchlist,
  getWatchlistQuotes,
} from "@/modules/alpha/watchlist/api";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@/modules/alpha/native", () => ({ requestAlpha: vi.fn() }));
const request = vi.mocked(requestAlpha);
beforeEach(() => request.mockReset());
it("重排发送相邻证券命令，行情分组通过原生代理 query 参数传递", async () => {
  request.mockResolvedValue({
    status: 200,
    headers: {},
    body: { groups: [], items: [] },
  });
  const command = {
    action: "reorder",
    group_id: "all",
    symbols: ["A.SSE"],
    anchor: "B.SSE",
    side: "before",
  } as const;
  await changeWatchlist({ ...command, symbols: [...command.symbols] });
  expect(request).toHaveBeenLastCalledWith({
    method: "POST",
    path: "/api/alpha/watchlist/commands",
    body: command,
  });
  request.mockResolvedValue({ status: 200, headers: {}, body: [] });
  await getWatchlistQuotes("group-1");
  expect(request).toHaveBeenLastCalledWith({
    method: "GET",
    path: "/api/alpha/watchlist/quotes",
    query: [{ name: "group_id", value: "group-1" }],
  });
  request.mockResolvedValue({
    status: 409,
    headers: {},
    body: { detail: "anchor_missing" },
  });
  await expect(
    changeWatchlist({ ...command, symbols: [...command.symbols] }),
  ).rejects.toThrow("anchor_missing");
});
