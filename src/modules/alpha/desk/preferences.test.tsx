// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from "@tanstack/react-query";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  values: { "desk.leftOpen": true, workstation: { locked: true } } as Record<
    string,
    unknown
  >,
  writes: [] as {
    key: string;
    value: unknown;
    resolve: () => void;
    reject: (error: Error) => void;
  }[],
}));
vi.mock("@/lib/sharedStore", () => ({
  readSharedStore: async () => ({ ...mocks.values }),
  onSharedStoreChange: async () => () => {},
  setSharedStoreKey: (_store: string, key: string, value: unknown) =>
    new Promise<void>((resolve, reject) => {
      mocks.writes.push({
        key,
        value,
        resolve: () => {
          mocks.values[key] = value;
          resolve();
        },
        reject,
      });
    }),
}));
import { useAlphaDeskPreferences } from "@/modules/alpha/desk/preferences";
import { flushAlphaDeskWrites } from "@/modules/alpha/desk/writes";

it("慢写入期间连续切换即时生效，外部快照不覆盖待保存修改，失败后恢复权威值", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRoot(document.createElement("div"));
  let latest: ReturnType<typeof useAlphaDeskPreferences> | undefined;
  function Probe() {
    latest = useAlphaDeskPreferences();
    return null;
  }
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  try {
    onlineManager.setOnline(false);
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>,
      ),
    );
    await settle();
    expect(latest?.data?.leftOpen).toBe(true);
    await act(async () => latest?.set("leftOpen", false));
    await settle();
    expect(latest?.data?.leftOpen).toBe(false);
    await act(async () => latest?.set("leftOpen", true));
    await settle();
    expect(latest?.data?.leftOpen).toBe(true);
    expect(mocks.writes).toHaveLength(1);
    let flushed = false;
    const flushing = flushAlphaDeskWrites().then(
      () => {
        flushed = true;
      },
      (error: Error) => {
        expect(error.message).toBe("write failed");
        flushed = true;
      },
    );
    await act(async () => {
      await client.invalidateQueries({
        queryKey: ["alpha", "desk-preferences"],
      });
    });
    expect(latest?.data?.leftOpen).toBe(true);
    await act(async () => mocks.writes[0].resolve());
    await settle();
    expect(mocks.writes).toHaveLength(2);
    expect(flushed).toBe(false);
    expect(latest?.data?.leftOpen).toBe(true);
    await act(async () => mocks.writes[1].reject(new Error("write failed")));
    await settle();
    expect(latest?.data?.leftOpen).toBe(false);
    await flushing;
    expect(flushed).toBe(true);
    expect(latest?.saveError?.message).toBe("write failed");
    expect(mocks.values.workstation).toEqual({ locked: true });
    await act(async () => {
      latest?.set("right", "tasks");
      latest?.set("view", "backtests");
    });
    await settle();
    await act(async () =>
      mocks.writes[2].reject(new Error("earlier write failed")),
    );
    await settle();
    await act(async () => mocks.writes[3].resolve());
    await settle();
    expect(latest?.data?.view).toBe("backtests");
    expect(latest?.data?.right).toBeNull();
    expect(latest?.saveError?.message).toBe("earlier write failed");
  } finally {
    onlineManager.setOnline(true);
    act(() => root.unmount());
    client.clear();
  }
});
