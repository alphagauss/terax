type Listener = () => void;

const noop = () => {};

export class ProgressiveMountStore {
  private readonly mounted: Uint8Array;
  private readonly listeners = new Map<number, Set<Listener>>();
  private nextIndex: number;

  constructor(
    readonly blockCount: number,
    initiallyMounted = 0,
  ) {
    this.mounted = new Uint8Array(blockCount);
    this.nextIndex = Math.min(blockCount, initiallyMounted);
    this.mounted.fill(1, 0, this.nextIndex);
  }

  get allMounted(): boolean {
    return this.nextIndex >= this.blockCount;
  }

  get nextUnmountedIndex(): number | null {
    return this.allMounted ? null : this.nextIndex;
  }

  isMounted(index: number): boolean {
    return this.mounted[index] === 1;
  }

  subscribe(index: number, listener: Listener): () => void {
    let blockListeners = this.listeners.get(index);
    if (!blockListeners) {
      blockListeners = new Set();
      this.listeners.set(index, blockListeners);
    }
    blockListeners.add(listener);
    return () => {
      blockListeners.delete(listener);
      if (blockListeners.size === 0) this.listeners.delete(index);
    };
  }

  mountAround(index: number, radius: number): void {
    const start = Math.max(0, index - radius);
    const end = Math.min(this.blockCount - 1, index + radius);
    for (let current = start; current <= end; current += 1) {
      this.mount(current);
    }
  }

  mountNext(count: number): number {
    let mountedCount = 0;
    while (mountedCount < count && !this.allMounted) {
      const index = this.nextIndex;
      if (this.mount(index)) mountedCount += 1;
    }
    return mountedCount;
  }

  dispose(): void {
    this.listeners.clear();
  }

  private mount(index: number): boolean {
    if (index < 0 || index >= this.blockCount || this.mounted[index] === 1) {
      return false;
    }
    this.mounted[index] = 1;
    if (index === this.nextIndex) {
      while (
        this.nextIndex < this.blockCount &&
        this.mounted[this.nextIndex] === 1
      ) {
        this.nextIndex += 1;
      }
    }
    for (const listener of this.listeners.get(index) ?? []) listener();
    return true;
  }
}

type ProgressiveMountOptions = {
  active: boolean;
  batchSize: number;
  timeout: number;
};

export function startProgressiveMounting(
  store: ProgressiveMountStore,
  options: ProgressiveMountOptions,
): () => void {
  if (!options.active || store.allMounted) return noop;

  let cancelled = false;
  let idleHandle: number | null = null;
  let timerHandle: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (cancelled || store.allMounted) return;
    if (typeof globalThis.requestIdleCallback === "function") {
      idleHandle = globalThis.requestIdleCallback(runIdle, {
        timeout: options.timeout,
      });
    } else {
      timerHandle = globalThis.setTimeout(runFallback, 16);
    }
  };
  const runIdle = (deadline: IdleDeadline) => {
    idleHandle = null;
    if (cancelled || store.allMounted) return;
    if (deadline.timeRemaining() > 0 || deadline.didTimeout) {
      store.mountNext(options.batchSize);
    }
    schedule();
  };
  const runFallback = () => {
    timerHandle = null;
    if (cancelled || store.allMounted) return;
    store.mountNext(options.batchSize * 2);
    schedule();
  };

  schedule();
  return () => {
    cancelled = true;
    if (idleHandle !== null) globalThis.cancelIdleCallback?.(idleHandle);
    if (timerHandle !== null) globalThis.clearTimeout(timerHandle);
  };
}
