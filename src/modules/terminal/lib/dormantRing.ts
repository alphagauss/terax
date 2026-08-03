/**
 * 本文件实现无渲染器终端的有界字节缓冲区。
 * 缓冲区溢出时从安全行边界恢复，避免重放半段控制序列。
 */

const DEFAULT_BYTE_CAP = 1024 * 1024;
const DEFAULT_BLOCK_SIZE = 16 * 1024;

// No \x1bc here: a full reset would erase the snapshot restored just before
// the drain, scrollback included.
const OVERFLOW_NOTICE = new TextEncoder().encode(
  "\r\n\x1b[0m\x1b[2m[terax: some output was dropped while this tab was hidden]\x1b[0m\r\n",
);

const LF = 0x0a;

/**
 * 缓存终端没有 renderer slot 时产生的 PTY 输出。
 *
 * 数据合并为固定大小的块并按字节限制容量。溢出时丢弃最旧块，读取从下一行边界
 * 恢复，避免重置终端或从控制序列中间开始重放。
 */
export class DormantRing {
  private blocks: Uint8Array[] = [];
  private head = 0;
  private tailLen = 0;
  private total = 0;
  private overflowed = false;

  constructor(
    private readonly byteCap = DEFAULT_BYTE_CAP,
    private readonly blockSize = DEFAULT_BLOCK_SIZE,
  ) {}

  push(bytes: Uint8Array): void {
    let offset = 0;
    while (offset < bytes.length) {
      let tail = this.blocks[this.blocks.length - 1];
      if (this.blocks.length === this.head || this.tailLen === tail.length) {
        tail = new Uint8Array(this.blockSize);
        this.blocks.push(tail);
        this.tailLen = 0;
      }
      const n = Math.min(tail.length - this.tailLen, bytes.length - offset);
      tail.set(bytes.subarray(offset, offset + n), this.tailLen);
      this.tailLen += n;
      this.total += n;
      offset += n;

      while (this.total > this.byteCap && this.blocks.length - this.head > 1) {
        this.total -= this.blocks[this.head].length;
        this.head++;
        this.overflowed = true;
      }
    }
    if (this.head > 16 && this.head > this.blocks.length / 2) {
      this.blocks = this.blocks.slice(this.head);
      this.head = 0;
    }
  }

  drain(write: (bytes: Uint8Array) => void): void {
    const last = this.blocks.length - 1;
    let skip = 0;
    if (this.overflowed && this.head <= last) {
      write(OVERFLOW_NOTICE);
      // Cut landed mid-line, likely mid-escape-sequence; LF never occurs
      // inside a multi-byte UTF-8 sequence so resuming there is safe.
      const first = this.blocks[this.head];
      const firstLen = this.head === last ? this.tailLen : first.length;
      const lf = first.subarray(0, firstLen).indexOf(LF);
      if (lf >= 0) skip = lf + 1;
    }
    for (let i = this.head; i <= last; i++) {
      const len = i === last ? this.tailLen : this.blocks[i].length;
      const start = i === this.head ? skip : 0;
      if (start < len) write(this.blocks[i].subarray(start, len));
    }
    this.blocks = [];
    this.head = 0;
    this.tailLen = 0;
    this.total = 0;
    this.overflowed = false;
  }

  byteLength(): number {
    return this.total;
  }
}
