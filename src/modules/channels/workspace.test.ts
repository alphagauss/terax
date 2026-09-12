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

it("derives a stable account directory without sending account rules to Rust", async () => {
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
  expect(channelAccountKey("another", "owner")).not.toBe(
    channelAccountKey("weixin", "owner"),
  );
  expect(io.invoke).toHaveBeenCalledWith("workspace_prepare_default_root", {
    appSubdir: "channels/weixin-owner",
  });
});

it("preserves readable accounts and portable original filenames", () => {
  expect(channelAccountKey("weixin", "owner@im.wechat")).toBe(
    "weixin-owner@im.wechat",
  );
  expect(channelAccountKey("weixin", "a/b")).not.toBe(
    channelAccountKey("weixin", "a%2Fb"),
  );
  expect(channelAccountKey("weixin", "a*.")).toBe("weixin-a%2A%2E");
  expect(channelAttachmentPath("../../CON.txt")).toBe("attachments/_CON.txt");
  expect(channelAttachmentPath("a:b?.pdf")).toBe("attachments/a_b_.pdf");
  expect(channelAttachmentPath("a\u0085b.pdf")).toBe("attachments/a_b.pdf");
  expect(channelAttachmentPath("报告.pdf")).toBe("attachments/报告.pdf");
  expect(channelAttachmentPath("image.jpg")).toBe("attachments/image.jpg");
  expect(channelAttachmentPath(".env")).toBe("attachments/.env");
});
