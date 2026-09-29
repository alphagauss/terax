/** 页面图片复制与另存为；复制使用已解码像素，保存保留来源的原始字节。 */
import { USE_NATIVE_CLIPBOARD } from "@/lib/clipboard";
import { IS_LINUX } from "@/lib/platform";
import { invoke } from "@tauri-apps/api/core";

const MAX_COPY_PIXELS = 16_777_216;
const MAX_LINUX_COPY_PIXELS = 9_000_000;

/** 将当前已解码图片写入系统剪贴板；Web Clipboard 编码 PNG，Windows 与 Linux 使用原生 RGBA。 */
export async function writeClipboardImage(
  image: HTMLImageElement,
): Promise<void> {
  // 固定已绘制图片的尺寸，避免异步复制期间 src 变化导致像素与尺寸不一致。
  const { naturalWidth: width, naturalHeight: height } = image;
  if (!image.complete || width === 0 || height === 0) {
    throw new Error("image is not ready");
  }
  const pixels = width * height;
  const maxPixels = IS_LINUX ? MAX_LINUX_COPY_PIXELS : MAX_COPY_PIXELS;
  if (!Number.isSafeInteger(pixels) || pixels > maxPixels) {
    throw new Error("image dimensions are too large to copy");
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("image canvas is unavailable");
  try {
    context.drawImage(image, 0, 0);
    if (USE_NATIVE_CLIPBOARD) {
      const imageData = context.getImageData(0, 0, width, height);
      const rgba = new Uint8Array(
        imageData.data.buffer,
        imageData.data.byteOffset,
        imageData.data.byteLength,
      );
      // 使用二进制请求，避免数百万像素经 JSON 数字数组序列化。
      await invoke("clipboard_write_image", rgba, {
        headers: {
          "x-image-width": String(width),
          "x-image-height": String(height),
        },
      });
      return;
    }

    if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
      throw new Error("image clipboard is unavailable");
    }
    const blob = await canvasToBlob(canvas);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("image encoding failed"));
    }, "image/png");
  });
}

/** 保存已显示图片的来源字节，不把 JPEG、GIF 等格式重新编码成 PNG。 */
export async function saveImageAs(
  src: string,
  labels: { title: string; imageFilter: string },
): Promise<boolean> {
  const response = await fetch(src);
  if (!response.ok) throw new Error("image source is unavailable");
  const blob = await response.blob();
  if (blob.size > 20 * 1024 * 1024)
    throw new Error("image exceeds the 20 MB limit");
  const resource = await invoke<{ token: string }>("markdown_image_prepare", {
    source: {
      kind: "bytes",
      bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
    },
  });
  try {
    return await savePreparedImage(resource, labels);
  } finally {
    await invoke("markdown_image_release", { token: resource.token });
  }
}

/** 已准备图片直接复用资源另存为，不再次下载或编码。 */
export async function savePreparedImage(
  resource: { token: string },
  labels: { title: string; imageFilter: string },
): Promise<boolean> {
  return invoke<boolean>("markdown_image_save_as", {
    token: resource.token,
    title: labels.title,
    imageFilter: labels.imageFilter,
  });
}
