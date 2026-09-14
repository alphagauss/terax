/** 测试通过真实接收入口建立回复上下文，不直接修改适配器内部缓存。 */
import type { WeixinAdapter } from "@/modules/channels/adapters/weixin";

export function withWeixinInbound(
  fetch: typeof globalThis.fetch,
  token = "context",
): typeof globalThis.fetch {
  return async (url, init) =>
    String(url).endsWith("/getupdates")
      ? Response.json({
          ret: 0,
          msgs: [
            {
              message_type: 1,
              message_state: 2,
              message_id: "input",
              from_user_id: "owner",
              context_token: token,
              item_list: [{ type: 1, text_item: { text: "hello" } }],
            },
          ],
        })
      : fetch(url, init);
}

export async function receiveWeixinContext(adapter: WeixinAdapter) {
  const abort = new AbortController();
  await adapter
    .receive({
      signal: abort.signal,
      cursor: "",
      status: () => {},
      checkpoint: async () => {},
      receive: async () => {
        abort.abort();
      },
    })
    .catch((error) => {
      if (error?.name !== "AbortError") throw error;
    });
}
