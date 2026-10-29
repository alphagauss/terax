import { createHash, webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileSyncReader } from "./fileSync";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const blockSize = 256 * 1024;
function changed(bytes: Uint8Array, previous?: Uint8Array) {
  const blocks: string[] = [];
  const chunks: { offset: number; data: string }[] = [];
  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    const block = bytes.subarray(offset, offset + blockSize);
    const digest = hash(block);
    blocks.push(digest);
    if (
      previous &&
      hash(previous.subarray(offset, offset + blockSize)) === digest
    )
      continue;
    chunks.push({ offset, data: Buffer.from(block).toString("base64") });
  }
  return {
    kind: "changed",
    checkpoint: {
      size: bytes.length,
      mtime: 1,
      revision: hash(bytes),
      blocks,
    },
    chunks,
  };
}
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("单检查点文件同步", () => {
  it("释放文档后不让迟到的同步恢复检查点", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const reader = new FileSyncReader();
    const first = changed(new TextEncoder().encode("one"));
    let finish!: (result: typeof first) => void;
    mocks.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = reader.read("/file", { kind: "local" }, false, true);
    reader.clear();
    finish(first);
    await expect(pending).rejects.toThrow("superseded");
    mocks.invoke.mockResolvedValueOnce(first);
    await reader.read("/file", { kind: "local" }, false, true);
    expect(mocks.invoke.mock.calls[1]?.[1].checkpoint).toBeNull();
  });

  it("保留 BOM，二进制文件可走元数据快路径，过大文件释放检查点", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const reader = new FileSyncReader();
    mocks.invoke.mockResolvedValueOnce(
      changed(new TextEncoder().encode("\ufeff正文\r\n")),
    );
    await expect(
      reader.read("/file", { kind: "local" }, false, true),
    ).resolves.toMatchObject({ content: "\ufeff正文\r\n" });
    const binary = changed(new Uint8Array([0, 255]));
    mocks.invoke.mockResolvedValueOnce(binary);
    await expect(
      reader.read("/file", { kind: "local" }, false, true),
    ).resolves.toMatchObject({ kind: "binary" });
    mocks.invoke.mockResolvedValueOnce({
      kind: "unchanged",
      checkpoint: binary.checkpoint,
    });
    await expect(
      reader.read("/file", { kind: "local" }, false, false),
    ).resolves.toMatchObject({ kind: "unchanged" });
    mocks.invoke.mockResolvedValueOnce({
      kind: "unchanged",
      checkpoint: binary.checkpoint,
    });
    await expect(
      reader.read("/file", { kind: "local" }, false, true, true),
    ).resolves.toMatchObject({ kind: "binary" });
    mocks.invoke.mockResolvedValueOnce({
      kind: "toolarge",
      size: 99,
      limit: 50,
      mtime: 2,
    });
    await expect(
      reader.read("/file", { kind: "local" }, false, true),
    ).resolves.toMatchObject({ kind: "toolarge" });
    mocks.invoke.mockResolvedValueOnce(binary);
    await reader.read("/file", { kind: "local" }, false, true);
    expect(mocks.invoke.mock.lastCall?.[1].checkpoint).toBeNull();
  });
  it("跨真实分块的 UTF-8 和 CRLF 边界组装追加、覆盖与截断", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const reader = new FileSyncReader();
    const workspace = { kind: "ssh", profileId: "dev" } as const;
    // 第一处分块在汉字内部，第二处分块在 CRLF 之间。
    const prefix = "a".repeat(blockSize - 1);
    const padding = "b".repeat(blockSize - 3);
    const original = `${prefix}正${padding}\r\n`;
    const initial = new TextEncoder().encode(original);
    const first = changed(initial);
    first.chunks.reverse();
    mocks.invoke.mockResolvedValueOnce(first);
    await expect(
      reader.read("/file", workspace, false, true),
    ).resolves.toMatchObject({ kind: "text", content: original });
    const appended = new TextEncoder().encode(`${original}新增`);
    mocks.invoke.mockResolvedValueOnce(changed(appended, initial));
    await expect(
      reader.read("/file", workspace, false, false),
    ).resolves.toMatchObject({ content: `${original}新增` });
    const replacement = `${prefix}政${padding}\r\n新增`;
    const rewritten = new TextEncoder().encode(replacement);
    const delta = changed(rewritten, appended);
    expect(delta.chunks).toHaveLength(1);
    expect(delta.chunks[0]?.offset).toBe(blockSize);
    mocks.invoke.mockResolvedValueOnce(delta);
    await expect(
      reader.read("/file", workspace, false, true),
    ).resolves.toMatchObject({ content: replacement });
    mocks.invoke.mockResolvedValueOnce(changed(new Uint8Array()));
    await expect(
      reader.read("/file", workspace, false, true),
    ).resolves.toMatchObject({ content: "", size: 0 });
    mocks.invoke.mockResolvedValueOnce(
      changed(new TextEncoder().encode("重建")),
    );
    await expect(
      reader.read("/file", workspace, false, false),
    ).resolves.toMatchObject({ content: "重建" });
    expect(mocks.invoke.mock.lastCall?.[1].checkpoint).toMatchObject({
      size: 0,
      blocks: [],
    });
  });

  it("校验失败保留旧检查点，相同全文摘要不污染已验证的分块摘要", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const reader = new FileSyncReader();
    const first = changed(new TextEncoder().encode("one"));
    const second = changed(new TextEncoder().encode("two"));
    mocks.invoke.mockResolvedValueOnce(first);
    await reader.read("/file", { kind: "local" }, false, true);
    mocks.invoke.mockResolvedValueOnce({ ...second, chunks: first.chunks });
    await expect(
      reader.read("/file", { kind: "local" }, false, true),
    ).rejects.toThrow("file changed");
    mocks.invoke.mockResolvedValueOnce(second);
    await reader.read("/file", { kind: "local" }, false, true);
    expect(mocks.invoke.mock.calls[2]?.[1].checkpoint).toEqual(
      first.checkpoint,
    );
    mocks.invoke.mockResolvedValueOnce({
      kind: "unchanged",
      checkpoint: {
        ...second.checkpoint,
        blocks: first.checkpoint.blocks,
        mtime: 2,
      },
    });
    await expect(
      reader.read("/file", { kind: "local" }, false, false),
    ).resolves.toMatchObject({ kind: "unchanged" });
    expect(mocks.invoke.mock.calls[3]?.[1].checkpoint).toEqual(
      second.checkpoint,
    );
    mocks.invoke.mockResolvedValueOnce({
      kind: "unchanged",
      checkpoint: second.checkpoint,
    });
    await reader.read("/file", { kind: "local" }, false, false);
    expect(mocks.invoke.mock.lastCall?.[1].checkpoint).toEqual({
      ...second.checkpoint,
      mtime: 2,
    });
  });
});
