import { create } from "zustand";

export type TerminalDropSurface = "pane" | "input";

type TerminalDropState = {
  targetTerminalId: number | null;
  targetSurface: TerminalDropSurface;
  setTarget: (terminalId: number | null, surface?: TerminalDropSurface) => void;
};

export const useTerminalDropStore = create<TerminalDropState>((set) => ({
  targetTerminalId: null,
  targetSurface: "pane",
  setTarget: (terminalId, surface = "pane") =>
    set((state) =>
      state.targetTerminalId === terminalId && state.targetSurface === surface
        ? state
        : { targetTerminalId: terminalId, targetSurface: surface },
    ),
}));
