/**
 * 本文件向辅助窗口页面提供原生窗口的真实能力。
 * 最小化和最大化能力在窗口显示前读取，避免前端维护另一份窗口配置。
 */

import { createContext, useContext } from "react";

export type AuxiliaryWindowCapabilities = {
  minimizable: boolean;
  maximizable: boolean;
};

const AuxiliaryWindowContext =
  createContext<AuxiliaryWindowCapabilities | null>(null);

/** 为当前辅助窗口页面提供只读的原生能力。 */
export function AuxiliaryWindowProvider({
  capabilities,
  children,
}: {
  capabilities: AuxiliaryWindowCapabilities;
  children: React.ReactNode;
}) {
  return (
    <AuxiliaryWindowContext.Provider value={capabilities}>
      {children}
    </AuxiliaryWindowContext.Provider>
  );
}

/** 读取当前辅助窗口的原生最小化和最大化能力。 */
export function useAuxiliaryWindowCapabilities(): AuxiliaryWindowCapabilities {
  const capabilities = useContext(AuxiliaryWindowContext);
  if (!capabilities) {
    throw new Error("辅助窗口能力只能在 AuxiliaryWindowProvider 中读取");
  }
  return capabilities;
}
