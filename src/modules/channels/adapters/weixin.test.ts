/**
 * 本文件验证微信授权边界、扫码返回地址和投递结果。
 * 平台回包不能改变请求对端，不确定的发送不能自动重试。
 */
import {
  withWeixinInbound,
  receiveWeixinContext,
} from "@/modules/channels/adapters/weixinTestHelpers";

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
    [{}, "accepted", undefined],
    ["", "accepted", undefined],
    [null, "accepted", undefined],
    [{ ret: 0 }, "accepted", undefined],
    [{ ret: "0" }, "unknown", "protocol"],
    [{ ret: 0, errcode: null }, "accepted", undefined],
    [{ ret: 0, errcode: -14 }, "failed", "auth"],
    [{ ret: -2 }, "failed", "rejected"],
    [{ errcode: 0 }, "accepted", undefined],
  ])(
    "按微信协议接受空对象成功回执，保留明确错误和格式异常：%j",
    async (response, status, reason) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        response === null
          ? new Response(null, { status: 204 })
          : response === ""
            ? new Response("")
            : Response.json(response),
      );
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
        withWeixinInbound(fetch),
      );
      expect(
        await adapter.send(
          { kind: "direct", id: "stranger" },
          { text: "wrong target" },
          new AbortController().signal,
        ),
      ).toEqual({ status: "failed", parts: [], total: 1, reason: "target" });
      expect(fetch).not.toHaveBeenCalled();
      expect(
        await adapter.send(
          { kind: "direct", id: "owner" },
          { text: "reply" },
          new AbortController().signal,
        ),
      ).toEqual({
        status,
        parts: [{ index: 0, status }],
        total: 1,
        ...(reason ? { reason } : {}),
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(String(fetch.mock.calls[0][1]?.body)).msg.context_token,
      ).toBeUndefined();
    },
  );

  it("长正文完整分段发送，不静默截断", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({}));
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
      withWeixinInbound(fetch),
    );
    await receiveWeixinContext(adapter);
    const text = "正文".repeat(9000);
    const result = await adapter.send(
      { kind: "direct", id: "owner" },
      { text },
      new AbortController().signal,
    );
    expect(result.status).toBe("accepted");
    expect(
      fetch.mock.calls
        .map(
          (call) =>
            JSON.parse(String(call[1]?.body)).msg.item_list[0].text_item.text,
        )
        .join(""),
    ).toBe(text);
  });

  it("复用入站上下文且不额外刷新，发送网络异常仍保留取消语义", async () => {
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
      withWeixinInbound(fetch),
    );
    const message = { kind: "direct" as const, id: "owner" };
    await receiveWeixinContext(adapter);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    expect(
      await adapter.send(
        message,
        { text: "reply" },
        new AbortController().signal,
      ),
    ).toEqual({
      status: "unknown",
      parts: [{ index: 0, status: "unknown" }],
      total: 1,
      reason: "network",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toContain("/sendmessage");
    expect(
      JSON.parse(String(fetch.mock.calls[0][1]?.body)).msg.context_token,
    ).toBeDefined();
    await expect(
      adapter.send(message, { text: "reply" }, AbortSignal.abort()),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
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
      withWeixinInbound(fetch),
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
        withWeixinInbound(fetch),
      );
      await receiveWeixinContext(adapter);
      const sending = adapter.send(
        { kind: "direct", id: "owner" },
        { text: `${"a".repeat(1800)}tail` },
        new AbortController().signal,
      );
      await vi.runAllTimersAsync();
      expect(await sending).toEqual({
        status: "unknown",
        reason: "network",
        total: 2,
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
            message.context_token === "context",
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
