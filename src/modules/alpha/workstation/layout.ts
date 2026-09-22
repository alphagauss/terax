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
    collapsed: z.boolean().optional(),
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
  | "singleton"
  | "invalid-config";

export type AlphaWorkstationLayoutIssue = {
  code: AlphaWorkstationLayoutIssueCode;
  panelId?: string;
};

export type AlphaWorkstationLayoutResult =
  | { ok: true; layout: AlphaWorkstationLayout }
  | { ok: false; issues: AlphaWorkstationLayoutIssue[] };

/** 只调整层级，不改变菜单顺序、几何或面板身份。 */
export function raiseAlphaPanel(
  layout: AlphaWorkstationLayout,
  panelId: string,
): AlphaWorkstationLayout {
  const item = layout.grid.find((candidate) => candidate.panelId === panelId);
  if (!item || layout.grid[layout.grid.length - 1] === item) return layout;
  return {
    ...layout,
    grid: [...layout.grid.filter((candidate) => candidate !== item), item],
  };
}

/** 折叠只改变展示状态，展开在原位置恢复保存的高度并置顶。 */
export function toggleAlphaPanelCollapsed(
  layout: AlphaWorkstationLayout,
  panelId: string,
): AlphaWorkstationLayout {
  const panel = layout.panels.find((candidate) => candidate.id === panelId);
  if (!panel) return layout;
  return {
    ...raiseAlphaPanel(layout, panelId),
    panels: layout.panels.map((candidate) =>
      candidate === panel
        ? { ...panel, collapsed: !panel.collapsed }
        : candidate,
    ),
  };
}

/** 网格返回的是当前占位；收起时拖动不得覆盖展开高度或当前层级。 */
export function updateAlphaPanelGeometry(
  layout: AlphaWorkstationLayout,
  next: AlphaGridItem,
): AlphaWorkstationLayout {
  const index = layout.grid.findIndex((item) => item.panelId === next.panelId);
  if (index < 0) return layout;
  const current = layout.grid[index];
  const collapsed = layout.panels.find(
    (panel) => panel.id === next.panelId,
  )?.collapsed;
  const h = collapsed ? current.h : next.h;
  if (
    current.x === next.x &&
    current.y === next.y &&
    current.w === next.w &&
    current.h === h
  )
    return layout;
  const grid = [...layout.grid];
  grid[index] = { ...next, h };
  return { ...layout, grid };
}

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
