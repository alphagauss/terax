/** 命令时间线与会话级执行占用；取消不依赖 UI，持久化事实仍由 JSONL 持有。 */
import { create } from "zustand";
import type { CommandDisplay } from "@/modules/ai/commands/records";
export const EMPTY_COMMANDS: readonly CommandDisplay[] = [];
export const useCommandStore = create<{
  sessions: Record<string, readonly CommandDisplay[]>;
  active: Record<string, AbortController>;
}>(() => ({ sessions: {}, active: {} }));

export function cancelSessionCommand(id: string): void {
  useCommandStore.getState().active[id]?.abort();
}

export function isCommandActive(id: string): boolean {
  return Boolean(useCommandStore.getState().active[id]);
}

export function setSessionCommands(
  id: string,
  commands: readonly CommandDisplay[],
): void {
  useCommandStore.setState((state) => ({
    sessions: { ...state.sessions, [id]: commands },
  }));
}
export function clearSessionCommands(id: string): void {
  useCommandStore.setState((state) => {
    const sessions = { ...state.sessions };
    delete sessions[id];
    return { sessions };
  });
}
export function updateCommand(id: string, command: CommandDisplay): void {
  const current = useCommandStore.getState().sessions[id] ?? [];
  setSessionCommands(
    id,
    current.some((item) => item.id === command.id)
      ? current.map((item) => (item.id === command.id ? command : item))
      : [...current, command],
  );
}
