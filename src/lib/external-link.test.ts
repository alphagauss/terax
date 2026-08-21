/**
 * 本文件测试系统外链的协议白名单和收尾语义。
 * 重点锁定危险协议不会进入原生 opener，且所有结果都会恢复调用方状态。
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn() }));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

import { isExternalUrl, openExternalUrl } from "./external-link";

describe("isExternalUrl", () => {
  it("allows only the approved external protocols", () => {
    expect(isExternalUrl("https://example.com")).toBe(true);
    expect(isExternalUrl("HTTP://example.com")).toBe(true);
    expect(isExternalUrl("mailto:user@example.com")).toBe(true);
    expect(isExternalUrl("tel:+12025550123")).toBe(true);
  });

  it("blocks privileged and unresolved destinations", () => {
    expect(isExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isExternalUrl("file:///tmp/example")).toBe(false);
    expect(isExternalUrl("../relative/path")).toBe(false);
  });
});

describe("openExternalUrl", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("does not send blocked links to the native opener", async () => {
    const onSettled = vi.fn();

    await openExternalUrl("javascript:alert(1)", onSettled);

    expect(openUrl).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("opens allowed links and settles after success", async () => {
    openUrl.mockResolvedValue(undefined);
    const onSettled = vi.fn();

    await openExternalUrl("https://example.com", onSettled);

    expect(openUrl).toHaveBeenCalledWith("https://example.com");
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("contains opener failures and still settles", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    openUrl.mockRejectedValue(new Error("unavailable"));
    const onSettled = vi.fn();

    await expect(
      openExternalUrl("https://example.com", onSettled),
    ).resolves.toBeUndefined();
    expect(onSettled).toHaveBeenCalledOnce();
  });
});
