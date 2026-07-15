type ProgressiveMountListener = () => void;

const noop = () => {};

function normalizeCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

export class ProgressiveMountController {
  readonly blockCount: number;

  private readonly mounted: Uint8Array;
  private readonly listeners = new Map<number, Set<ProgressiveMountListener>>();
  private nextIndex: number;
  private disposed = false;

  constructor(blockCount: number, initialCount: number) {
    this.blockCount = normalizeCount(blockCount);
    this.mounted = new Uint8Array(this.blockCount);
    const mountedCount = Math.min(
      this.blockCount,
      normalizeCount(initialCount),
    );
    this.mounted.fill(1, 0, mountedCount);
    this.nextIndex = mountedCount;
  }

  get allMounted(): boolean {
    return this.nextIndex >= this.blockCount;
  }

  get nextUnmountedIndex(): number | null {
    return this.allMounted ? null : this.nextIndex;
  }

  isMounted(index: number): boolean {
    return this.isValidIndex(index) && this.mounted[index] === 1;
  }

  subscribe(index: number, listener: ProgressiveMountListener): () => void {
    if (this.disposed || !this.isValidIndex(index)) return noop;

    let indexListeners = this.listeners.get(index);
    if (!indexListeners) {
      indexListeners = new Set();
      this.listeners.set(index, indexListeners);
    }
    indexListeners.add(listener);

    return () => {
      indexListeners.delete(listener);
      if (indexListeners.size === 0) this.listeners.delete(index);
    };
  }

  mount(index: number): boolean {
    if (
      this.disposed ||
      !this.isValidIndex(index) ||
      this.mounted[index] === 1
    ) {
      return false;
    }

    this.mounted[index] = 1;
    this.advanceNextIndex(index);
    this.notify(index);
    return true;
  }

  mountAround(index: number, radius: number): number {
    if (this.disposed || !this.isValidIndex(index)) return 0;

    const safeRadius = normalizeCount(radius);
    const start = Math.max(0, index - safeRadius);
    const end = Math.min(this.blockCount - 1, index + safeRadius);
    let mountedCount = 0;

    for (let current = start; current <= end; current++) {
      if (this.mount(current)) mountedCount++;
    }

    return mountedCount;
  }

  mountNextBatch(batchSize: number): number {
    if (this.disposed || this.allMounted) return 0;

    const size = normalizeCount(batchSize);
    if (size === 0) return 0;

    let mountedCount = 0;
    while (mountedCount < size && !this.allMounted) {
      const index = this.nextIndex;
      if (this.mount(index)) mountedCount++;
    }
    return mountedCount;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
  }

  private isValidIndex(index: number): boolean {
    return Number.isInteger(index) && index >= 0 && index < this.blockCount;
  }

  private advanceNextIndex(changedIndex: number): void {
    if (changedIndex !== this.nextIndex) return;
    while (
      this.nextIndex < this.blockCount &&
      this.mounted[this.nextIndex] === 1
    ) {
      this.nextIndex++;
    }
  }

  private notify(index: number): void {
    const indexListeners = this.listeners.get(index);
    if (!indexListeners) return;
    for (const listener of [...indexListeners]) listener();
  }
}

interface ProgressiveMountingOptions {
  batchSize: number;
  timeout: number;
  active: boolean;
}

export function startProgressiveMounting(
  controller: ProgressiveMountController,
  options: ProgressiveMountingOptions,
): () => void {
  if (!options.active || controller.allMounted) return noop;

  const batchSize = Math.max(1, normalizeCount(options.batchSize));
  const timeout = normalizeCount(options.timeout);
  let canceled = false;
  let idleHandle: number | null = null;
  let timerHandle: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    if (canceled || controller.allMounted) return;

    if (typeof globalThis.requestIdleCallback === "function") {
      idleHandle = globalThis.requestIdleCallback(runIdle, { timeout });
      return;
    }

    timerHandle = globalThis.setTimeout(runFallback, 16);
  };

  const runIdle = (deadline: IdleDeadline) => {
    idleHandle = null;
    if (canceled || controller.allMounted) return;

    const hasBudget = deadline.timeRemaining() > 0;
    const mountedCount = hasBudget
      ? controller.mountNextBatch(batchSize)
      : deadline.didTimeout
        ? controller.mountNextBatch(1)
        : 0;

    if ((hasBudget || deadline.didTimeout) && mountedCount === 0) return;
    schedule();
  };

  const runFallback = () => {
    timerHandle = null;
    if (canceled || controller.allMounted) return;
    if (controller.mountNextBatch(batchSize) > 0) schedule();
  };

  schedule();

  return () => {
    if (canceled) return;
    canceled = true;

    if (idleHandle !== null) {
      globalThis.cancelIdleCallback?.(idleHandle);
      idleHandle = null;
    }
    if (timerHandle !== null) {
      globalThis.clearTimeout(timerHandle);
      timerHandle = null;
    }
  };
}
