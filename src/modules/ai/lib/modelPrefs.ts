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
import {
  DEFAULT_AUTOCOMPLETE_MODEL_REF,
  DEFAULT_MODEL_REF,
  type ModelRef,
  modelRefKey,
  modelRefsEqual,
} from "../config";

const RECENTS_MAX = 5;

type ModelReferenceState = Pick<
  Preferences,
  | "defaultModel"
  | "defaultSubagentModel"
  | "autocompleteModel"
  | "favoriteModels"
  | "recentModels"
>;

/** 生成模型身份变更所需的引用补丁，并保持收藏与最近列表无重复项。 */
export function buildModelReferencePatch(
  state: ModelReferenceState,
  matches: (model: ModelRef) => boolean,
  replacement: ModelRef | null,
): ModelSettingsPatch {
  const patch: ModelSettingsPatch = {};
  if (matches(state.defaultModel)) {
    patch.defaultModel = replacement ?? DEFAULT_MODEL_REF;
  }
  if (state.defaultSubagentModel && matches(state.defaultSubagentModel)) {
    patch.defaultSubagentModel = replacement;
  }
  if (matches(state.autocompleteModel)) {
    patch.autocompleteModel = replacement ?? DEFAULT_AUTOCOMPLETE_MODEL_REF;
  }

  const replaceList = (models: ModelRef[]): ModelRef[] => {
    const seen = new Set<string>();
    const next: ModelRef[] = [];
    for (const model of models) {
      const candidate = matches(model) ? replacement : model;
      if (!candidate) continue;
      const key = modelRefKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(candidate);
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
