/** 保留相同快照字段的对象身份，隔离后台校验与列表展示更新。 */
import type {
  GitPanelDiffStats,
  GitPanelSnapshot,
  GitStatusSnapshot,
} from "@/modules/ai/lib/native";

export function shareEqual<T extends object>(
  previous: T | null | undefined,
  next: T,
): T {
  if (previous === next) return previous;
  return previous &&
    Object.keys(previous).length === Object.keys(next).length &&
    Object.keys(next).every(
      (key) => previous[key as keyof T] === next[key as keyof T],
    )
    ? previous
    : next;
}

export function shareRepositorySnapshot(
  previous: GitPanelSnapshot,
  next: GitPanelSnapshot,
): GitPanelSnapshot {
  if (!next.repo || !next.status) return next;
  const sameRepo = previous.repo?.repoRoot === next.repo.repoRoot;
  const oldStatus = sameRepo ? previous.status : null;
  const files = new Map(
    oldStatus?.changedFiles.map((file) => [file.path, file]),
  );
  let changedFiles = next.status.changedFiles.map((file) =>
    shareEqual(files.get(file.path), file),
  );
  if (
    oldStatus &&
    changedFiles.length === oldStatus.changedFiles.length &&
    changedFiles.every((file, index) => file === oldStatus.changedFiles[index])
  ) {
    changedFiles = oldStatus.changedFiles;
  }
  return {
    repo: shareEqual(sameRepo ? previous.repo : null, next.repo),
    status: shareEqual<GitStatusSnapshot>(oldStatus, {
      ...next.status,
      changedFiles,
    }),
  };
}

export function shareDiffStats(
  previous: GitPanelDiffStats | null,
  next: GitPanelDiffStats,
): GitPanelDiffStats {
  const result = { ...next };
  for (const side of ["index", "worktree"] as const) {
    const value = next[side];
    if (!value) continue;
    const old = previous?.[side];
    let files = Object.fromEntries(
      Object.entries(value.files).map(([path, stats]) => [
        path,
        shareEqual(old?.files[path], stats),
      ]),
    );
    if (
      old &&
      Object.keys(files).length === Object.keys(old.files).length &&
      Object.keys(files).every((path) => files[path] === old.files[path])
    )
      files = old.files;
    result[side] = shareEqual(old, { ...value, files });
  }
  return shareEqual(previous, result);
}
