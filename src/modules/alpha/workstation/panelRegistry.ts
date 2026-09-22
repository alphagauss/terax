/**
 * 本文件注册 Alpha 工作台当前可用的真实业务面板。
 * 首期只注册公共金融图表，后续面板必须在具备真实领域协议后再加入。
 */

import {
  createDefaultAlphaChartPanelConfig,
  parseAlphaChartPanelConfig,
} from "@/modules/alpha/workstation/chartPanelConfig";
import { createAlphaPanelRegistry } from "@/modules/alpha/workstation/registry";

export const alphaPanelRegistry = createAlphaPanelRegistry([
  {
    type: "chart",
    titleKey: "workstation.panels.chart",
    category: "market",
    singleton: false,
    pinnable: true,
    defaultSize: { w: 53, h: 29, minW: 20, minH: 19 },
    createDefaultConfig: createDefaultAlphaChartPanelConfig,
    validateConfig: parseAlphaChartPanelConfig,
    load: () =>
      import("@/modules/alpha/workstation/components/AlphaChartPanel"),
  },
]);
