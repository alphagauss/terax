/**
 * 本文件定义共享业务访问宿主的调用和事件边界。
 * 终端入口在启动业务前安装宿主；桌面按需加载 Tauri 接入，避免无界面代码加载窗口模块。
 */

import type { WorkspaceEnv } from "@/modules/workspace";

export type NativeChannel<T> = { onmessage: (event: T) => void };

export type NativeHost = {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  channel: <T>() => NativeChannel<T>;
  workspace: () => WorkspaceEnv;
};

let host: Promise<NativeHost> | undefined;

/** 在业务启动前选择进程宿主，运行期间不能切换后端。 */
export function installNativeHost(value: NativeHost): void {
  if (host) throw new Error("Native host is already initialized");
  host = Promise.resolve(value);
}

/** 桌面首次使用时才加载 Tauri，终端入口始终提供自己的宿主。 */
export function getNativeHost(): Promise<NativeHost> {
  host ??= import("@/lib/tauriHost").then((module) => module.tauriHost);
  return host;
}

/** 调用宿主的封闭原生操作，保持既有参数和错误语义。 */
export async function invokeNative<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return (await getNativeHost()).invoke<T>(command, args);
}

/** 给工作区操作注入宿主的实际环境，业务不能从活动标签推导执行位置。 */
export async function invokeWorkspace<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const current = await getNativeHost();
  const workspace = current.workspace();
  const request = args.request;
  return current.invoke<T>(
    command,
    request && typeof request === "object"
      ? { ...args, request: { ...request, workspace } }
      : { ...args, workspace },
  );
}
