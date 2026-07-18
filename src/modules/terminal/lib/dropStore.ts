import { create } from "zustand";

type TerminalDropState = {
  targetTerminalId: number | null;
  setTarget: (terminalId: number | null) => void;
};

export const useTerminalDropStore = create<TerminalDropState>((set) => ({
  targetTerminalId: null,
  setTarget: (terminalId) =>
    set((state) =>
      state.targetTerminalId === terminalId
        ? state
        : { targetTerminalId: terminalId },
    ),
}));
