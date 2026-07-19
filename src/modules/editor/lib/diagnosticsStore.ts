import { create } from "zustand";

export type DiagnosticCounts = { errors: number; warnings: number };

type State = {
  byPath: Record<string, DiagnosticCounts>;
  ownerByPath: Record<string, string>;
  claim: (path: string, ownerId: string) => void;
  report: (path: string, ownerId: string, counts: DiagnosticCounts) => void;
  clear: (path: string, ownerId: string) => void;
};

export const useDiagnosticsStore = create<State>((set) => ({
  byPath: {},
  ownerByPath: {},
  claim: (path, ownerId) =>
    set((s) =>
      s.ownerByPath[path] === ownerId
        ? s
        : { ownerByPath: { ...s.ownerByPath, [path]: ownerId } },
    ),
  report: (path, ownerId, counts) =>
    set((s) => {
      if (s.ownerByPath[path] !== ownerId) return s;
      const prev = s.byPath[path];
      if (
        prev &&
        prev.errors === counts.errors &&
        prev.warnings === counts.warnings
      ) {
        return s;
      }
      return { byPath: { ...s.byPath, [path]: counts } };
    }),
  clear: (path, ownerId) =>
    set((s) => {
      if (s.ownerByPath[path] !== ownerId) return s;
      const byPath = { ...s.byPath };
      const ownerByPath = { ...s.ownerByPath };
      delete byPath[path];
      delete ownerByPath[path];
      return { byPath, ownerByPath };
    }),
}));
