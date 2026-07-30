/**
 * 本文件提取粘贴事件中的图片文件。
 *
 * 优先使用 DataTransfer.files，必要时回退到 items，避免同一图片被重复附加。
 */

/** 返回剪贴板中的图片文件，忽略文本及其他文件类型。 */
export function clipboardImageFiles(data: DataTransfer): File[] {
  const files = Array.from(data.files).filter((file) =>
    file.type.startsWith("image/"),
  );
  if (files.length > 0) return files;

  const images: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) images.push(file);
  }
  return images;
}
