/**
 * 本文件定义 Alpha 工作台的内置布局模板和实例化入口。
 * 模板只描述初始面板与 24 列坐标，每次应用都会生成新的布局和面板身份。
 */

import { createDefaultAlphaChartPanelConfig } from "@/modules/alpha/workstation/chartPanelConfig";
import {
  ALPHA_WORKSTATION_SCHEMA_VERSION,
  ALPHA_WORKSTATION_STATE_SCHEMA_VERSION,
  type AlphaGridItem,
  type AlphaPanelInstance,
  type AlphaWorkstationLayout,
  type AlphaWorkstationState,
} from "@/modules/alpha/workstation/model";

export const ALPHA_DEFAULT_MAIN_SYMBOL = "000001.SZSE";

type TemplatePanel = {
  panel: Omit<AlphaPanelInstance, "id">;
  grid: Omit<AlphaGridItem, "panelId">;
};

export type AlphaWorkstationTemplate = {
  id: string;
  titleKey: string;
  descriptionKey: string;
  panels: readonly TemplatePanel[];
};

export const ALPHA_WORKSTATION_TEMPLATES = [
  {
    id: "single-chart",
    titleKey: "workstation.templates.singleChart.title",
    descriptionKey: "workstation.templates.singleChart.description",
    panels: [
      {
        panel: {
          type: "chart",
          binding: { mode: "follow" },
          config: createDefaultAlphaChartPanelConfig(),
        },
        grid: { x: 0, y: 0, w: 24, h: 16 },
      },
    ],
  },
  {
    id: "comparison",
    titleKey: "workstation.templates.comparison.title",
    descriptionKey: "workstation.templates.comparison.description",
    panels: [
      {
        panel: {
          type: "chart",
          binding: { mode: "follow" },
          config: createDefaultAlphaChartPanelConfig(),
        },
        grid: { x: 0, y: 0, w: 12, h: 16 },
      },
      {
        panel: {
          type: "chart",
          binding: { mode: "pinned", vtSymbol: "600000.SSE" },
          config: createDefaultAlphaChartPanelConfig(),
        },
        grid: { x: 12, y: 0, w: 12, h: 16 },
      },
    ],
  },
] as const satisfies readonly AlphaWorkstationTemplate[];

type IdFactory = (scope: "layout" | "panel") => string;

function createId(scope: "layout" | "panel"): string {
  return `${scope}-${crypto.randomUUID()}`;
}

/** 从内置模板创建独立布局，不复用模板中的任何运行时身份。 */
export function instantiateAlphaWorkstationTemplate(
  templateId: string,
  idFactory: IdFactory = createId,
): AlphaWorkstationLayout {
  const template = ALPHA_WORKSTATION_TEMPLATES.find(
    (candidate) => candidate.id === templateId,
  );
  if (!template)
    throw new Error(`Unknown Alpha workstation template: ${templateId}`);

  const instances = template.panels.map(({ panel, grid }) => {
    const panelId = idFactory("panel");
    return {
      panel: { id: panelId, ...structuredClone(panel) },
      grid: { panelId, ...grid },
    };
  });
  return {
    schemaVersion: ALPHA_WORKSTATION_SCHEMA_VERSION,
    id: idFactory("layout"),
    name: template.id,
    panels: instances.map((instance) => instance.panel),
    grid: instances.map((instance) => instance.grid),
  };
}

/** 创建首次打开工作台时使用的默认共享状态。 */
export function createDefaultAlphaWorkstationState(): AlphaWorkstationState {
  return {
    schemaVersion: ALPHA_WORKSTATION_STATE_SCHEMA_VERSION,
    mainSymbol: ALPHA_DEFAULT_MAIN_SYMBOL,
    locked: false,
    layout: instantiateAlphaWorkstationTemplate("single-chart"),
  };
}
