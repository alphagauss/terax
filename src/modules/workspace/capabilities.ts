/** 工作区状态栏共用的原生能力报告协议。 */

export type CapabilityState =
  | "unknown"
  | "checking"
  | "ready"
  | "fallback"
  | "unavailable";

export type CommandCapability = {
  id: string;
  command: string;
  state: "ready" | "missing" | "unsupported";
  detail: string | null;
};

export type FeatureCapability = {
  id: string;
  state: CapabilityState;
  backend: string | null;
  commands: string[];
};

export type CapabilityReport = {
  state: CapabilityState;
  checkedAt: number | null;
  commands: CommandCapability[];
  features: FeatureCapability[];
};
