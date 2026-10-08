import { describe, expect, it } from "vitest";
import { CloseActivityTracker } from "./closeActivity";

const bytes = (text: string) => new TextEncoder().encode(text);
const marker = (pid: number, mode: string, jobs = "") =>
  `\x1b]777;terax;tasks;${pid};${mode};${jobs}\x1b\\`;

describe("PTY 关闭状态", () => {
  it("在任意字节边界接收状态，不依赖渲染器和 OSC 133", () => {
    const stream = `${marker(10, "idle")}${marker(10, "running")}${marker(10, "idle", "20,21")}`;
    for (let split = 0; split <= stream.length; split++) {
      const tracker = new CloseActivityTracker();
      tracker.feed(bytes(stream.slice(0, split)));
      tracker.feed(bytes(stream.slice(split)));
      expect(tracker.current).toEqual({
        shellPid: 10,
        running: false,
        backgroundPids: [20, 21],
      });
    }
    const tracker = new CloseActivityTracker();
    for (const byte of bytes(stream)) tracker.feed(new Uint8Array([byte]));
    expect(tracker.current?.backgroundPids).toEqual([20, 21]);
  });

  it("嵌套 Shell 的提示符不会把外层任务标为空闲", () => {
    const tracker = new CloseActivityTracker();
    tracker.feed(bytes(marker(10, "idle")));
    tracker.submitted();
    tracker.feed(bytes(marker(20, "idle")));
    expect(tracker.current?.running).toBe(true);
    tracker.feed(bytes(marker(10, "idle")));
    expect(tracker.current?.running).toBe(false);
  });

  it("保留未知状态并忽略无效或过长序列，之后仍可恢复", () => {
    const tracker = new CloseActivityTracker();
    tracker.feed(bytes("普通输出\x1b]777;terax;tasks;bad;idle;\x07"));
    tracker.feed(bytes(marker(10, "idle", "999999999999999999999")));
    expect(tracker.current).toBeNull();
    tracker.feed(bytes(`\x1b]${"x".repeat(17000)}`));
    tracker.feed(bytes(marker(10, "idle", "?").replace("\x1b\\", "\x07")));
    expect(tracker.current).toEqual({
      shellPid: 10,
      running: false,
      backgroundPids: null,
    });
  });

  it("损坏的长 OSC 不会吞掉后续分片的有效状态", () => {
    const tracker = new CloseActivityTracker();
    const valid = marker(10, "running");
    tracker.feed(bytes(`\x1b]${"x".repeat(17000)}${valid.slice(0, 15)}`));
    tracker.feed(bytes(valid.slice(15)));
    expect(tracker.current?.running).toBe(true);
  });
});
