import {
  useViewActive,
  useViewState,
  readViewResource,
} from "@/modules/view-state";
import { native, type GitStatusSnapshot } from "@/modules/ai/lib/native";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  bubbleUpDirectoryStatuses,
  buildGitStatusMap,
  lookupGitStatus,
  normalizePath,
  type GitStatusCode,
} from "./gitStatusUtils";

const EMPTY = new Map<string, GitStatusCode>();

/** 文件树复用可见消费者共享的 Git 状态，不建立独立 Git 请求或监听。 */
export function useGitStatus(
  workspaceRoot: string | null,
  status: GitStatusSnapshot | null | undefined,
  enabled: boolean,
) {
  const active = useViewActive(enabled);
  const [canonicalRoot, setCanonicalRoot] = useViewState<string | null>(
    `canonicalRoot:${workspaceRoot}`,
    null,
  );
  const reqRef = useRef(0);

  useEffect(() => {
    if (!active || !workspaceRoot) return;
    const req = ++reqRef.current;
    void readViewResource(`canonical:${workspaceRoot}`, () =>
      native.canonicalize(workspaceRoot),
    )
      .then((c) => {
        if (req === reqRef.current) setCanonicalRoot(c);
      })
      .catch(() => {
        if (req === reqRef.current) setCanonicalRoot(null);
      });
    return () => {
      reqRef.current++;
    };
  }, [active, workspaceRoot]);

  const aliases = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const r of [workspaceRoot, canonicalRoot]) {
      if (!r) continue;
      const n = normalizePath(r);
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(r);
    }
    return out;
  }, [workspaceRoot, canonicalRoot]);

  // The explorer root and the snapshot's repo overlap in either nesting
  // direction; lookups still return null for paths outside the repo.
  const repoRoot0 = status ? normalizePath(status.repoRoot) : null;
  const covers =
    enabled &&
    !!status &&
    !!repoRoot0 &&
    aliases.some((a) => {
      const t = normalizePath(a);
      return (
        t === repoRoot0 ||
        t.startsWith(`${repoRoot0}/`) ||
        repoRoot0.startsWith(`${t}/`)
      );
    });

  const map = useMemo(() => {
    if (!covers || !status) return EMPTY;
    const m = buildGitStatusMap(status);
    bubbleUpDirectoryStatuses(m);
    return m;
  }, [covers, status]);
  const repoRoot = covers && status ? status.repoRoot : null;

  const lookup = useCallback(
    (path: string): GitStatusCode | null =>
      repoRoot ? lookupGitStatus(map, repoRoot, path, aliases) : null,
    [repoRoot, map, aliases],
  );

  return { lookup };
}
