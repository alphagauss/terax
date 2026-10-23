import { useEffect, useState } from "react";

/** 共用侧栏刷新提示；宿主提供相对定位，快速请求和隐藏状态不播放动画。 */
export function SourceControlRefreshProgress({
  active,
  label,
}: {
  active: boolean;
  label: string;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    setVisible(false);
    if (!active) return;
    const timer = window.setTimeout(() => setVisible(true), 300);
    return () => window.clearTimeout(timer);
  }, [active]);
  if (!active || !visible) return null;
  return (
    <div
      role="progressbar"
      aria-label={label}
      className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden"
    >
      <div className="terax-source-control-refresh h-full w-1/4 bg-primary" />
    </div>
  );
}
