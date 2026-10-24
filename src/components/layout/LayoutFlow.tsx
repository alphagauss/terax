/** 局部卡片与控件排列的声明式入口，复用原有 flex、grid 或列表语义。 */
import { useCallback, useState, type HTMLAttributes } from "react";
import { LayoutMotion } from "@/lib/layoutMotion";
import { cn } from "@/lib/utils";

type Props = HTMLAttributes<HTMLElement> & {
  as?: "div" | "ul";
  /** 宿主隐藏但保留挂载时关闭观察，恢复只建立基线。 */
  active?: boolean;
};

/** 仅观察直接子项及容器布局属性；保留子项身份、焦点、草稿与事件。 */
export function LayoutFlow({
  as: Tag = "div",
  active = true,
  className,
  children,
  ...props
}: Props) {
  const [layout] = useState(() => new LayoutMotion());
  const connect = useCallback(
    (element: HTMLElement | null) => {
      if (!active || !element) return;
      const observer = new MutationObserver((records) => {
        // 后代只接收通知而不测量；控件内部更新不能触发整组布局工作。
        if (
          !records.some(
            (record) =>
              record.target === element ||
              (record.type === "attributes" &&
                record.target.parentNode === element),
          )
        )
          return;
        layout.sync(element);
        layout.schedule();
      });
      const observe = () => {
        observer.disconnect();
        layout.disconnect();
        if (document.hidden) return;
        layout.sync(element);
        observer.observe(element, {
          childList: true,
          attributes: true,
          subtree: true,
          attributeFilter: ["class", "style", "hidden", "inert", "aria-hidden"],
        });
      };
      observe();
      document.addEventListener("visibilitychange", observe);
      return () => {
        document.removeEventListener("visibilitychange", observe);
        observer.disconnect();
        layout.disconnect();
      };
    },
    [active, layout],
  );
  return (
    <Tag
      {...props}
      ref={connect}
      data-layout-flow=""
      className={cn("relative", className)}
    >
      {children}
    </Tag>
  );
}
