/**
 * 本文件负责解析和校验 Alpha 工作台布局。
 * 结构校验之外还锁定 panel/grid 对应、24 列几何、面板元数据和纯 JSON 配置边界。
 */

import {
  ALPHA_WORKSTATION_GRID_COLUMNS,
  ALPHA_WORKSTATION_SCHEMA_VERSION,
  normalizeAlphaVtSymbol,
  type AlphaPanelConfig,
  type AlphaGridItem,
  type AlphaPanelInstance,
  type AlphaWorkstationLayout,
} from "@/modules/alpha/workstation/model";
import type { AlphaPanelRegistry } from "@/modules/alpha/workstation/registry";
import { z } from "zod";

const symbolBindingSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("follow") }).strict(),
  z
    .object({
      mode: z.literal("pinned"),
      vtSymbol: z
        .string()
        .transform((value) => normalizeAlphaVtSymbol(value))
        .pipe(z.string()),
    })
    .strict(),
]);

const panelConfigSchema = z.record(z.string(), z.json());

const panelSchema = z
  .object({
    id: z.string().trim().min(1),
    type: z.string().trim().min(1),
    binding: symbolBindingSchema,
    config: z.record(z.string(), z.unknown()),
  })
  .strict();

const gridItemSchema = z
  .object({
    panelId: z.string().trim().min(1),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    w: z.number().int().positive(),
    h: z.number().int().positive(),
  })
  .strict();

const layoutSchema = z
  .object({
    schemaVersion: z.literal(ALPHA_WORKSTATION_SCHEMA_VERSION),
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    panels: z.array(panelSchema),
    grid: z.array(gridItemSchema),
  })
  .strict();

export type AlphaWorkstationLayoutIssueCode =
  | "schema-version"
  | "structure"
  | "duplicate-panel-id"
  | "duplicate-grid-panel-id"
  | "missing-grid-item"
  | "orphan-grid-item"
  | "grid-bounds"
  | "panel-min-size"
  | "panel-overlap"
  | "singleton"
  | "invalid-config";

export type AlphaWorkstationLayoutIssue = {
  code: AlphaWorkstationLayoutIssueCode;
  panelId?: string;
};

export type AlphaWorkstationLayoutResult =
  | { ok: true; layout: AlphaWorkstationLayout }
  | { ok: false; issues: AlphaWorkstationLayoutIssue[] };

/**
 * 更新一个已注册面板的配置。
 *
 * descriptor 在写入前完成面板专用归一化；无效配置、未知面板或未变化的值保持原布局引用。
 */
export function updateAlphaPanelConfig(
  layout: AlphaWorkstationLayout,
  panelId: string,
  value: AlphaPanelConfig,
  registry: AlphaPanelRegistry,
): AlphaWorkstationLayout {
  const index = layout.panels.findIndex((panel) => panel.id === panelId);
  if (index < 0) return layout;
  const panel = layout.panels[index];
  const descriptor = registry.get(panel.type);
  if (!descriptor) return layout;

  try {
    const config = panelConfigSchema.parse(descriptor.validateConfig(value));
    if (JSON.stringify(config) === JSON.stringify(panel.config)) return layout;
    const panels = [...layout.panels];
    panels[index] = { ...panel, config };
    return { ...layout, panels };
  } catch {
    return layout;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function overlaps(left: AlphaGridItem, right: AlphaGridItem): boolean {
  return (
    left.x < right.x + right.w &&
    right.x < left.x + left.w &&
    left.y < right.y + right.h &&
    right.y < left.y + left.h
  );
}

function duplicateIds(values: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return duplicates;
}

/**
 * 解析并校验工作台布局。
 *
 * 未知面板类型保留给挂载层显示可恢复占位；已注册面板的配置会经过 descriptor 归一化。
 */
export function parseAlphaWorkstationLayout(
  value: unknown,
  registry: AlphaPanelRegistry,
): AlphaWorkstationLayoutResult {
  if (
    isRecord(value) &&
    "schemaVersion" in value &&
    value.schemaVersion !== ALPHA_WORKSTATION_SCHEMA_VERSION
  ) {
    return { ok: false, issues: [{ code: "schema-version" }] };
  }

  const parsed = layoutSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, issues: [{ code: "structure" }] };
  }

  const layout = parsed.data;
  const issues: AlphaWorkstationLayoutIssue[] = [];
  const duplicatePanelIds = duplicateIds(
    layout.panels.map((panel) => panel.id),
  );
  const duplicateGridIds = duplicateIds(
    layout.grid.map((item) => item.panelId),
  );
  for (const panelId of duplicatePanelIds) {
    issues.push({ code: "duplicate-panel-id", panelId });
  }
  for (const panelId of duplicateGridIds) {
    issues.push({ code: "duplicate-grid-panel-id", panelId });
  }

  const panelIds = new Set(layout.panels.map((panel) => panel.id));
  const gridIds = new Set(layout.grid.map((item) => item.panelId));
  for (const panelId of panelIds) {
    if (!gridIds.has(panelId)) {
      issues.push({ code: "missing-grid-item", panelId });
    }
  }
  for (const panelId of gridIds) {
    if (!panelIds.has(panelId)) {
      issues.push({ code: "orphan-grid-item", panelId });
    }
  }

  const panelsById = new Map(
    layout.panels.map((panel) => [panel.id, panel] as const),
  );
  for (const item of layout.grid) {
    if (item.x + item.w > ALPHA_WORKSTATION_GRID_COLUMNS) {
      issues.push({ code: "grid-bounds", panelId: item.panelId });
    }
    const descriptor = registry.get(panelsById.get(item.panelId)?.type ?? "");
    if (
      descriptor &&
      (item.w < descriptor.defaultSize.minW ||
        item.h < descriptor.defaultSize.minH)
    ) {
      issues.push({ code: "panel-min-size", panelId: item.panelId });
    }
  }

  for (let left = 0; left < layout.grid.length; left += 1) {
    for (let right = left + 1; right < layout.grid.length; right += 1) {
      if (overlaps(layout.grid[left], layout.grid[right])) {
        issues.push({
          code: "panel-overlap",
          panelId: layout.grid[right].panelId,
        });
      }
    }
  }

  for (const descriptor of registry.list()) {
    const instances = layout.panels.filter(
      (panel) => panel.type === descriptor.type,
    );
    if (descriptor.singleton && instances.length > 1) {
      issues.push({ code: "singleton", panelId: instances[1].id });
    }
  }

  const panels: AlphaPanelInstance[] = [];
  for (const panel of layout.panels) {
    const jsonConfig = panelConfigSchema.safeParse(panel.config);
    if (!jsonConfig.success) {
      issues.push({ code: "invalid-config", panelId: panel.id });
      continue;
    }
    const descriptor = registry.get(panel.type);
    if (!descriptor) {
      panels.push({ ...panel, config: jsonConfig.data });
      continue;
    }
    try {
      const config = panelConfigSchema.parse(
        descriptor.validateConfig(jsonConfig.data),
      );
      panels.push({ ...panel, config });
    } catch {
      issues.push({ code: "invalid-config", panelId: panel.id });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    layout: { ...layout, panels },
  };
}
