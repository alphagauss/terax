/**
 * 本文件实现 Alpha 工作台面板注册表。
 * 注册表集中管理面板元数据、配置边界和懒加载组件，并保证每种面板的组件身份稳定。
 */

import type {
  AlphaPanelCategory,
  AlphaPanelConfig,
  AlphaPanelProps,
  AlphaPanelSize,
} from "@/modules/alpha/workstation/model";
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

export type AlphaPanelDescriptor = {
  type: string;
  titleKey: string;
  category: AlphaPanelCategory;
  singleton: boolean;
  pinnable: boolean;
  defaultSize: AlphaPanelSize;
  createDefaultConfig(): AlphaPanelConfig;
  validateConfig(value: unknown): AlphaPanelConfig;
  load(): Promise<{ default: ComponentType<AlphaPanelProps> }>;
};

export type AlphaRegisteredPanelDescriptor = Omit<
  AlphaPanelDescriptor,
  "load"
> & {
  Component: LazyExoticComponent<ComponentType<AlphaPanelProps>>;
};

export type AlphaPanelRegistry = Readonly<{
  get(type: string): AlphaRegisteredPanelDescriptor | undefined;
  list(): readonly AlphaRegisteredPanelDescriptor[];
}>;

function assertPanelSize(type: string, size: AlphaPanelSize): void {
  const values = [size.w, size.h, size.minW, size.minH];
  if (
    values.some((value) => !Number.isInteger(value) || value <= 0) ||
    size.minW > size.w ||
    size.minH > size.h
  ) {
    throw new Error(`Invalid default size for Alpha panel type: ${type}`);
  }
}

/**
 * 创建不可变的面板注册表。
 *
 * `React.lazy` 在注册时创建但不会执行 loader，因此枚举面板元数据不会加载面板实现。
 */
export function createAlphaPanelRegistry(
  descriptors: readonly AlphaPanelDescriptor[],
): AlphaPanelRegistry {
  const byType = new Map<string, AlphaRegisteredPanelDescriptor>();
  const registered = descriptors.map((descriptor) => {
    const type = descriptor.type.trim();
    const titleKey = descriptor.titleKey.trim();
    if (!type || !titleKey) {
      throw new Error("Alpha panel type and title key must not be empty");
    }
    if (type !== descriptor.type || titleKey !== descriptor.titleKey) {
      throw new Error(
        "Alpha panel type and title key must not have surrounding whitespace",
      );
    }
    if (byType.has(descriptor.type)) {
      throw new Error(`Duplicate Alpha panel type: ${descriptor.type}`);
    }
    assertPanelSize(descriptor.type, descriptor.defaultSize);
    const { load, ...metadata } = descriptor;
    const entry: AlphaRegisteredPanelDescriptor = Object.freeze({
      ...metadata,
      defaultSize: Object.freeze({ ...descriptor.defaultSize }),
      Component: lazy(load),
    });
    byType.set(entry.type, entry);
    return entry;
  });
  const entries = Object.freeze(registered);

  return Object.freeze({
    get: (type: string) => byType.get(type),
    list: () => entries,
  });
}
