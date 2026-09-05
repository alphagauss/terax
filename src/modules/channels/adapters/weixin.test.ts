/**
 * 本文件验证微信授权边界、扫码返回地址以及回复重试。
 * 平台回包不能改变请求对端，分片重试沿用同一客户端消息身份。
 */

import {
  beginWeixinLogin,
  parseWeixinMessage,
  WeixinAdapter,
  weixinBaseUrl,
} from "@/modules/channels/adapters/weixin";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));

describe("personal WeChat", () => {
  it("admits only complete private text from the QR-authorized account", () => {
    const inbound = {
      message_type: 1,
      message_state: 2,
      message_id: "id",
      from_user_id: "owner",
      context_token: "context",
      item_list: [{ type: 1, text_item: { text: "hello" } }],
    };
    expect(parseWeixinMessage(inbound, "owner")).toMatchObject({
      senderId: "owner",
      text: "hello",
      replyContext: "context",
    });
    expect(parseWeixinMessage(inbound, "stranger")).toBeNull();
    expect(
      parseWeixinMessage({ ...inbound, group_id: "group" }, "owner"),
    ).toBeNull();
    expect(
      parseWeixinMessage({ ...inbound, message_type: 2 }, "owner"),
    ).toBeNull();
  });

  it("rejects credential destinations outside the platform boundary", async () => {
    expect(weixinBaseUrl("https://ilinkai.weixin.qq.com/")).toBe(
      "https://ilinkai.weixin.qq.com",
    );
    expect(() =>
      weixinBaseUrl("https://ilinkai.weixin.qq.com.evil.test"),
    ).toThrow();
    expect(() =>
      weixinBaseUrl("https://user:secret@ilinkai.weixin.qq.com"),
    ).toThrow();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ qrcode: "qr", qrcode_img_content: "scan" }),
      )
      .mockResolvedValueOnce(
        Response.json({
          status: "scaned_but_redirect",
          redirect_host: "attacker.test",
        }),
      );
    const flow = await beginWeixinLogin(new AbortController().signal, fetch);
    await expect(flow.poll()).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries only the failed text fragment using the original reply target", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(Response.json({ ret: 0 }))
        .mockResolvedValueOnce(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(
                  new TypeError("connection reset after headers"),
                );
              },
            }),
          ),
        )
        .mockResolvedValueOnce(Response.json({ ret: 0 }));
      const adapter = new WeixinAdapter(
        {
          token: "secret",
          baseUrl: "https://ilinkai.weixin.qq.com",
          botId: "bot",
          userId: "owner",
        },
        fetch,
      );
      const sending = adapter.send(
        {
          id: "input",
          senderId: "owner",
          text: "question",
          replyContext: "original",
          receivedAt: Date.now(),
        },
        `${"a".repeat(1800)}tail`,
        new AbortController().signal,
      );
      await vi.runAllTimersAsync();
      await sending;
      const messages = fetch.mock.calls.map(
        ([, init]) => JSON.parse(init.body).msg,
      );
      expect(
        messages.map((message) => message.item_list[0].text_item.text),
      ).toEqual(["a".repeat(1800), "tail", "tail"]);
      expect(messages[1].client_id).toBe(messages[2].client_id);
      expect(
        messages.every(
          (message) =>
            message.to_user_id === "owner" &&
            message.context_token === "original",
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
