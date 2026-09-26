/** Alpha 展示偏好按字段写入共享存储，不覆盖其他配置。 */
import {
  onSharedStoreChange,
  readSharedStore,
  setSharedStoreKey,
} from "@/lib/sharedStore";
import {
  type AlphaChartPanelConfig,
  createDefaultAlphaChartPanelConfig,
  parseAlphaChartPanelConfig,
} from "@/modules/alpha/chart/chartPanelConfig";
import { trackAlphaDeskWrite } from "@/modules/alpha/desk/writes";
import { normalizeAlphaVtSymbol } from "@/modules/alpha/market/symbol";
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";

export type AlphaDeskPreferences = {
  symbol: string;
  view: "market" | "backtests" | "data";
  leftOpen: boolean;
  right: "security" | "tasks" | null;
  leftWidth: number;
  rightWidth: number;
  chart: AlphaChartPanelConfig;
};
const key = ["alpha", "desk-preferences"] as const;
type PreferenceChange = {
  [K in keyof AlphaDeskPreferences]: {
    field: K;
    value: AlphaDeskPreferences[K];
  };
}[keyof AlphaDeskPreferences];

/** 无效字段单独恢复默认值，实验布局不会影响业务数据。 */
export function parseAlphaDeskPreferences(
  values: Record<string, unknown>,
): AlphaDeskPreferences {
  const read = (field: string) => values[`desk.${field}`];
  const width = (field: string, fallback: number) => {
    const value = read(field);
    return typeof value === "number" && Number.isFinite(value)
      ? Math.max(200, Math.min(480, value))
      : fallback;
  };
  let chart = createDefaultAlphaChartPanelConfig();
  try {
    chart = parseAlphaChartPanelConfig(read("chart"));
  } catch {
    /* 无效实验配置使用当前默认值。 */
  }
  const symbol = read("symbol");
  const right = read("right");
  const view = read("view");
  return {
    symbol:
      typeof symbol === "string"
        ? (normalizeAlphaVtSymbol(symbol) ?? "000001.SZSE")
        : "000001.SZSE",
    view: view === "backtests" || view === "data" ? view : "market",
    leftOpen: read("leftOpen") !== false,
    right: right === "security" || right === "tasks" ? right : null,
    leftWidth: width("leftWidth", 360),
    rightWidth: width("rightWidth", 300),
    chart,
  };
}

/** 页面共享独立偏好缓存；保存只提交发生变化的字段。 */
export function useAlphaDeskPreferences() {
  const client = useQueryClient();
  const [saveError, setSaveError] = useState<Error | null>(null);
  const query = useQuery({
    queryKey: key,
    queryFn: async () =>
      parseAlphaDeskPreferences(await readSharedStore("alpha")),
    staleTime: Infinity,
    networkMode: "always",
  });
  useEffect(() => {
    let disposed = false;
    let release: (() => void) | undefined;
    void onSharedStoreChange("alpha", () =>
      client.invalidateQueries({ queryKey: key }),
    )
      .then((stop) => {
        if (disposed) stop();
        else release = stop;
      })
      .catch(console.error);
    return () => {
      disposed = true;
      release?.();
    };
  }, [client]);
  // 待保存修改单独覆盖查询快照，慢写入或跨窗口刷新不回退用户刚做的操作。
  const pending = useMutationState({
    filters: { mutationKey: key, status: "pending" },
    select: (mutation) => mutation.state.variables as PreferenceChange,
  });
  const mutation = useMutation({
    mutationKey: key,
    networkMode: "always",
    scope: { id: "alpha-desk-preferences" },
    onMutate: () => {
      setSaveError(null);
    },
    onError: setSaveError,
    mutationFn: async ({ field, value }: PreferenceChange) => {
      await setSharedStoreKey("alpha", `desk.${field}`, value);
    },
    onSuccess: async (_, { field, value }) => {
      await client.cancelQueries({ queryKey: key });
      client.setQueryData<AlphaDeskPreferences>(key, (current) =>
        current ? { ...current, [field]: value } : current,
      );
    },
    onSettled: async () => {
      if (client.isMutating({ mutationKey: key }) === 1) {
        await client.invalidateQueries({ queryKey: key });
      }
    },
  });
  const data = query.data && { ...query.data };
  if (data) {
    for (const { field, value } of pending)
      Object.assign(data, { [field]: value });
  }
  return {
    ...query,
    data,
    saveError,
    set: <K extends keyof AlphaDeskPreferences>(
      field: K,
      value: AlphaDeskPreferences[K],
    ) =>
      trackAlphaDeskWrite(
        mutation.mutateAsync({ field, value } as PreferenceChange),
      ),
  };
}
