/** 跟踪三栏偏好保存，包括尚未进入原生存储的排队修改，供关闭应用时等待。 */
const pending = new Set<Promise<void>>();

export function trackAlphaDeskWrite(operation: Promise<void>): void {
  pending.add(operation);
  const remove = () => {
    pending.delete(operation);
  };
  // 错误由页面的 mutation 状态展示，此处仅负责关闭屏障和拒绝处理。
  void operation.then(remove, remove);
}

export async function flushAlphaDeskWrites(): Promise<void> {
  while (pending.size > 0) await Promise.all(pending);
}
