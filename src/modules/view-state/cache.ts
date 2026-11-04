/** 窗口内可丢弃快照的有限 LRU；各业务限制条目数，并共同受内存预算约束。 */

type Entry = { bytes: number; pinned: () => boolean; remove: () => void };
const budget = 32 * 1024 * 1024;
const recency = new Set<Entry>();
let used = 0;

function trimBudget() {
  for (const entry of recency) {
    if (used <= budget) break;
    if (!entry.pinned()) entry.remove();
  }
}

/** 按 UTF-16 展示数据体积估算缓存预算，不承诺精确计算 JS 堆占用。 */
export function snapshotBytes(value: unknown): number {
  return (
    2 *
    (JSON.stringify(value, (_key, item) =>
      item instanceof Map ? [...item] : item instanceof Set ? [...item] : item,
    )?.length ?? 0)
  );
}

/** 创建业务命名空间，淘汰缓存不会销毁仍挂载的视图或业务实例。 */
export function createSnapshotCache<T>(limit: number) {
  const entries = new Map<string, { value: T; entry: Entry }>();
  const owners = new Map<string, number>();
  const remove = (key: string) => {
    const item = entries.get(key);
    if (!item) return;
    entries.delete(key);
    recency.delete(item.entry);
    if (!item.entry.pinned()) used -= item.entry.bytes;
  };
  const trim = () => {
    for (const [key, item] of entries) {
      if (entries.size <= limit) break;
      if (!item.entry.pinned()) remove(key);
    }
    trimBudget();
  };
  return {
    get(key: string): T | undefined {
      const item = entries.get(key);
      if (!item) return;
      entries.delete(key);
      entries.set(key, item);
      recency.delete(item.entry);
      recency.add(item.entry);
      return item.value;
    },
    set(key: string, value: T, bytes = snapshotBytes(value)) {
      remove(key);
      if (bytes > budget) return;
      const entry = {
        bytes,
        pinned: () => owners.has(key),
        remove: () => remove(key),
      };
      entries.set(key, { value, entry });
      recency.add(entry);
      if (!entry.pinned()) used += bytes;
      trim();
    },
    /** 活跃视图的数据由实例拥有，不占非活跃缓存预算；最后一个消费者离开后才进入 LRU。 */
    retain(key: string): () => void {
      const count = owners.get(key) ?? 0;
      owners.set(key, count + 1);
      if (count === 0) used -= entries.get(key)?.entry.bytes ?? 0;
      return () => {
        const count = owners.get(key) ?? 0;
        if (count > 1) owners.set(key, count - 1);
        else {
          owners.delete(key);
          used += entries.get(key)?.entry.bytes ?? 0;
          trim();
        }
      };
    },
    delete: remove,
    prune(keep: (key: string) => boolean) {
      for (const key of entries.keys()) if (!keep(key)) remove(key);
    },
    clear() {
      for (const key of entries.keys()) remove(key);
    },
  };
}

const requests = new Map<string, Promise<unknown>>();

/** 测试之间隔离窗口级快照和在途请求。 */
export function resetViewCachesForTests() {
  for (const entry of [...recency]) entry.remove();
  requests.clear();
}

/** 快速切回或多个视图读取同一资源时复用在途请求，不重启无法取消的原生读取。 */
export function readViewResource<T>(
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const existing = requests.get(key);
  if (existing) return existing as Promise<T>;
  const task = load().finally(() => {
    if (requests.get(key) === task) requests.delete(key);
  });
  requests.set(key, task);
  return task;
}
