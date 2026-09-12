import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseWeixinMessage,
  WeixinAdapter,
} from "@/modules/channels/adapters/weixin";
import {
  downloadWeixinMedia,
  parseWeixinMedia,
  uploadWeixinMedia,
  weixinAesKey,
  weixinMediaUrl,
} from "@/modules/channels/adapters/weixinMedia";
import { httpFileRequest, withPreparedHttpFile } from "@/lib/httpFiles";
import { channelInputText } from "@/modules/channels/messages";

vi.mock("@/lib/httpFiles", () => ({
  httpFileRequest: vi.fn(),
  withPreparedHttpFile: vi.fn(),
}));
vi.mock("@/i18n", () => ({
  default: {
    t: (key: string, values?: Record<string, unknown>) =>
      key === "channels:imageAttachmentSummary"
        ? `images ${values?.paths}`
        : key,
  },
}));
const files = {
  root: "/account",
  ownerSessionId: "session",
  permissionMode: "full-access" as const,
};
const inbound = (items: unknown[]) => ({
  message_type: 1,
  message_state: 2,
  message_id: "id",
  from_user_id: "owner",
  context_token: "secret-context",
  item_list: items,
});

beforeEach(() => {
  vi.mocked(httpFileRequest).mockReset();
  vi.mocked(withPreparedHttpFile)
    .mockReset()
    .mockImplementation(async (_request, _signal, use) =>
      use({
        id: "body-id",
        name: "report.pdf",
        size: 7,
        bodySize: 16,
        md5: "digest",
      }),
    );
});

describe("WeChat attachment protocol", () => {
  it("retains an image filename when the platform provides one", () => {
    expect(parseWeixinMedia({ type: "toString" })).toBeNull();
    expect(parseWeixinMedia({ type: "2" })).toBeNull();
    expect(
      parseWeixinMedia({ type: 2, image_item: { file_name: "旅行照片.png" } })
        ?.attachment.name,
    ).toBe("旅行照片.png");
    expect(parseWeixinMedia({ type: 2, image_item: {} })?.attachment.name).toBe(
      "image.jpg",
    );
  });
  it("accepts media-only input and keeps protocol secrets outside model input", async () => {
    const key = btoa("0123456789abcdef");
    const parsed = parseWeixinMessage(
      inbound([
        {
          type: 2,
          image_item: {
            media: {
              full_url: "https://cdn.weixin.qq.com/image",
              aes_key: key,
            },
          },
        },
        { type: 3, voice_item: { text: "spoken task", media: {} } },
        { type: 4, file_item: { file_name: "report.pdf", media: {} } },
        { type: 5, video_item: { media: {} } },
      ]),
      "owner",
    );
    assert(parsed);
    expect(parsed.attachments.map((file) => file.kind)).toEqual([
      "image",
      "audio",
      "file",
      "video",
    ]);
    expect(parsed.text).toBe("spoken task");
    vi.mocked(httpFileRequest).mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: [],
      file: { path: "attachments/image.jpg", size: 100 },
    });
    parsed.attachments[0] = await downloadWeixinMedia(
      parsed.media[0],
      "connection",
      files,
      new AbortController().signal,
    );
    const text = channelInputText(parsed);
    expect(text).toContain("attachments/image.jpg");
    expect(text).not.toContain(key);
    expect(text).not.toMatch(/secret-context|cdn.weixin/);
    expect(httpFileRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: expect.objectContaining({
          root: "/account",
          transform: {
            algorithm: "aes-128-ecb-pkcs7",
            operation: "decrypt",
            key: Array.from("0123456789abcdef", (c) => c.charCodeAt(0)),
          },
        }),
      }),
      expect.any(AbortSignal),
    );
    expect(
      parseWeixinMessage(
        inbound([{ type: 4, file_item: { file_name: "only.pdf" } }]),
        "owner",
      )?.text,
    ).toBe("");
    expect(
      parseWeixinMessage(inbound([{ type: 2, image_item: {} }]), "stranger"),
    ).toBeNull();
  });

  it("decodes platform keys and refuses invalid locations before transfer", async () => {
    expect(weixinAesKey(btoa("2a".repeat(16)))).toEqual(Array(16).fill(42));
    expect(weixinAesKey(btoa("*".repeat(16)))).toEqual(Array(16).fill(42));
    expect(() => weixinAesKey("bad")).toThrow();
    for (const url of [
      "https://weixin.qq.com.evil.test/x",
      "http://cdn.weixin.qq.com/x",
      "https://a@cdn.weixin.qq.com/x",
      "https://cdn.weixin.qq.com:123/x",
    ])
      expect(() => weixinMediaUrl(url)).toThrow();
    const media = parseWeixinMedia({
      type: 4,
      file_item: {
        file_name: "x",
        media: { full_url: "https://cdn.weixin.qq.com/x" },
      },
    });
    assert(media);
    expect(
      await downloadWeixinMedia(
        media,
        "connection",
        files,
        new AbortController().signal,
      ),
    ).toMatchObject({ status: "failed", name: "x" });
    expect(httpFileRequest).not.toHaveBeenCalled();
  });

  it.each([
    ["file", 3, 4, "file_item"],
    ["image", 1, 2, "image_item"],
    ["video", 2, 5, "video_item"],
    ["audio", 4, 3, "voice_item"],
  ] as const)(
    "owns the %s upload negotiation and wire item in TS",
    async (presentation, uploadType, itemType, itemKey) => {
      vi.mocked(httpFileRequest).mockResolvedValueOnce({
        status: 200,
        headers: { "x-encrypted-param": "download-ref" },
        body: [],
      });
      const negotiate = vi.fn(async () => ({
        upload_full_url: "https://cdn.weixin.qq.com/upload",
      }));
      const item = await uploadWeixinMedia(
        { path: "relative.pdf", presentation },
        files,
        "connection",
        "recipient",
        new AbortController().signal,
        negotiate,
      );
      expect(negotiate).toHaveBeenCalledWith(
        expect.objectContaining({
          media_type: uploadType,
          rawsize: 7,
          rawfilemd5: "digest",
          filesize: 16,
          to_user_id: "recipient",
        }),
      );
      expect(withPreparedHttpFile).toHaveBeenCalledWith(
        expect.objectContaining({
          root: "/account",
          ownerSessionId: "session",
          path: "relative.pdf",
          transform: expect.objectContaining({ operation: "encrypt" }),
        }),
        expect.any(AbortSignal),
        expect.any(Function),
      );
      expect(httpFileRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          bodyFile: "body-id",
          url: "https://cdn.weixin.qq.com/upload",
          headers: { "Content-Type": "application/octet-stream" },
        }),
        expect.any(AbortSignal),
      );
      expect(item).toMatchObject({
        type: itemType,
        [itemKey]: {
          media: { encrypt_query_param: "download-ref", encrypt_type: 1 },
        },
      });
      if (presentation === "file")
        expect(item[itemKey]).toMatchObject({
          file_name: "report.pdf",
          len: "7",
        });
    },
  );

  it("reports partial failure without duplicating an accepted file", async () => {
    vi.mocked(httpFileRequest)
      .mockResolvedValueOnce({
        status: 200,
        headers: { "x-encrypted-param": "ref" },
        body: [],
      })
      .mockRejectedValueOnce(new Error("upload failed"));
    const fetch = vi.fn(async () =>
      Response.json({ ret: 0, upload_param: "param" }),
    );
    const adapter = new WeixinAdapter(
      {
        token: "secret",
        baseUrl: "https://ilinkai.weixin.qq.com",
        userId: "owner",
        botId: "bot",
      },
      "connection",
      files,
      fetch,
    );
    const result = await adapter.send(
      {
        id: "id",
        senderId: "owner",
        receivedAt: Date.now(),
        replyContext: "context",
        text: "",
        attachments: [],
      },
      {
        attachments: [
          { path: "first.pdf", presentation: "file" },
          { path: "second.pdf", presentation: "file" },
        ],
        text: "done",
      },
      new AbortController().signal,
    );
    expect(result).toEqual({
      status: "partial",
      parts: [
        { index: 0, status: "accepted" },
        { index: 1, status: "failed" },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(httpFileRequest).toHaveBeenCalledTimes(2);
  });
});
