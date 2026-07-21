import type { TunnelEvent, TunnelInfo } from "./types";

export function applyTunnelEvent(
  current: TunnelInfo[],
  event: TunnelEvent,
): TunnelInfo[] {
  const tunnel = event.tunnel;
  if (!tunnel) return current;
  if (event.kind === "stopped") {
    return current.filter((item) => item.id !== tunnel.id);
  }
  return [...current.filter((item) => item.id !== tunnel.id), tunnel].sort(
    (left, right) => left.id - right.id,
  );
}

export function tunnelEventError(event: TunnelEvent): string | null {
  if (event.kind !== "failed") return null;
  return event.message ?? event.tunnel?.error ?? null;
}
