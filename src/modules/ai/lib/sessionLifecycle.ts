/**
 * 本文件定义 AI 会话何时允许提交和切换的纯状态规则。
 * 流式生成或等待审批时不得提交，避免持久化不完整 turn。
 */

export type PersistableChatStatus =
  | "ready"
  | "submitted"
  | "streaming"
  | "error";

/** 判断当前运行是否已到达可以提交新增记录的稳定状态。 */
export function shouldCommitSession(
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

/** 判断当前运行锁是否允许切换会话。 */
export function canChangeSession(runLocked: boolean): boolean {
  return !runLocked;
}
