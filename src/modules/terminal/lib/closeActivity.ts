/**
 * 从 PTY 原始输出跟踪关闭保护，独立于 xterm 挂载、块模式和休眠。
 * 只接受首个 Shell 的状态，嵌套 Shell 的提示符不能结束外层命令。
 */
export type CloseActivity = {
  shellPid: number;
  running: boolean;
  backgroundPids: number[] | null;
};

export class CloseActivityTracker {
  current: CloseActivity | null = null;
  private pending = "";
  private decoder = new TextDecoder();

  submitted(): void {
    if (this.current) this.current = { ...this.current, running: true };
  }

  feed(bytes: Uint8Array): void {
    if (!this.pending && !bytes.includes(0x1b)) return;
    // 保留跨 chunk 的 OSC；限制未终止序列，避免普通输出或损坏序列无限增长。
    const text = this.pending + this.decoder.decode(bytes, { stream: true });
    this.pending = "";
    const sequences = /\x1b\]([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
    let consumed = 0;
    for (const match of text.matchAll(sequences)) {
      consumed = match.index + match[0].length;
      const fields = match[1].split(";");
      if (fields.length !== 6 || !match[1].startsWith("777;terax;tasks;"))
        continue;
      const [, , , pid, mode, jobs] = fields;
      if (!/^[1-9]\d*$/.test(pid ?? "")) continue;
      const shellPid = Number(pid);
      if (!Number.isSafeInteger(shellPid) || shellPid > 0xffffffff) continue;
      if (this.current && this.current.shellPid !== shellPid) continue;
      if (mode !== "running" && mode !== "idle") continue;
      if (jobs !== "?" && !/^(?:[1-9]\d*(?:,[1-9]\d*)*)?$/.test(jobs ?? ""))
        continue;
      const backgroundPids =
        jobs === "?" ? null : jobs ? jobs.split(",").map(Number) : [];
      if (
        backgroundPids?.some(
          (id) => !Number.isSafeInteger(id) || id > 0xffffffff,
        )
      )
        continue;
      this.current = { shellPid, running: mode === "running", backgroundPids };
    }
    const start = text.lastIndexOf("\x1b]");
    if (start >= consumed && text.length - start <= 16384) {
      const tail = text.slice(start);
      if (!tail.includes("\x07")) {
        this.pending = tail;
      }
    } else if (text.endsWith("\x1b")) {
      this.pending = "\x1b";
    }
  }
}
