/**
 * 本文件实现查找界面共用的查询输入框与匹配选项。
 * 组件只负责模式输入、选项切换和聚焦，不持有单文件导航或工作区搜索状态。
 */

import { Hint } from "@/components/controls/tooltip";
import { cn } from "@/lib/utils";
import {
  forwardRef,
  type ReactNode,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { useTranslation } from "react-i18next";

export type FindOptions = {
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
};

export type FindPatternFieldHandle = {
  element: () => HTMLInputElement | null;
  focus: (select?: boolean) => void;
};

type FindControlButtonProps = {
  label: string;
  children: ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  className?: string;
};

/** 查找界面共用的紧凑图标按钮。 */
export function FindControlButton({
  label,
  children,
  onClick,
  active,
  disabled,
  className,
}: FindControlButtonProps) {
  return (
    <Hint content={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active === undefined ? undefined : active}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          "inline-flex size-5.5 shrink-0 items-center justify-center rounded border border-transparent text-[11px] font-medium text-muted-foreground transition-colors duration-control",
          "hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:pointer-events-none disabled:opacity-35",
          active &&
            "border-primary bg-accent text-foreground ring-1 ring-primary/60 ring-inset",
          className,
        )}
      >
        {children}
      </button>
    </Hint>
  );
}

type Props = {
  query: string;
  onQueryChange: (query: string) => void;
  onQueryCommit?: (query: string) => void;
  options?: FindOptions;
  onOptionsChange?: (options: FindOptions) => void;
  invalid?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  trailingContent?: ReactNode;
  className?: string;
};

/** 查找模式输入框，向调用方暴露真实输入元素与聚焦能力。 */
export const FindPatternField = forwardRef<FindPatternFieldHandle, Props>(
  function FindPatternField(
    {
      query,
      onQueryChange,
      onQueryCommit,
      options,
      onOptionsChange,
      invalid = false,
      autoFocus = false,
      placeholder,
      trailingContent,
      className,
    },
    ref,
  ) {
    const { t } = useTranslation("find");
    const inputRef = useRef<HTMLInputElement>(null);
    const composingRef = useRef(false);
    const committedQueryRef = useRef(query);

    const focus = useCallback((select = false) => {
      const input = inputRef.current;
      if (!input) return;
      input.focus({ preventScroll: true });
      if (select) input.select();
    }, []);

    useImperativeHandle(
      ref,
      () => ({ element: () => inputRef.current, focus }),
      [focus],
    );

    useLayoutEffect(() => {
      if (autoFocus) focus(true);
    }, [autoFocus, focus]);

    const changeOption = (key: keyof FindOptions) => {
      if (!options || !onOptionsChange) return;
      onOptionsChange({ ...options, [key]: !options[key] });
      focus(false);
    };

    const commitQuery = (value: string) => {
      if (!onQueryCommit || committedQueryRef.current === value) return;
      committedQueryRef.current = value;
      onQueryCommit(value);
    };

    const hasQuery = query.length > 0;
    return (
      <div
        className={cn(
          "flex h-7 min-w-0 flex-1 items-center overflow-hidden rounded-md border bg-background/75",
          invalid && hasQuery
            ? "border-destructive"
            : "border-input focus-within:border-ring",
          className,
        )}
      >
        <input
          ref={inputRef}
          main-field="true"
          type="text"
          value={query}
          autoComplete="off"
          spellCheck={false}
          aria-label={t("findLabel")}
          aria-invalid={invalid && hasQuery}
          placeholder={placeholder ?? t("findPlaceholder")}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            commitQuery(event.currentTarget.value);
          }}
          onChange={(event) => {
            const value = event.target.value;
            onQueryChange(value);
            if (
              !composingRef.current &&
              !(event.nativeEvent as InputEvent).isComposing
            ) {
              commitQuery(value);
            }
          }}
          className="h-full min-w-10 flex-1 bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground/65"
        />
        {trailingContent ? (
          <div className="flex shrink-0 items-center pr-0.5">
            {trailingContent}
          </div>
        ) : null}
        {options && onOptionsChange ? (
          <div className="flex shrink-0 items-center pr-0.5">
            <FindControlButton
              label={t("matchCase")}
              active={options.caseSensitive}
              onClick={() => changeOption("caseSensitive")}
            >
              Aa
            </FindControlButton>
            <FindControlButton
              label={t("wholeWord")}
              active={options.wholeWord}
              onClick={() => changeOption("wholeWord")}
            >
              ab
            </FindControlButton>
            <FindControlButton
              label={t("regex")}
              active={options.regexp}
              onClick={() => changeOption("regexp")}
            >
              .*
            </FindControlButton>
          </div>
        ) : null}
      </div>
    );
  },
);
