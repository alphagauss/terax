/**
 * 本文件管理流式正文的目标文本和当前可见文本。
 * 每个活动正文最多以约 30 FPS 渐进追赶，完成或卸载后立即释放临时状态。
 */

import { STREAM_RENDER_INTERVAL_MS } from "./chatRendering";

type TextListener = () => void;

interface ProgressiveTextState {
  targetText: string | null;
  visibleText: string;
  listeners: Set<TextListener>;
  frameId: number | null;
  lastAdvanceAt: number | null;
}

function requestTextFrame(callback: () => void): number {
  if (
    typeof window !== "undefined" &&
    typeof window.requestAnimationFrame === "function"
  ) {
    return window.requestAnimationFrame(callback);
  }
  return globalThis.setTimeout(callback, 16) as unknown as number;
}

function cancelTextFrame(frameId: number): void {
  if (
    typeof window !== "undefined" &&
    typeof window.cancelAnimationFrame === "function"
  ) {
    window.cancelAnimationFrame(frameId);
    return;
  }
  globalThis.clearTimeout(frameId);
}

/**
 * 根据积压字符数决定单次推进量。
 *
 * 小积压保持连续观感，大积压指数追赶，超过上限时直接追平以避免动画欠债。
 */
export function progressiveTextAdvanceSize(backlog: number): number {
  if (backlog > 24_000) {
    return backlog;
  }
  if (backlog > 4_000) {
    return Math.ceil(backlog / 3);
  }
  if (backlog > 800) {
    return Math.ceil(backlog / 5);
  }
  return Math.max(12, Math.ceil(backlog / 8));
}

/**
 * 流式可见文本存储。
 *
 * 存储不属于 React 会话状态，只保存仍在输出的正文；关闭流式边界时调用
 * `clear`，历史消息始终直接使用最终文本。
 */
export class ProgressiveTextStore {
  private readonly streams = new Map<string, ProgressiveTextState>();

  subscribe(streamId: string, listener: TextListener): () => void {
    const stream = this.ensureStream(streamId);
    stream.listeners.add(listener);
    return () => {
      stream.listeners.delete(listener);
    };
  }

  hasTarget(streamId: string): boolean {
    const stream = this.streams.get(streamId);
    return stream !== undefined && stream.targetText !== null;
  }

  getVisibleText(streamId: string): string {
    return this.streams.get(streamId)?.visibleText ?? "";
  }

  setTarget(streamId: string, text: string): void {
    const stream = this.ensureStream(streamId);
    if (stream.targetText === null) {
      stream.targetText = text;
      stream.visibleText = text;
      this.notify(stream);
      return;
    }

    if (
      text.length < stream.visibleText.length ||
      !text.startsWith(stream.visibleText)
    ) {
      stream.targetText = text;
      stream.visibleText = text;
      this.cancelScheduled(stream);
      this.notify(stream);
      return;
    }

    stream.targetText = text;
    this.schedule(streamId, stream);
  }

  clear(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (stream) {
      this.cancelScheduled(stream);
    }
    this.streams.delete(streamId);
  }

  private ensureStream(streamId: string): ProgressiveTextState {
    const existing = this.streams.get(streamId);
    if (existing) {
      return existing;
    }
    const stream: ProgressiveTextState = {
      targetText: null,
      visibleText: "",
      listeners: new Set(),
      frameId: null,
      lastAdvanceAt: null,
    };
    this.streams.set(streamId, stream);
    return stream;
  }

  private schedule(streamId: string, stream: ProgressiveTextState): void {
    if (stream.frameId !== null) {
      return;
    }
    stream.frameId = requestTextFrame(() => {
      stream.frameId = null;
      this.advance(streamId);
    });
  }

  private advance(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (!stream || stream.targetText === null) {
      return;
    }
    const backlog = stream.targetText.length - stream.visibleText.length;
    if (backlog <= 0) {
      return;
    }
    const now = Date.now();
    if (
      stream.lastAdvanceAt !== null &&
      now - stream.lastAdvanceAt < STREAM_RENDER_INTERVAL_MS
    ) {
      this.schedule(streamId, stream);
      return;
    }
    const nextLength = Math.min(
      stream.targetText.length,
      stream.visibleText.length + progressiveTextAdvanceSize(backlog),
    );
    stream.visibleText = stream.targetText.slice(0, nextLength);
    stream.lastAdvanceAt = now;
    this.notify(stream);
    if (stream.visibleText.length < stream.targetText.length) {
      this.schedule(streamId, stream);
    }
  }

  private cancelScheduled(stream: ProgressiveTextState): void {
    if (stream.frameId === null) {
      return;
    }
    cancelTextFrame(stream.frameId);
    stream.frameId = null;
  }

  private notify(stream: ProgressiveTextState): void {
    for (const listener of stream.listeners) {
      listener();
    }
  }
}

export const progressiveTextStore = new ProgressiveTextStore();
