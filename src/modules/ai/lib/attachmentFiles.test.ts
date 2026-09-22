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

it("图片只读取一次二进制，其他文件只读取属性", async () => {
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
  invoke.mockResolvedValueOnce({ kind: "file", size: 6 });
  expect(await readPathAttachment("/work/test.constructor", workspace)).toEqual(
    { kind: "file", size: 6 },
  );
  expect(invoke).toHaveBeenLastCalledWith("fs_stat", {
    path: "/work/test.constructor",
    workspace,
  });
  invoke.mockRejectedValueOnce(new Error("file is too large"));
  await expect(
    readPathAttachment("/work/large.png", workspace),
  ).rejects.toThrow("file is too large");
  expect(invoke).toHaveBeenCalledTimes(3);
});

it.each([
  ["default.jpg", [0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10], "image/png"],
  ["wrong.png", [0xff, 0xd8, 0xff], "image/jpeg"],
  [
    "image",
    Array.from("RIFF0000WEBP", (char) => char.charCodeAt(0)),
    "image/webp",
  ],
  ["image", Array.from("GIF89a", (char) => char.charCodeAt(0)), "image/gif"],
  [
    "image",
    Array.from("0000ftypavif", (char) => char.charCodeAt(0)),
    "image/avif",
  ],
] as const)("按字节识别 %s 的图片类型 %s", async (path, bytes, mediaType) => {
  invoke.mockResolvedValueOnce({ bytes, size: bytes.length });
  const result = await readPathAttachment(
    path,
    { kind: "local" },
    { image: true },
  );
  expect(result).toMatchObject({
    kind: "image",
    mediaType,
    url: expect.stringContaining(`data:${mediaType};base64,`),
  });
});

it("无扩展名的未知内容不伪装为图片", async () => {
  invoke.mockResolvedValueOnce({ bytes: [1, 2, 3], size: 3 });
  expect(
    await readPathAttachment("image", { kind: "local" }, { image: true }),
  ).toEqual({ kind: "binary", size: 3 });
});

it("符号链接保留原路径，但只接受指向普通文件的目标", async () => {
  const workspace = { kind: "local" } as const;
  invoke
    .mockResolvedValueOnce({ kind: "symlink", size: 0 })
    .mockResolvedValueOnce("C:/actual/file.bin")
    .mockResolvedValueOnce({ kind: "file", size: 42 });
  expect(await readPathAttachment("C:/link.bin", workspace)).toEqual({
    kind: "file",
    size: 42,
  });
  expect(invoke.mock.calls.slice(-3)).toEqual([
    ["fs_stat", { path: "C:/link.bin", workspace }],
    ["fs_canonicalize", { path: "C:/link.bin", workspace }],
    ["fs_stat", { path: "C:/actual/file.bin", workspace }],
  ]);

  invoke.mockResolvedValueOnce({ kind: "dir", size: 0 });
  expect(await readPathAttachment("C:/folder", workspace)).toEqual({
    kind: "unsupported",
    size: 0,
  });
});
