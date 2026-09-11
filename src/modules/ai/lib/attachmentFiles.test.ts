// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { WorkspaceEnv } from "@/modules/workspace";
import {
  pickNativeAttachments,
  readPathAttachment,
} from "@/modules/ai/lib/attachmentFiles";

const { open, invoke } = vi.hoisted(() => ({ open: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open }));

it("WSL 和 SSH 不得打开本机选择器，本机按绝对路径附加，取消不读取文件", async () => {
  const attach = vi.fn().mockResolvedValue(undefined);
  for (const kind of ["wsl", "ssh"] as const) {
    await pickNativeAttachments({ kind } as WorkspaceEnv, "Attach", attach);
  }
  expect(open).not.toHaveBeenCalled();
  expect(attach).not.toHaveBeenCalled();
  const paths = ["C:\\work\\文件.ts", "C:\\work\\image.png"];
  open.mockResolvedValueOnce(paths).mockResolvedValueOnce(null);
  await pickNativeAttachments({ kind: "local" }, "Attach", attach);
  expect(attach.mock.calls).toEqual(paths.map((path) => [path]));
  await pickNativeAttachments({ kind: "local" }, "Attach", attach);
  expect(attach).toHaveBeenCalledTimes(2);
});

it("图片只读取一次二进制，特殊扩展名走文本读取，原生错误不触发再次读取", async () => {
  const workspace = { kind: "local" } as const;
  invoke.mockResolvedValueOnce({ bytes: [65], size: 1 });
  const image = await readPathAttachment("C:/work/图.PNG", workspace);
  expect(image).toEqual({
    kind: "image",
    mediaType: "image/png",
    size: 1,
    url: "data:image/png;base64,QQ==",
  });
  expect(invoke.mock.calls).toEqual([
    ["fs_read_binary", { path: "C:/work/图.PNG", workspace }],
  ]);
  invoke.mockResolvedValueOnce({ kind: "text", content: "代码", size: 6 });
  expect(await readPathAttachment("/work/test.constructor", workspace)).toEqual(
    { kind: "text", content: "代码", size: 6 },
  );
  expect(invoke).toHaveBeenLastCalledWith("fs_read_file", {
    path: "/work/test.constructor",
    workspace,
  });
  invoke.mockRejectedValueOnce(new Error("file is too large"));
  await expect(
    readPathAttachment("/work/large.png", workspace),
  ).rejects.toThrow("file is too large");
  expect(invoke).toHaveBeenCalledTimes(3);
});
