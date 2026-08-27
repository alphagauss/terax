/**
 * 本文件定义 Alpha 工作台可持久化状态的解析和标的解析规则。
 * 状态只包含纯 JSON 数据，布局语义继续由布局解析器和 Panel Registry 校验。
 */

import {
  ALPHA_WORKSTATION_STATE_SCHEMA_VERSION,
  normalizeAlphaVtSymbol,
  type AlphaSymbolBinding,
  type AlphaWorkstationState,
} from "@/modules/alpha/workstation/model";
import { parseAlphaWorkstationLayout } from "@/modules/alpha/workstation/layout";
import type { AlphaPanelRegistry } from "@/modules/alpha/workstation/registry";
import { z } from "zod";

const workstationStateSchema = z
  .object({
    schemaVersion: z.literal(ALPHA_WORKSTATION_STATE_SCHEMA_VERSION),
    mainSymbol: z
      .string()
      .transform((value) => normalizeAlphaVtSymbol(value))
      .pipe(z.string()),
    locked: z.boolean(),
    layout: z.unknown(),
  })
  .strict();

/** 解析共享配置中的工作台状态，无效或未知版本返回 `null`。 */
export function parseAlphaWorkstationState(
  value: unknown,
  registry: AlphaPanelRegistry,
): AlphaWorkstationState | null {
  const parsed = workstationStateSchema.safeParse(value);
  if (!parsed.success) return null;
  const layout = parseAlphaWorkstationLayout(parsed.data.layout, registry);
  if (!layout.ok) return null;
  return { ...parsed.data, layout: layout.layout };
}

/** 根据面板绑定方式解析实际使用的标的。 */
export function resolveAlphaPanelSymbol(
  binding: AlphaSymbolBinding,
  mainSymbol: string,
): string {
  return binding.mode === "follow" ? mainSymbol : binding.vtSymbol;
}
