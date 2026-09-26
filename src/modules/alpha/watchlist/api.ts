/** 自选命令与行情摘要协议；业务状态来自 Python，临时排序不写入此接口。 */
import { requestAlpha } from "@/modules/alpha/native";
import { z } from "zod";

const itemSchema = z.object({
  group_id: z.string(),
  vt_symbol: z.string(),
  name: z.string(),
  position: z.number(),
  pinned: z.boolean(),
  pin_position: z.number(),
  price_tick: z.number().nullable(),
});
const watchlistSchema = z.object({
  groups: z.array(z.object({ id: z.string(), name: z.string() })),
  items: z.array(itemSchema),
});
const quoteSchema = z.object({
  vt_symbol: z.string(),
  close: z.number().nullable(),
  change: z.number().nullable(),
  date: z.string().nullable(),
  closes: z.array(z.number().nullable()),
  price_tick: z.number().nullable(),
  price_color_convention: z.enum(["up-red", "up-green"]),
  status: z.enum(["daily", "missing", "error"]),
});
export type WatchlistItem = z.infer<typeof itemSchema>;
export type WatchlistSnapshot = z.infer<typeof watchlistSchema>;
export type WatchlistQuote = z.infer<typeof quoteSchema>;
export type WatchlistCommand =
  | { action: "create_group"; name: string }
  | { action: "rename_group"; group_id: string; name: string }
  | { action: "delete_group"; group_id: string }
  | { action: "add" | "remove"; group_id: string; symbols: string[] }
  | {
      action: "copy" | "move";
      group_id: string;
      target_group_id: string;
      symbols: string[];
    }
  | { action: "pin"; group_id: string; symbols: [string]; pinned: boolean }
  | ({ action: "reorder"; group_id: string; symbols: [string] } & (
      | { edge: "first" | "last" }
      | { anchor: string; side: "before" | "after" }
    ));

async function request<T>(
  path: `/api/alpha${string}`,
  schema: z.ZodType<T>,
  body?: WatchlistCommand,
  group?: string,
): Promise<T> {
  const response = await requestAlpha({
    method: body ? "POST" : "GET",
    path,
    ...(body ? { body } : {}),
    ...(group ? { query: [{ name: "group_id", value: group }] } : {}),
  });
  if (response.status < 200 || response.status >= 300) {
    const detail = z.object({ detail: z.string() }).safeParse(response.body);
    throw new Error(
      detail.success ? detail.data.detail : `HTTP ${response.status}`,
    );
  }
  return schema.parse(response.body);
}
export function getWatchlist() {
  return request("/api/alpha/watchlist", watchlistSchema);
}
export function changeWatchlist(command: WatchlistCommand) {
  return request(
    "/api/alpha/watchlist/commands",
    watchlistSchema.extend({
      transfer: z
        .object({
          total: z.number().int().nonnegative(),
          existing: z.number().int().nonnegative(),
        })
        .optional(),
    }),
    command,
  );
}
export function getWatchlistQuotes(group: string) {
  return request(
    "/api/alpha/watchlist/quotes",
    z.array(quoteSchema),
    undefined,
    group,
  );
}
