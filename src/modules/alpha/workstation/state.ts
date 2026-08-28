/**
 * 本文件定义 Alpha 工作台可持久化状态的解析和标的解析规则。
 * 状态只接受当前开发版本的纯 JSON 配置，同步运行时事件不会进入持久化边界。
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

const chartSyncSchema = z
  .object({
    groupId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9._-]+$/),
    rangeEnabled: z.boolean(),
    crosshairEnabled: z.boolean(),
  })
  .strict();

const workstationStateSchema = z
  .object({
    schemaVersion: z.literal(ALPHA_WORKSTATION_STATE_SCHEMA_VERSION),
    mainSymbol: z
      .string()
      .transform((value) => normalizeAlphaVtSymbol(value))
      .pipe(z.string()),
    locked: z.boolean(),
    chartSync: chartSyncSchema,
    layout: z.unknown(),
  })
  .strict();

/** 解析共享配置中的当前工作台状态，无效或非当前版本返回 `null`。 */
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
