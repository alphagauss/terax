/**
 * 本文件维护模型收藏、最近使用列表和模型身份替换规则。
 * 所有列表以结构化模型引用去重，不依赖可解析的字符串 ID。
 */

import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  type ModelSettingsPatch,
  type Preferences,
  setFavoriteModels,
  setRecentModels,
} from "@/modules/settings/store";
import { type ModelRef, modelRefKey, modelRefsEqual } from "../config";

const RECENTS_MAX = 5;

type ModelReferenceState = Pick<
  Preferences,
  | "defaultModel"
  | "desktopModel"
  | "desktopModelParameterSelections"
  | "favoriteModels"
  | "recentModels"
>;

/** 生成模型移除所需的引用补丁，默认项回退但收藏和最近记录直接清理。 */
export function buildModelReferencePatch(
  state: ModelReferenceState,
  matches: (model: ModelRef) => boolean,
  replacement: ModelRef | null,
): ModelSettingsPatch {
  const patch: ModelSettingsPatch = {};
  if (state.defaultModel && matches(state.defaultModel)) {
    patch.defaultModel = replacement;
  }
  if (state.desktopModel && matches(state.desktopModel)) {
    patch.desktopModel = replacement;
    patch.desktopModelParameterSelections = {};
  }

  const replaceList = (models: ModelRef[]): ModelRef[] => {
    const seen = new Set<string>();
    const next: ModelRef[] = [];
    for (const model of models) {
      if (matches(model)) continue;
      const key = modelRefKey(model);
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(model);
    }
    return next;
  };
  if (state.favoriteModels.some(matches)) {
    patch.favoriteModels = replaceList(state.favoriteModels);
  }
  if (state.recentModels.some(matches)) {
    patch.recentModels = replaceList(state.recentModels);
  }
  return patch;
}

export async function toggleFavoriteModel(ref: ModelRef): Promise<void> {
  const current = usePreferencesStore.getState().favoriteModels;
  const next = current.some((item) => modelRefsEqual(item, ref))
    ? current.filter((item) => !modelRefsEqual(item, ref))
    : [...current, ref];
  await setFavoriteModels(next);
}

export async function pushRecentModel(ref: ModelRef): Promise<void> {
  const current = usePreferencesStore.getState().recentModels;
  const next = [
    ref,
    ...current.filter((item) => !modelRefsEqual(item, ref)),
  ].slice(0, RECENTS_MAX);
  if (
    next.length === current.length &&
    next.every((item, index) => modelRefsEqual(item, current[index]))
  ) {
    return;
  }
  await setRecentModels(next);
}
