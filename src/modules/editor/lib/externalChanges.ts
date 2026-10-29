/** 将磁盘刷新转换为最小文本变更，避免历史记录保留旧全文并保持阅读位置。 */
import { EditorState, Transaction } from "@codemirror/state";
import { ExternalChange } from "@uiw/react-codemirror";

export const externalChanges = EditorState.transactionFilter.of(
  (transaction) => {
    if (!transaction.annotation(ExternalChange) || !transaction.docChanged) {
      return transaction;
    }
    const before = transaction.startState.doc.toString();
    const after = transaction.newDoc.toString();
    let from = 0;
    let to = before.length;
    let end = after.length;
    // 大日志通常只有尾部变化，先批量跳过相同片段，避免逐字符扫描全文阻塞界面。
    const block = 4096;
    while (
      from + block <= Math.min(to, end) &&
      before.slice(from, from + block) === after.slice(from, from + block)
    ) {
      from += block;
    }
    while (
      from < to &&
      from < end &&
      before.charCodeAt(from) === after.charCodeAt(from)
    )
      from++;
    while (
      to - block >= from &&
      end - block >= from &&
      before.slice(to - block, to) === after.slice(end - block, end)
    ) {
      to -= block;
      end -= block;
    }
    while (
      to > from &&
      end > from &&
      before.charCodeAt(to - 1) === after.charCodeAt(end - 1)
    ) {
      to--;
      end--;
    }
    // 复制变化片段，避免 V8 子串间接引用整份刷新正文，让新增行继续保留所有旧全文。
    const insert = JSON.parse(JSON.stringify(after.slice(from, end))) as string;
    return {
      changes: { from, to, insert },
      effects: transaction.effects,
      annotations: [
        ExternalChange.of(true),
        Transaction.addToHistory.of(false),
      ],
    };
  },
);
