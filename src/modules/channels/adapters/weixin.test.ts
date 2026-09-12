/**
 * 本文件验证微信授权边界、扫码返回地址和投递结果。
 * 平台回包不能改变请求对端，不确定的发送不能自动重试。
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
  it.each([
    [{}, "unknown"],
    [{ ret: "0" }, "unknown"],
    [{ ret: 0, errcode: null }, "unknown"],
    [{ ret: 0, errcode: -14 }, "failed"],
    [{ errcode: 0 }, "accepted"],
  ])(
    "requires an explicit valid send acknowledgement: %j",
    async (response, status) => {
      const fetch = vi.fn(async () => Response.json(response));
      const adapter = new WeixinAdapter(
        {
          token: "secret",
          baseUrl: "https://ilinkai.weixin.qq.com",
          botId: "bot",
          userId: "owner",
        },
        "connection",
        {
          root: "/account",
          ownerSessionId: "session",
          permissionMode: "full-access",
        },
        fetch,
      );
      expect(
        await adapter.send(
          {
            id: "id",
            senderId: "owner",
            text: "",
            attachments: [],
            replyContext: "context",
            receivedAt: Date.now(),
          },
          { text: "reply" },
          new AbortController().signal,
        ),
      ).toEqual({ status, parts: [{ index: 0, status }] });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("reports failed context refresh before dispatch and preserves cancellation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError("offline");
    });
    const adapter = new WeixinAdapter(
      {
        token: "secret",
        baseUrl: "https://ilinkai.weixin.qq.com",
        botId: "bot",
        userId: "owner",
      },
      "connection",
      {
        root: "/account",
        ownerSessionId: "session",
        permissionMode: "full-access",
      },
      fetch,
    );
    const message = {
      id: "id",
      senderId: "owner",
      text: "",
      attachments: [],
      replyContext: "context",
      receivedAt: Date.now() - 61_000,
    };
    expect(
      await adapter.send(
        message,
        { text: "reply" },
        new AbortController().signal,
      ),
    ).toEqual({ status: "failed", parts: [] });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toContain("/getconfig");
    await expect(
      adapter.send(message, { text: "reply" }, AbortSignal.abort()),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

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
      attachments: [],
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
    const flow = await beginWeixinLogin(
      "connection",
      new AbortController().signal,
      fetch,
    );
    await expect(flow.poll()).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports an uncertain fragment without resending accepted text or changing target", async () => {
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
        "connection",
        {
          root: "/account",
          ownerSessionId: "session",
          permissionMode: "full-access",
        },
        fetch,
      );
      const sending = adapter.send(
        {
          id: "input",
          senderId: "owner",
          text: "question",
          attachments: [],
          replyContext: "original",
          receivedAt: Date.now(),
        },
        { text: `${"a".repeat(1800)}tail` },
        new AbortController().signal,
      );
      await vi.runAllTimersAsync();
      expect(await sending).toEqual({
        status: "unknown",
        parts: [
          { index: 0, status: "accepted" },
          { index: 1, status: "unknown" },
        ],
      });
      const messages = fetch.mock.calls.map(
        ([, init]) => JSON.parse(init.body).msg,
      );
      expect(
        messages.map((message) => message.item_list[0].text_item.text),
      ).toEqual(["a".repeat(1800), "tail"]);
      expect(fetch).toHaveBeenCalledTimes(2);
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
