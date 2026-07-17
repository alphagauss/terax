export const SIDEBAR_SECTION_HEADER_HEIGHT = 30;

export type SidebarSectionLayoutConfig = {
  id: string;
  defaultSize: number;
  minSize: number;
  defaultCollapsed?: boolean;
};

export type SidebarSectionLayoutItem = {
  size: number;
  collapsed: boolean;
};

export type SidebarSectionLayout = {
  version: 1;
  sections: Record<string, SidebarSectionLayoutItem>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeSidebarSectionLayout(
  value: unknown,
  configs: readonly SidebarSectionLayoutConfig[],
): SidebarSectionLayout {
  const storedSections =
    isRecord(value) && value.version === 1 && isRecord(value.sections)
      ? value.sections
      : {};

  const sections: Record<string, SidebarSectionLayoutItem> = {};
  for (const config of configs) {
    const stored = storedSections[config.id];
    const storedSize =
      isRecord(stored) && typeof stored.size === "number"
        ? stored.size
        : Number.NaN;
    sections[config.id] = {
      size: Number.isFinite(storedSize)
        ? Math.max(config.minSize, Math.round(storedSize))
        : Math.max(config.minSize, Math.round(config.defaultSize)),
      collapsed:
        isRecord(stored) && typeof stored.collapsed === "boolean"
          ? stored.collapsed
          : (config.defaultCollapsed ?? false),
    };
  }

  return { version: 1, sections };
}
