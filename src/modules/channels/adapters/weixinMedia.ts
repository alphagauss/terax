/** 微信媒体描述归一化与原生传输桥接，通用附件不携带 CDN 定位信息或密钥。 */
import {
  httpFileRequest,
  withPreparedHttpFile,
  type HttpFileContext,
} from "@/lib/httpFiles";
import {
  ChannelError,
  type ChannelAttachment,
  type ChannelOutbound,
} from "@/modules/channels/types";
import { channelAttachmentPath } from "@/modules/channels/workspace";

const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

/** 平台地址白名单属于适配器，原生 HTTP 仍独立执行 DNS、代理和重定向校验。 */
export function weixinMediaUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !url.hostname.endsWith(".weixin.qq.com")
  )
    throw new ChannelError("protocol");
  return url.href;
}

/** 微信协议允许 base64 原始密钥或 base64 编码的 hex 文本，原生只接收原始字节。 */
export function weixinAesKey(value: string): number[] {
  const decoded = atob(value);
  if (decoded.length === 16)
    return Array.from(decoded, (char) => char.charCodeAt(0));
  if (!/^[\da-f]{32}$/i.test(decoded)) throw new ChannelError("protocol");
  return Array.from({ length: 16 }, (_, index) =>
    Number.parseInt(decoded.slice(index * 2, index * 2 + 2), 16),
  );
}

type Payload = Record<string, unknown>;
export type WeixinMedia = {
  attachment: Pick<ChannelAttachment, "id" | "name" | "kind">;
  url: string;
  aesKey?: string;
};

/** 提取已授权消息中的媒体位置；格式不完整的媒体仍保留为失败附件。 */
export function parseWeixinMedia(item: Payload): WeixinMedia | null {
  if (typeof item.type !== "number") return null;
  const spec = (
    {
      2: ["image_item", "image", "image.jpg"],
      3: ["voice_item", "audio", "voice.silk"],
      4: ["file_item", "file", "attachment"],
      5: ["video_item", "video", "video.mp4"],
    } as const
  )[item.type as 2 | 3 | 4 | 5];
  if (!spec) return null;
  const typed = (item[spec[0]] ?? {}) as Payload;
  const media = (typed.media ?? {}) as Payload;
  const attachment = {
    id: crypto.randomUUID(),
    name:
      typeof typed.file_name === "string" && typed.file_name.trim()
        ? typed.file_name
        : spec[2],
    kind: spec[1],
  };
  const full = typeof media.full_url === "string" ? media.full_url : "";
  const param =
    typeof media.encrypt_query_param === "string"
      ? media.encrypt_query_param
      : "";
  const url =
    full ||
    (param
      ? `https://novac2c.cdn.weixin.qq.com/c2c/download?${new URLSearchParams({ encrypted_query_param: param })}`
      : "");
  const aesKey =
    typeof typed.aeskey === "string" && typed.aeskey
      ? /^[\da-f]{32}$/i.test(typed.aeskey)
        ? btoa(typed.aeskey)
        : "invalid"
      : typeof media.aes_key === "string"
        ? media.aes_key
        : undefined;
  return { attachment, url: spec[1] !== "image" && !aesKey ? "" : url, aesKey };
}

export async function downloadWeixinMedia(
  media: WeixinMedia,
  connectionId: string,
  files: HttpFileContext,
  signal: AbortSignal,
): Promise<ChannelAttachment> {
  try {
    if (!media.url) throw new Error("Missing media location");
    const response = await httpFileRequest(
      {
        url: weixinMediaUrl(media.url),
        method: "GET",
        networkTarget: { kind: "channel", id: connectionId },
        maxResponseBytes: MAX_ATTACHMENT_BYTES + 16,
        destination: {
          root: files.root,
          path: channelAttachmentPath(media.attachment.name),
          renameOnConflict: true,
          maxBytes: MAX_ATTACHMENT_BYTES,
          transform: media.aesKey
            ? {
                algorithm: "aes-128-ecb-pkcs7",
                operation: "decrypt",
                key: weixinAesKey(media.aesKey),
              }
            : undefined,
        },
      },
      signal,
    );
    if (!response.file || response.status < 200 || response.status >= 300)
      throw new ChannelError("delivery");
    return { ...media.attachment, status: "ready", ...response.file };
  } catch {
    signal.throwIfAborted();
    return { ...media.attachment, status: "failed" };
  }
}

/** 上传协商、密钥编码和消息 item 都由微信适配器拥有，Rust 只传输准备好的文件。 */
export async function uploadWeixinMedia(
  file: NonNullable<ChannelOutbound["attachments"]>[number],
  files: HttpFileContext,
  connectionId: string,
  recipient: string,
  signal: AbortSignal,
  getUploadUrl: (body: Payload) => Promise<Payload>,
): Promise<Payload> {
  const [uploadType, itemType, itemKey] = {
    image: [1, 2, "image_item"],
    video: [2, 5, "video_item"],
    file: [3, 4, "file_item"],
    audio: [4, 3, "voice_item"],
  }[file.presentation] as [number, number, string];
  const key = Array.from(crypto.getRandomValues(new Uint8Array(16)));
  const hexKey = key.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return withPreparedHttpFile(
    {
      ...files,
      path: file.path,
      maxBytes: MAX_ATTACHMENT_BYTES,
      transform: { algorithm: "aes-128-ecb-pkcs7", operation: "encrypt", key },
    },
    signal,
    async (prepared) => {
      const fileKey = crypto.randomUUID().replace(/-/g, "");
      const response = await getUploadUrl({
        filekey: fileKey,
        media_type: uploadType,
        to_user_id: recipient,
        rawsize: prepared.size,
        rawfilemd5: prepared.md5,
        filesize: prepared.bodySize,
        no_need_thumb: true,
        aeskey: hexKey,
      });
      let url: string;
      if (
        typeof response.upload_full_url === "string" &&
        response.upload_full_url
      )
        url = weixinMediaUrl(response.upload_full_url);
      else {
        if (typeof response.upload_param !== "string" || !response.upload_param)
          throw new ChannelError("protocol");
        url = `https://novac2c.cdn.weixin.qq.com/c2c/upload?${new URLSearchParams({ encrypted_query_param: response.upload_param, filekey: fileKey })}`;
      }
      const uploaded = await httpFileRequest(
        {
          url,
          method: "POST",
          bodyFile: prepared.id,
          headers: { "Content-Type": "application/octet-stream" },
          networkTarget: { kind: "channel", id: connectionId },
        },
        signal,
      );
      const param = uploaded.headers["x-encrypted-param"];
      if (uploaded.status < 200 || uploaded.status >= 300 || !param)
        throw new ChannelError("delivery");
      const item: Payload = {
        media: {
          encrypt_query_param: param,
          aes_key: btoa(hexKey),
          encrypt_type: 1,
        },
      };
      if (itemType === 2) item.mid_size = prepared.bodySize;
      if (itemType === 5) item.video_size = prepared.bodySize;
      if (itemType === 4) {
        item.file_name = prepared.name;
        item.len = String(prepared.size);
      }
      return { type: itemType, [itemKey]: item };
    },
  );
}
