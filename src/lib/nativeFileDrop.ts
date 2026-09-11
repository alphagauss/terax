/** Tauri 文件拖放使用物理坐标，各接收区统一转换后再做 DOM 命中测试。 */
export function nativeDropElementAt(x: number, y: number): Element | null {
  const scale = window.devicePixelRatio || 1;
  return document.elementFromPoint(x / scale, y / scale);
}
