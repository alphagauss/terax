import { beforeEach, expect, it, vi } from "vitest";
import {
  createSnapshotCache,
  readViewResource,
  resetViewCachesForTests,
} from "./cache";

beforeEach(resetViewCachesForTests);

it("淘汰非活跃 LRU，保护活跃条目并在释放后重新限制容量", () => {
  const cache = createSnapshotCache<number>(2);
  cache.set("active", 1);
  const release = cache.retain("active");
  cache.set("old", 2);
  cache.set("new", 3);
  expect(cache.get("old")).toBeUndefined();
  expect(cache.get("active")).toBe(1);
  release();
  cache.set("last", 4);
  expect(cache.get("new")).toBeUndefined();
  expect(cache.get("last")).toBe(4);
});

it("多个命名空间共用非活跃预算，超大结果不进入缓存", () => {
  const a = createSnapshotCache<string>(10);
  const b = createSnapshotCache<string>(10);
  const large = "x".repeat(6 * 1024 * 1024);
  a.set("first", large);
  b.set("second", large);
  a.get("first");
  b.set("third", large);
  expect(b.get("second")).toBeUndefined();
  expect(a.get("first")).toBe(large);
  b.set("oversized", "x".repeat(17 * 1024 * 1024));
  expect(b.get("oversized")).toBeUndefined();
});

it("快速切回复用在途读取，成功或失败后均可重新读取", async () => {
  let resolve!: (value: number) => void;
  const load = vi.fn(
    () =>
      new Promise<number>((done) => {
        resolve = done;
      }),
  );
  const first = readViewResource("file", load);
  expect(readViewResource("file", load)).toBe(first);
  resolve(1);
  await expect(first).resolves.toBe(1);
  await expect(
    readViewResource("file", () => Promise.reject(new Error("failed"))),
  ).rejects.toThrow("failed");
  await expect(
    readViewResource("file", () => Promise.resolve(2)),
  ).resolves.toBe(2);
  expect(load).toHaveBeenCalledTimes(1);
});
