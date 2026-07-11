export type PersistableChatStatus =
  | "ready"
  | "submitted"
  | "streaming"
  | "error";

export function shouldPublishSnapshot(
  status: PersistableChatStatus,
  approvalsPending: number,
  runLocked: boolean,
): boolean {
  return (
    runLocked &&
    status !== "submitted" &&
    status !== "streaming" &&
    approvalsPending === 0
  );
}

export function canChangeSession(runLocked: boolean): boolean {
  return !runLocked;
}
