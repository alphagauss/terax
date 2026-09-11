/** 用户附件的轻量展示索引；正文和图片仍由消息 parts 唯一持有。 */
import type { UIMessage } from "ai";

export type AttachmentDisplay = {
  name: string;
  size: number;
  sourcePath?: string;
  environmentKey?: string;
} & (
  | {
      kind: "text";
      blockRange: [number, number];
      contentRange: [number, number];
    }
  | { kind: "image"; mediaIndex: number }
);

export function messageRawText(message: UIMessage): string {
  return message.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/** 在原始 UTF-16 文本上校验范围；无效或重叠索引不参与隐藏与预览。 */
export function textAttachments(
  text: string,
  attachments: readonly AttachmentDisplay[],
) {
  let end = 0;
  return attachments.filter(
    (a): a is Extract<AttachmentDisplay, { kind: "text" }> => {
      if (
        a.kind !== "text" ||
        !Array.isArray(a.blockRange) ||
        !Array.isArray(a.contentRange)
      )
        return false;
      const [start, stop] = a.blockRange;
      const [contentStart, contentEnd] = a.contentRange;
      if (
        ![start, stop, contentStart, contentEnd].every(Number.isSafeInteger) ||
        start < end ||
        stop <= start ||
        stop > text.length ||
        contentStart < start ||
        contentEnd < contentStart ||
        contentEnd > stop
      )
        return false;
      end = stop;
      return true;
    },
  );
}

/** 只移除明确记录的附件块，正文内同名标签保持原样。 */
export function messageTextWithoutAttachments(message: UIMessage): string {
  const text = messageRawText(message);
  const metadata = message.metadata as
    | { attachments?: AttachmentDisplay[] }
    | undefined;
  const attachments = textAttachments(text, metadata?.attachments ?? []);
  let start = 0;
  const chunks: string[] = [];
  for (const a of attachments) {
    chunks.push(text.slice(start, a.blockRange[0]));
    start = a.blockRange[1];
  }
  chunks.push(text.slice(start));
  return chunks.join("");
}

/** 按发送顺序追加文件块，同时记录内容范围，不扫描文件正文。 */
export function appendTextAttachment(
  text: string,
  file: {
    name: string;
    mediaType: string;
    text?: string;
    size: number;
    sourcePath?: string;
    environmentKey?: string;
  },
): { text: string; attachment: AttachmentDisplay } {
  const start = text.length + (text ? 2 : 0);
  const header = `<file name="${file.name}" mediaType="${file.mediaType}">\n`;
  const content = file.text ?? "";
  const block = `${header}${content}\n</file>`;
  return {
    text: `${text}${text ? "\n\n" : ""}${block}`,
    attachment: {
      kind: "text",
      name: file.name,
      size: file.size,
      sourcePath: file.sourcePath,
      environmentKey: file.environmentKey,
      blockRange: [start, start + block.length],
      contentRange: [
        start + header.length,
        start + header.length + content.length,
      ],
    },
  };
}
