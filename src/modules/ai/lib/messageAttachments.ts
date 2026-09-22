/** 用户附件的轻量索引；文件路径随用户消息保存，图片内容仍由媒体 part 持有。 */
import type { UIMessage } from "ai";

export type AttachmentDisplay =
  | {
      kind: "file";
      name: string;
      size: number;
      path: string;
      environmentKey: string;
    }
  | {
      kind: "image";
      name: string;
      size: number;
      sourcePath?: string;
      environmentKey?: string;
      mediaIndex: number;
    };

export function messageRawText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/** 将路径附件稳定编码为同一条用户消息的模型输入。 */
export function attachmentReferenceText(
  attachments: readonly AttachmentDisplay[],
): string {
  const files = attachments.flatMap((attachment) =>
    attachment.kind === "file"
      ? [
          {
            path: attachment.path,
            name: attachment.name,
            size: attachment.size,
          },
        ]
      : [],
  );
  if (!files.length) return "";
  return `<attached_files>\n${JSON.stringify(files)}\n</attached_files>`;
}
