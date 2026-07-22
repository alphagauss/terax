/**
 * 本文件实现 SSH 配置分组的排序、归组和名称校验。
 * 默认分组使用稳定 ID 且不持久化名称，未知分组引用统一回落到默认分组。
 */

import type { SshGroup, SshProfile } from "@/modules/remote/types";

export const DEFAULT_SSH_GROUP_ID = "default";

export type SshProfileGroup = {
  id: string;
  name: string | null;
  profiles: SshProfile[];
};

export type GroupNameIssue = "required" | "duplicate";

/** 按默认组优先、组名和配置名升序生成稳定的展示结构。 */
export function groupSshProfiles(
  groups: SshGroup[],
  profiles: SshProfile[],
): SshProfileGroup[] {
  const orderedGroups = [...groups].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const knownGroupIds = new Set(orderedGroups.map((group) => group.id));
  const buckets = new Map<string, SshProfile[]>([[DEFAULT_SSH_GROUP_ID, []]]);
  for (const group of orderedGroups) buckets.set(group.id, []);

  for (const profile of profiles) {
    const groupId = knownGroupIds.has(profile.groupId)
      ? profile.groupId
      : DEFAULT_SSH_GROUP_ID;
    buckets.get(groupId)?.push(profile);
  }
  for (const bucket of buckets.values()) {
    bucket.sort((left, right) => left.name.localeCompare(right.name));
  }

  return [
    {
      id: DEFAULT_SSH_GROUP_ID,
      name: null,
      profiles: buckets.get(DEFAULT_SSH_GROUP_ID) ?? [],
    },
    ...orderedGroups.map((group) => ({
      id: group.id,
      name: group.name,
      profiles: buckets.get(group.id) ?? [],
    })),
  ];
}

/** 校验分组名称非空且与其他分组名称不重复。 */
export function groupNameIssue(
  name: string,
  groups: SshGroup[],
  excludedId?: string,
): GroupNameIssue | null {
  const normalized = name.trim();
  if (!normalized) return "required";
  const duplicate = groups.some(
    (group) =>
      group.id !== excludedId &&
      group.name.localeCompare(normalized, undefined, {
        sensitivity: "base",
      }) === 0,
  );
  return duplicate ? "duplicate" : null;
}
