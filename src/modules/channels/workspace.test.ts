import { expect, it, vi } from "vitest";
import {
  channelAccountKey,
  channelAttachmentPath,
  prepareChannelWorkspace,
} from "@/modules/channels/workspace";
const io = vi.hoisted(() => ({
  invoke: vi.fn(
    async (_command: string, args: { appSubdir: string }) =>
      `~/.terax/${args.appSubdir}`,
  ),
}));
vi.mock("@/lib/nativeHost", () => ({
  getNativeHost: async () => ({ invoke: io.invoke }),
}));

it("derives a stable short account directory without sending account rules to Rust", async () => {
  const first = await prepareChannelWorkspace({
    kind: "weixin",
    accountId: "owner",
  });
  const second = await prepareChannelWorkspace({
    kind: "weixin",
    accountId: "owner",
  });
  expect(first).toBe(second);
  expect(
    await prepareChannelWorkspace({ kind: "weixin", accountId: "other" }),
  ).not.toBe(first);
  const key = await channelAccountKey("weixin", "owner");
  expect(key).toMatch(/^weixin-[A-Za-z0-9_-]{11}$/);
  expect(await channelAccountKey("another", "owner")).not.toBe(key);
  expect(io.invoke).toHaveBeenCalledWith("workspace_prepare_default_root", {
    appSubdir: `channels/${key}`,
  });
});

it("uses a portable fixed-length account hash and preserves original filenames", async () => {
  const email = await channelAccountKey("weixin", "owner@im.wechat");
  expect(email).toMatch(/^weixin-[A-Za-z0-9_-]{11}$/);
  expect(email).not.toMatch(/[@.%]/);
  expect(await channelAccountKey("weixin", "a/b")).not.toBe(
    await channelAccountKey("weixin", "a%2Fb"),
  );
  expect(await channelAccountKey("weixin", "a".repeat(256))).toHaveLength(
    "weixin-".length + 11,
  );
  expect(channelAttachmentPath("../../CON.txt")).toBe("attachments/_CON.txt");
  expect(channelAttachmentPath("a:b?.pdf")).toBe("attachments/a_b_.pdf");
  expect(channelAttachmentPath("a\u0085b.pdf")).toBe("attachments/a_b.pdf");
  expect(channelAttachmentPath("报告.pdf")).toBe("attachments/报告.pdf");
  expect(channelAttachmentPath("image.jpg")).toBe("attachments/image.jpg");
  expect(channelAttachmentPath(".env")).toBe("attachments/.env");
});
