/**
 * 本文件限制 React 开发性能轨道在浏览器时间线中的保留。
 * 长 props 会被原生 PerformanceMeasure 复制，GC 和组件卸载都不能释放这些记录。
 */

/** 仅回收 React 组件轨道；性能录制仍可消费事件，业务埋点不受影响。 */
export function observeReactPerformance(profile = false): () => void {
  const names = new Set<string>();
  const clear = () => {
    for (const name of names) performance.clearMeasures(name);
    names.clear();
  };
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (
        entry.name.startsWith("\u200b") &&
        (entry as PerformanceMeasure).detail?.devtools?.track ===
          `Components ${String.fromCodePoint(0x269b)}`
      ) {
        names.add(entry.name);
      }
    }
    if (!profile) clear();
  });
  observer.observe({ type: "measure", buffered: true });
  // 显式分析时允许检查最近一秒的记录，仍不随整个开发会话无限保留。
  const timer = profile ? setInterval(clear, 1000) : undefined;
  return () => {
    observer.disconnect();
    if (timer !== undefined) clearInterval(timer);
    clear();
  };
}
