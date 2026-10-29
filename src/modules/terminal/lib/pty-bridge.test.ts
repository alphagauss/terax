import { beforeEach, describe, expect, it, vi } from "vitest";
import { openPty } from "./pty-bridge";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: native.invoke,
  Channel: class {
    onmessage = (_value: unknown) => {};
  },
}));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
}));

describe("统一终端关闭保护", () => {
  let data: (bytes: ArrayBuffer) => void;
  let exit: (code: number) => void;
  const report = (mode: string, jobs = "") =>
    data(
      new TextEncoder().encode(`\x1b]777;terax;tasks;10;${mode};${jobs}\x07`)
        .buffer,
    );

  beforeEach(() => {
    native.invoke.mockReset();
    native.invoke.mockImplementation(async (command, args) => {
      if (command === "pty_open") {
        data = (bytes) => args.onData.onmessage(bytes);
        exit = (code) => args.onExit.onmessage(code);
        return 1;
      }
      return false;
    });
  });

  it("只回收明确空闲且没有未提交输入的终端，关闭后不再写入", async () => {
    const pty = await openPty(80, 24, { onData: vi.fn() });
    expect(pty.isKnownIdle()).toBe(false);
    report("idle", "?");
    expect(pty.isKnownIdle()).toBe(false);
    report("idle", "20");
    expect(pty.isKnownIdle()).toBe(false);
    report("idle");
    expect(pty.isKnownIdle()).toBe(true);
    await pty.write("echo pending");
    report("idle");
    expect(pty.isKnownIdle()).toBe(false);
    await pty.write("\r", true);
    report("running");
    report("idle");
    expect(pty.isKnownIdle()).toBe(true);
    const close = pty.close(true);
    expect(pty.isKnownIdle()).toBe(false);
    await pty.write("must not be sent");
    await close;
    expect(native.invoke).toHaveBeenLastCalledWith("pty_close", {
      id: 1,
      reclaimed: true,
    });
  });

  it("空闲 WSL/SSH 无作业时不查询包装进程，运行内置命令时也保护", async () => {
    const pty = await openPty(80, 24, { onData: vi.fn() });
    report("idle");
    expect(await pty.needsCloseConfirmation()).toBe(false);
    expect(native.invoke).toHaveBeenCalledTimes(1);
    await pty.write("\x1b[200~line\rline\x1b[201~");
    expect(await pty.needsCloseConfirmation()).toBe(false);
    report("running");
    expect(await pty.needsCloseConfirmation()).toBe(true);
    report("idle");
    await pty.write("sleep 30\r");
    expect(await pty.needsCloseConfirmation()).toBe(true);
    exit(0);
    expect(await pty.needsCloseConfirmation()).toBe(false);
  });

  it("每次关闭重新核对后台作业，结束后不再提示", async () => {
    const pty = await openPty(80, 24, { onData: vi.fn() });
    report("idle", "20");
    native.invoke.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await pty.needsCloseConfirmation()).toBe(true);
    expect(await pty.needsCloseConfirmation()).toBe(false);
    expect(native.invoke).toHaveBeenLastCalledWith("pty_has_running_tasks", {
      id: 1,
      shellPid: 10,
      backgroundPids: [20],
    });
  });

  it("PowerShell 专用提交没有 CR，仍在 Shell 回传前保持关闭保护", async () => {
    const pty = await openPty(80, 24, { onData: vi.fn() });
    report("idle");
    await pty.write("#terax:YQ==\x1b[24;5~", true);
    expect(await pty.needsCloseConfirmation()).toBe(true);
    report("idle");
    expect(await pty.needsCloseConfirmation()).toBe(false);
  });

  it("未知和查询失败保留确认，新 PTY 不继承旧连接状态", async () => {
    const pty = await openPty(80, 24, { onData: vi.fn() });
    native.invoke.mockResolvedValueOnce(null);
    expect(await pty.needsCloseConfirmation()).toBe(true);
    report("idle");
    expect(await pty.needsCloseConfirmation()).toBe(false);
    const next = await openPty(80, 24, { onData: vi.fn() });
    native.invoke.mockResolvedValueOnce(null);
    expect(await next.needsCloseConfirmation()).toBe(true);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    native.invoke.mockRejectedValueOnce(new Error("disconnected"));
    expect(await next.needsCloseConfirmation()).toBe(true);
    log.mockRestore();
  });

  it("查询期间提交的新命令不被旧空闲结果覆盖", async () => {
    const pty = await openPty(80, 24, { onData: vi.fn() });
    report("idle", "20");
    let finish!: (busy: boolean) => void;
    native.invoke.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    const check = pty.needsCloseConfirmation();
    report("running");
    finish(false);
    expect(await check).toBe(true);
  });

  it("首次状态到达前，尚未写入完成的输入也需要关闭保护", async () => {
    const pty = await openPty(80, 24, { onData: vi.fn() });
    let complete!: () => void;
    native.invoke.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
    );
    const write = pty.write("sleep 30\r");
    expect(await pty.needsCloseConfirmation()).toBe(true);
    complete();
    await write;
  });

  it("写入失败恢复空闲，但不覆盖期间收到的运行状态", async () => {
    const pty = await openPty(80, 24, { onData: vi.fn() });
    report("idle");
    native.invoke.mockRejectedValueOnce(new Error("write failed"));
    await expect(pty.write("sleep 30\r")).rejects.toThrow("write failed");
    expect(await pty.needsCloseConfirmation()).toBe(false);
    let reject!: (error: Error) => void;
    native.invoke.mockReturnValueOnce(
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
    );
    const write = pty.write("sleep 30\r");
    report("running");
    reject(new Error("write failed"));
    await expect(write).rejects.toThrow("write failed");
    expect(await pty.needsCloseConfirmation()).toBe(true);
  });

  it("查询期间已返回无作业提示符时不误报，作业变化则重新核对", async () => {
    const pty = await openPty(80, 24, { onData: vi.fn() });
    report("idle", "20");
    let finish!: (busy: boolean) => void;
    native.invoke.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    const check = pty.needsCloseConfirmation();
    report("idle");
    finish(true);
    expect(await check).toBe(false);
    report("idle", "20");
    native.invoke.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    const next = pty.needsCloseConfirmation();
    report("idle", "21");
    native.invoke.mockResolvedValueOnce(false);
    finish(true);
    expect(await next).toBe(false);
    expect(native.invoke).toHaveBeenLastCalledWith("pty_has_running_tasks", {
      id: 1,
      shellPid: 10,
      backgroundPids: [21],
    });
  });
});
