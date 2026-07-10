export type PersistableChatStatus =
  | "ready"
  | "submitted"
  | "streaming"
  | "error";

export function shouldPublishSnapshot(
  status: PersistableChatStatus,
  approvalsPending: number,
  runDirty: boolean,
): boolean {
  return (
    runDirty &&
    status !== "submitted" &&
    status !== "streaming" &&
    approvalsPending === 0
  );
}
