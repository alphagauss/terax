/** 将已下载的通用 Channel 附件物化为模型可消费的视觉媒体。 */
import type { FileUIPart } from "ai";
import { readPathAttachment } from "@/modules/ai/lib/attachmentFiles";
import type {
  ChannelConnection,
  ChannelInbound,
} from "@/modules/channels/types";
import { prepareChannelWorkspace } from "@/modules/channels/workspace";

const MAX_CHANNEL_IMAGES_PER_MESSAGE = 16;

/** 仅接受 Channel cwd 下的相对附件路径，避免入站事实越界读取本地文件。 */
function attachmentAbsolutePath(root: string, path: string): string | null {
  const segments = path.split("/");
  if (
    !path ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  )
    return null;
  return `${root.replace(/[\\/]+$/, "")}/${segments.join("/")}`;
}

/**
 * 在入队前一次性读取成功下载的图片，确保首轮与 steer 输入都能同步复用相同视觉 part。
 * 文件下载仍由具体 Channel 适配器拥有，这里只处理跨平台一致的本地附件事实。
 */
export async function materializeChannelInbound(
  connection: ChannelConnection,
  message: ChannelInbound,
  signal: AbortSignal,
): Promise<ChannelInbound> {
  signal.throwIfAborted();
  const images = message.attachments.flatMap((attachment) =>
    attachment.kind === "image" && attachment.status === "ready"
      ? [attachment]
      : [],
  );
  if (!images.length) return { ...message, modelMedia: [] };
  const root = await prepareChannelWorkspace(connection);
  const media: FileUIPart[] = [];
  for (const attachment of images) {
    signal.throwIfAborted();
    if (media.length >= MAX_CHANNEL_IMAGES_PER_MESSAGE) break;
    const sourcePath = attachmentAbsolutePath(root, attachment.path);
    if (!sourcePath) continue;
    try {
      const image = await readPathAttachment(
        sourcePath,
        { kind: "local" },
        { image: true },
      );
      if (image.kind !== "image") continue;
      media.push({
        type: "file",
        mediaType: image.mediaType,
        url: image.url,
        filename: attachment.name,
      });
    } catch {
      // 下载成功的原文件仍可由 Agent 按路径读取，只是不作为视觉输入发送。
    }
  }
  return { ...message, modelMedia: media };
}
