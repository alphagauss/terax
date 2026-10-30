/** 可见 Changes 按批次加载展示统计；单个进行中请求结束后只追赶最新版本。 */
import { native, type GitPanelDiffStats } from "@/modules/ai/lib/native";
import { useEffect, useRef, useState } from "react";
import { shareDiffStats } from "./repositorySharing";

export function useRepositoryDiffStats(
  repoRoot: string | null,
  revision: number,
  active: boolean,
) {
  const [state, setState] = useState<{
    repoRoot: string;
    stats: GitPanelDiffStats;
  } | null>(null);
  const current = useRef({ repoRoot, revision, active });
  current.current = { repoRoot, revision, active };
  const inflight = useRef<Promise<void> | null>(null);
  const loaded = useRef<{ repoRoot: string; revision: number } | null>(null);

  useEffect(() => {
    if (!repoRoot) {
      loaded.current = null;
      setState(null);
      return;
    }
    if (!active) return;
    let disposed = false;
    const run = async () => {
      // 等待旧批次退出后读取最新参数，不为快速切换启动并行统计。
      while (inflight.current) await inflight.current;
      if (disposed) return;
      if (
        loaded.current?.repoRoot === repoRoot &&
        loaded.current.revision === revision
      )
        return;
      const request = native
        .gitPanelDiffStats(repoRoot)
        .then((stats) => {
          const latest = current.current;
          if (
            disposed ||
            !latest.active ||
            latest.repoRoot !== repoRoot ||
            latest.revision !== revision
          )
            return;
          loaded.current = { repoRoot, revision };
          setState((previous) => {
            const shared = shareDiffStats(
              previous?.repoRoot === repoRoot ? previous.stats : null,
              stats,
            );
            return previous?.repoRoot === repoRoot && previous.stats === shared
              ? previous
              : { repoRoot, stats: shared };
          });
        })
        .catch(() => {
          if (!disposed) setState(null);
        })
        .finally(() => {
          if (inflight.current === request) inflight.current = null;
        });
      inflight.current = request;
      await request;
    };
    // 状态提交后再加载统计，合并快速恢复和连续版本变化。
    const timer = window.setTimeout(() => void run(), 250);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [active, repoRoot, revision]);

  return state?.repoRoot === repoRoot ? state.stats : null;
}
