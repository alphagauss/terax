import type { NativeChannel } from "@/lib/nativeHost";
import type { WorkspaceEnv } from "@/modules/workspace";
import { beforeEach, expect, it, vi } from "vitest";
import { type GitProgress, native } from "./native";

const host = vi.hoisted(() => ({
  invoke: vi.fn(),
  channel: vi.fn(),
  workspace: vi.fn(),
}));
vi.mock("@/lib/nativeHost", () => ({
  getNativeHost: async () => host,
}));

beforeEach(() => {
  vi.resetAllMocks();
});

it.each(["gitFetch", "gitPullFfOnly", "gitPush"] as const)(
  "%s 的本地进度通道在成功或失败后停止分发",
  async (method) => {
    host.workspace.mockReturnValue({ kind: "local" });
    const channel: NativeChannel<GitProgress | null> = { onmessage: () => {} };
    host.channel.mockReturnValue(channel);
    const handler = vi.fn();
    const progress = { stage: "receiving", percent: 65 } as const;
    host.invoke.mockImplementationOnce(async () => {
      channel.onmessage(progress);
      return undefined;
    });
    await native[method]("/repo", "first", handler);
    expect(handler).toHaveBeenCalledExactlyOnceWith(progress);
    channel.onmessage(progress);
    expect(handler).toHaveBeenCalledOnce();
    host.invoke.mockImplementationOnce(async () => {
      channel.onmessage(null);
      throw new Error("git failed");
    });
    await expect(native[method]("/repo", "second", handler)).rejects.toThrow(
      "git failed",
    );
    channel.onmessage(progress);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenLastCalledWith(null);
  },
);

it.each<WorkspaceEnv>([
  { kind: "wsl", distro: "Ubuntu" },
  { kind: "ssh", profileId: "server" },
])("$kind 保持普通调用，不创建持续进度通道", async (workspace) => {
  host.workspace.mockReturnValue(workspace);
  for (const method of ["gitFetch", "gitPullFfOnly", "gitPush"] as const) {
    const handler = vi.fn();
    await native[method]("/repo", "operation", handler);
    expect(handler).not.toHaveBeenCalled();
  }
  expect(host.channel).not.toHaveBeenCalled();
  expect(host.invoke).toHaveBeenCalledTimes(3);
  for (const [, args] of host.invoke.mock.calls) {
    expect(args).toMatchObject({
      workspace,
      repoRoot: "/repo",
      operationId: "operation",
    });
    expect(args.onProgress).toBeUndefined();
  }
});
