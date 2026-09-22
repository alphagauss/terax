/** 用户消息的结构化附件事实；图片内容仍由媒体 part 持有。 */
import type { UIMessage } from "ai";

export type MessageAttachment =
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
    }
  | {
      kind: "selection";
      id: string;
      text: string;
      source: "terminal";
    }
  | {
      kind: "selection";
      id: string;
      text: string;
      source: "editor";
      path: string;
    }
  | {
      kind: "snippet";
      id: string;
      handle: string;
      content: string;
    };

export function messageRawText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 将文件与选区附件稳定编码为同一条用户消息的模型输入。 */
export function attachmentContextText(
  attachments: readonly MessageAttachment[],
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
  const selections = attachments.flatMap((attachment) => {
    if (attachment.kind !== "selection") return [];
    const path =
      attachment.source === "editor"
        ? ` path="${escapeAttribute(attachment.path)}"`
        : "";
    return [
      `<selection source="${attachment.source}"${path}>\n${attachment.text}\n</selection>`,
    ];
  });
  const snippets = attachments.flatMap((attachment) =>
    attachment.kind === "snippet"
      ? [
          `<snippet name="${escapeAttribute(attachment.handle)}">\n${attachment.content}\n</snippet>`,
        ]
      : [],
  );
  return [
    files.length
      ? `<attached_files>\n${JSON.stringify(files)}\n</attached_files>`
      : "",
    ...selections,
    ...snippets,
  ]
    .filter(Boolean)
    .join("\n\n");
}
