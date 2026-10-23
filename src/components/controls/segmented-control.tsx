/**
 * 等宽连续分段控件，移植 Surf 的滑动底块，复用桌面按钮和动效规范。
 * 只展示受控值；提交预览和持久化由调用方管理，快速反向切换接续当前视觉位置。
 */
import { RadioGroup } from "radix-ui";
import { useEffect, useLayoutEffect, useRef } from "react";
import { Button } from "@/components/controls/button";
import { RevealMotion } from "@/lib/revealMotion";

export function SegmentedControl({
  value,
  options,
  label,
  disabled = false,
  pending = false,
  onValueChange,
}: {
  value: string;
  options: readonly (readonly [string, string])[];
  label: string;
  disabled?: boolean;
  pending?: boolean;
  onValueChange: (value: string) => void;
}) {
  const indicator = useRef<HTMLSpanElement>(null);
  const motion = useRef<RevealMotion | null>(null);
  const previous = useRef(-1);
  const index = options.findIndex(([option]) => option === value);

  useLayoutEffect(() => {
    const pill = indicator.current;
    if (!pill) return;
    const from = getComputedStyle(pill).transform;
    motion.current?.finish(false);
    motion.current = null;
    const transform = `translateX(${Math.max(0, index) * 100}%)`;
    pill.style.transform = transform;
    pill.style.visibility = index < 0 ? "hidden" : "visible";
    if (
      index >= 0 &&
      previous.current >= 0 &&
      index !== previous.current &&
      !document.hidden &&
      pill.getClientRects().length > 0
    ) {
      const next = new RevealMotion(() => {
        motion.current = null;
      });
      motion.current = next;
      next.animate(pill, [{ transform: from }, { transform }]);
      next.start();
    }
    previous.current = index;
  }, [index]);

  useEffect(() => {
    const stopWhenHidden = () => {
      if (document.hidden) motion.current?.finish();
    };
    document.addEventListener("visibilitychange", stopWhenHidden);
    return () => {
      document.removeEventListener("visibilitychange", stopWhenHidden);
      motion.current?.finish(false);
    };
  }, []);

  return (
    <RadioGroup.Root
      aria-label={label}
      aria-busy={pending}
      value={value}
      orientation="horizontal"
      disabled={disabled || pending}
      onValueChange={onValueChange}
      className="group relative isolate inline-grid w-fit max-w-full shrink-0 auto-cols-fr grid-flow-col items-center rounded-md bg-secondary data-[disabled]:opacity-50"
    >
      <span
        ref={indicator}
        aria-hidden="true"
        style={{ width: `${100 / options.length}%` }}
        className="pointer-events-none invisible absolute top-0 left-0 h-full rounded-md bg-primary transition-colors duration-control ease-standard group-has-[[data-state=checked]:enabled:hover]:bg-primary/80"
      />
      {options.map(([option, text]) => (
        <RadioGroup.Item key={option} value={option} asChild>
          <Button
            type="button"
            variant="ghost"
            className="relative w-full active:translate-y-0 disabled:opacity-100 data-[state=checked]:text-primary-foreground data-[state=checked]:hover:bg-transparent data-[state=checked]:hover:text-primary-foreground dark:data-[state=checked]:hover:bg-transparent"
          >
            {text}
          </Button>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
