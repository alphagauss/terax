/**
 * 本文件定义 Alpha 工作台可持久化状态的迁移、解析和标的解析规则。
 * 状态只包含纯 JSON 配置，同步运行时事件不会进入迁移或持久化边界。
 */

import {
  ALPHA_WORKSTATION_STATE_SCHEMA_VERSION,
  DEFAULT_ALPHA_CHART_SYNC_CONFIG,
  normalizeAlphaVtSymbol,
  type AlphaSymbolBinding,
  type AlphaWorkstationState,
} from "@/modules/alpha/workstation/model";
import { parseAlphaWorkstationLayout } from "@/modules/alpha/workstation/layout";
import type { AlphaPanelRegistry } from "@/modules/alpha/workstation/registry";
import { z } from "zod";

const workstationStateV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    mainSymbol: z
      .string()
      .transform((value) => normalizeAlphaVtSymbol(value))
      .pipe(z.string()),
    locked: z.boolean(),
    layout: z.unknown(),
  })
  .strict();

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

/** 将版本 1 状态纯迁移为版本 2，并显式补入关闭的图表同步配置。 */
export function migrateAlphaWorkstationStateV1(
  value: unknown,
  registry: AlphaPanelRegistry,
): AlphaWorkstationState | null {
  const parsed = workstationStateV1Schema.safeParse(value);
  if (!parsed.success) return null;
  const layout = parseAlphaWorkstationLayout(parsed.data.layout, registry);
  if (!layout.ok) return null;
  return {
    schemaVersion: ALPHA_WORKSTATION_STATE_SCHEMA_VERSION,
    mainSymbol: parsed.data.mainSymbol,
    locked: parsed.data.locked,
    chartSync: { ...DEFAULT_ALPHA_CHART_SYNC_CONFIG },
    layout: layout.layout,
  };
}

/** 解析共享配置中的当前或可迁移工作台状态，无效或未知版本返回 `null`。 */
export function parseAlphaWorkstationState(
  value: unknown,
  registry: AlphaPanelRegistry,
): AlphaWorkstationState | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion === 1
  ) {
    return migrateAlphaWorkstationStateV1(value, registry);
  }
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
