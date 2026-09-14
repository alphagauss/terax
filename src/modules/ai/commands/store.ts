/** 命令时间线的进程内展示缓存；事实仍由会话 JSONL 持有。 */
import { create } from "zustand";
import type { CommandDisplay } from "@/modules/ai/commands/records";
export const EMPTY_COMMANDS: readonly CommandDisplay[] = [];
export const useCommandStore = create<{
  sessions: Record<string, readonly CommandDisplay[]>;
}>(() => ({ sessions: {} }));

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
