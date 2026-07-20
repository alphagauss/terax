import { cn } from "@/lib/utils";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  ChevronRightIcon,
  ReplaceAllIcon,
  ReplaceIcon,
  TextSelectionIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  forwardRef,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { useTranslation } from "react-i18next";
import "./find-widget.css";

export const FIND_PRESENCE_MS = 160;

export type FindHandle = {
  open: () => void;
};

export type FindWidgetHandle = {
  focus: (select?: boolean) => void;
};

export type FindOptions = {
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
};

export type FindResult = {
  current?: number;
  total: number;
  limited?: boolean;
};

type FindSelection = {
  active: boolean;
  available: boolean;
  onToggle: () => void;
};

type FindWidgetProps = {
  query: string;
  onQueryChange: (query: string) => void;
  onClose: () => void;
  state?: "open" | "closed";
  onNext?: () => void;
  onPrevious?: () => void;
  options?: FindOptions;
  onOptionsChange?: (options: FindOptions) => void;
  result?: FindResult;
  invalid?: boolean;
  selection?: FindSelection;
  autoFocus?: boolean;
  className?: string;
};

type FindReplaceState = {
  value: string;
  open: boolean;
  preserveCase: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onPreserveCaseChange: (enabled: boolean) => void;
  onReplace: () => void;
  onReplaceAll: () => void;
};

type FindReplaceWidgetProps = FindWidgetProps & {
  replace: FindReplaceState;
};

type FindWidgetBaseProps = FindWidgetProps & {
  replace?: FindReplaceState;
};

type FindButtonProps = {
  label: string;
  children: ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  className?: string;
};

export function isFindKeyboardEventComposing(input: {
  isComposing: boolean;
  keyCode: number;
}): boolean {
  return input.isComposing || input.keyCode === 229;
}

function FindButton({
  label,
  children,
  onClick,
  active,
  disabled,
  className,
}: FindButtonProps) {
  return (
    <button
      type="button"
      title={label}
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
  );
}

const FindWidgetBase = forwardRef<FindWidgetHandle, FindWidgetBaseProps>(
  function FindWidgetBase(
    {
      query,
      onQueryChange,
      onClose,
      state = "open",
      onNext,
      onPrevious,
      options,
      onOptionsChange,
      result,
      invalid = false,
      selection,
      replace,
      autoFocus = true,
      className,
    },
    ref,
  ) {
    const { t } = useTranslation("find");
    const findInputRef = useRef<HTMLInputElement>(null);
    const replaceInputRef = useRef<HTMLInputElement>(null);

    const focus = useCallback((select = false) => {
      const input = findInputRef.current;
      if (!input) return;
      input.focus({ preventScroll: true });
      if (select) input.select();
    }, []);

    useImperativeHandle(ref, () => ({ focus }), [focus]);

    useLayoutEffect(() => {
      if (autoFocus) focus(true);
    }, [autoFocus, focus]);

    const retainInput = useCallback(
      (input: HTMLInputElement | null, action: (() => void) | undefined) => {
        if (!action) return;
        const start = input?.selectionStart ?? null;
        const end = input?.selectionEnd ?? null;
        action();
        if (!input) return;
        input.focus({ preventScroll: true });
        if (start !== null && end !== null) input.setSelectionRange(start, end);
      },
      [],
    );

    const changeOption = useCallback(
      (key: keyof FindOptions) => {
        if (!options || !onOptionsChange) return;
        onOptionsChange({ ...options, [key]: !options[key] });
        focus(false);
      },
      [focus, onOptionsChange, options],
    );

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (
        isFindKeyboardEventComposing({
          isComposing: event.nativeEvent.isComposing,
          keyCode: event.keyCode,
        })
      ) {
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        event.stopPropagation();
        focus(true);
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        const key = event.key.toLowerCase();
        if (key === "c") changeOption("caseSensitive");
        else if (key === "w") changeOption("wholeWord");
        else if (key === "r") changeOption("regexp");
        else if (key === "l" && selection?.available) selection.onToggle();
        else if (key === "p" && replace?.open)
          replace.onPreserveCaseChange(!replace.preserveCase);
        else return;
        event.preventDefault();
        return;
      }

      if (event.key !== "Enter") return;
      if (event.target === findInputRef.current) {
        event.preventDefault();
        retainInput(findInputRef.current, event.shiftKey ? onPrevious : onNext);
      } else if (event.target === replaceInputRef.current) {
        event.preventDefault();
        retainInput(replaceInputRef.current, replace?.onReplace);
      }
    };

    const hasQuery = query.length > 0;
    const hasReplace = Boolean(replace && !replace.disabled);
    const canNavigate =
      hasQuery && !invalid && (result === undefined || result.total > 0);
    const total = result?.limited ? `${result.total}+` : result?.total;
    let status = "";
    if (invalid && hasQuery) status = t("invalidRegex");
    else if (result && result.total > 0 && result.current !== undefined)
      status = t("matchLocation", { current: result.current || "?", total });
    else if (result && result.total > 0)
      status = t("matchCount", { count: total });
    else if (result && hasQuery) status = t("noResults");

    return (
      <div
        data-find-widget
        data-replace={hasReplace}
        data-state={state}
        role="dialog"
        aria-label={t("dialogLabel")}
        onKeyDown={onKeyDown}
        className={cn(
          "terax-find-widget min-w-0 overflow-hidden rounded-lg border border-border/80 bg-popover text-popover-foreground shadow-lg",
          "duration-control ease-standard data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-top-1 data-[state=closed]:pointer-events-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:slide-out-to-top-1",
          className,
        )}
      >
        <div className="terax-find-widget__find-row flex min-w-0 items-center gap-0.5 p-1">
          {hasReplace && replace ? (
            <FindButton
              label={t("toggleReplace")}
              active={replace.open}
              onClick={() => replace.onOpenChange(!replace.open)}
              className="terax-find-widget__toggle"
            >
              <HugeiconsIcon
                icon={ChevronRightIcon}
                size={14}
                strokeWidth={1.8}
                className={cn(
                  "transition-transform duration-control",
                  replace.open && "rotate-90",
                )}
              />
            </FindButton>
          ) : null}

          <div
            className={cn(
              "terax-find-widget__find-field flex h-7 min-w-0 flex-1 items-center overflow-hidden rounded-md border bg-background/75",
              invalid && hasQuery
                ? "border-destructive"
                : "border-input focus-within:border-ring",
            )}
          >
            <input
              ref={findInputRef}
              main-field="true"
              type="text"
              value={query}
              autoComplete="off"
              spellCheck={false}
              aria-label={t("findLabel")}
              aria-invalid={invalid && hasQuery}
              placeholder={t("findPlaceholder")}
              onChange={(event) => onQueryChange(event.target.value)}
              className="h-full min-w-10 flex-1 bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground/65"
            />
            {options && onOptionsChange ? (
              <div className="flex shrink-0 items-center pr-0.5">
                <FindButton
                  label={t("matchCase")}
                  active={options.caseSensitive}
                  onClick={() => changeOption("caseSensitive")}
                >
                  Aa
                </FindButton>
                <FindButton
                  label={t("wholeWord")}
                  active={options.wholeWord}
                  onClick={() => changeOption("wholeWord")}
                >
                  ab
                </FindButton>
                <FindButton
                  label={t("regex")}
                  active={options.regexp}
                  onClick={() => changeOption("regexp")}
                >
                  .*
                </FindButton>
              </div>
            ) : null}
          </div>

          <span
            aria-live="polite"
            title={
              result?.limited
                ? t("matchLimit", { count: result.total })
                : status
            }
            className={cn(
              "terax-find-widget__status max-w-20 shrink-0 truncate px-1 text-[10.5px] tabular-nums text-muted-foreground",
              invalid && "text-destructive",
            )}
          >
            {status}
          </span>

          {onPrevious ? (
            <FindButton
              label={t("previous")}
              disabled={!canNavigate}
              onClick={() => retainInput(findInputRef.current, onPrevious)}
              className="terax-find-widget__previous"
            >
              <HugeiconsIcon icon={ArrowUp01Icon} size={14} strokeWidth={1.8} />
            </FindButton>
          ) : null}
          {onNext ? (
            <FindButton
              label={t("next")}
              disabled={!canNavigate}
              onClick={() => retainInput(findInputRef.current, onNext)}
              className="terax-find-widget__next"
            >
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                size={14}
                strokeWidth={1.8}
              />
            </FindButton>
          ) : null}
          {selection ? (
            <FindButton
              label={t("findInSelection")}
              active={selection.active}
              disabled={!selection.available}
              onClick={() => {
                selection.onToggle();
                focus(false);
              }}
              className="terax-find-widget__selection"
            >
              <HugeiconsIcon
                icon={TextSelectionIcon}
                size={14}
                strokeWidth={1.8}
              />
            </FindButton>
          ) : null}
          <FindButton
            label={t("close")}
            onClick={onClose}
            className="terax-find-widget__close"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={1.8} />
          </FindButton>
        </div>

        {hasReplace && replace ? (
          <div
            data-state={replace.open ? "open" : "closed"}
            aria-hidden={!replace.open}
            inert={!replace.open}
            className="terax-find-widget__replace-reveal terax-reveal"
          >
            <div className="terax-find-widget__replace-row min-w-0 items-center pt-0.5">
              <div className="terax-find-widget__replace-field flex h-7 min-w-0 items-center overflow-hidden rounded-md border border-input bg-background/75 focus-within:border-ring">
                <input
                  ref={replaceInputRef}
                  type="text"
                  value={replace.value}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={t("replaceLabel")}
                  placeholder={t("replacePlaceholder")}
                  onChange={(event) => replace.onChange(event.target.value)}
                  className="h-full min-w-10 flex-1 bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground/65"
                />
                <FindButton
                  label={t("preserveCase")}
                  active={replace.preserveCase}
                  onClick={() => {
                    replace.onPreserveCaseChange(!replace.preserveCase);
                    replaceInputRef.current?.focus({ preventScroll: true });
                  }}
                >
                  AB
                </FindButton>
              </div>
              <FindButton
                label={t("replace")}
                disabled={!canNavigate}
                onClick={() =>
                  retainInput(replaceInputRef.current, replace.onReplace)
                }
                className="terax-find-widget__replace-one"
              >
                <HugeiconsIcon icon={ReplaceIcon} size={14} strokeWidth={1.8} />
              </FindButton>
              <FindButton
                label={t("replaceAll")}
                disabled={!canNavigate}
                onClick={() =>
                  retainInput(replaceInputRef.current, replace.onReplaceAll)
                }
                className="terax-find-widget__replace-all"
              >
                <HugeiconsIcon
                  icon={ReplaceAllIcon}
                  size={14}
                  strokeWidth={1.8}
                />
              </FindButton>
            </div>
          </div>
        ) : null}
      </div>
    );
  },
);

export const FindWidget = forwardRef<FindWidgetHandle, FindWidgetProps>(
  function FindWidget(props, ref) {
    return <FindWidgetBase {...props} ref={ref} />;
  },
);

export const FindReplaceWidget = forwardRef<
  FindWidgetHandle,
  FindReplaceWidgetProps
>(function FindReplaceWidget({ replace, ...props }, ref) {
  return <FindWidgetBase {...props} replace={replace} ref={ref} />;
});
