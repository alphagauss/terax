/**
 * 本文件实现聊天与文档共用的 Markdown 代码块。
 *
 * 负责延迟高亮、复制操作和 Mermaid 渲染，流式阶段避免解析未完成代码。
 */

"use client";

import { Hint } from "@/components/controls/tooltip";
import { cn } from "@/lib/utils";
import { useTheme } from "@/modules/theme";
import type { MermaidConfig } from "@streamdown/mermaid";
import {
  ArrowAllDirectionIcon,
  Copy01Icon,
  FitToScreenIcon,
  Tick02Icon,
  ZoomInAreaIcon,
  ZoomOutAreaIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { createContext, memo, useContext, useEffect, useRef, useState } from "react";
import { useIsCodeFenceIncomplete } from "streamdown";

import { Shimmer } from "@/components/controls/shimmer";
import { highlight, isHighlightable, type HighlightedNode } from "./chat-code-lezer";

// True while the parent message is still streaming from the model. We hide
// fenced-code contents during this phase: parsing partial code is wasted
// work and a flashing skeleton is calmer UI than text that grows char-by-char.
const StreamingCtx = createContext(false);
export const ChatStreamingProvider = StreamingCtx.Provider;

const POSIX_SHELL = new Set([
  "bash",
  "sh",
  "zsh",
  "shell",
  "console",
  "shellscript",
]);
const DIAGRAM_LANGS = new Set(["mermaid"]);

type MermaidInstance = import("@streamdown/mermaid").MermaidInstance;

let mermaidInstance: Promise<MermaidInstance> | null = null;
let mermaidRenderId = 0;

function loadMermaid(): Promise<MermaidInstance> {
  mermaidInstance ??= import("@streamdown/mermaid").then(
    ({ createMermaidPlugin }) => {
      const plugin = createMermaidPlugin({
        config: {
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
        },
      });
      return plugin.getMermaid();
    },
  );
  return mermaidInstance;
}

function mermaidConfig(
  mode: "light" | "dark",
  documentContext: boolean,
): MermaidConfig {
  if (!documentContext) {
    return {
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: mode === "dark" ? "dark" : "default",
      fontFamily: "JetBrains Mono, sans-serif",
    };
  }

  const styles = getComputedStyle(document.documentElement);
  const color = (name: string) => styles.getPropertyValue(name).trim();
  const background = color("--background");
  const foreground = color("--foreground");
  const muted = color("--muted");
  const border = color("--muted-foreground");

  return {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: "base",
    fontFamily: "Inter Variable, Segoe UI, sans-serif",
    themeVariables: {
      background,
      primaryColor: muted,
      primaryTextColor: foreground,
      primaryBorderColor: border,
      secondaryColor: color("--secondary"),
      secondaryTextColor: foreground,
      secondaryBorderColor: border,
      tertiaryColor: background,
      tertiaryTextColor: foreground,
      tertiaryBorderColor: border,
      lineColor: border,
      textColor: foreground,
      mainBkg: muted,
      nodeBorder: border,
      clusterBkg: background,
      clusterBorder: border,
      edgeLabelBackground: background,
    },
  };
}

function normalizeLangLabel(raw: string): string {
  const lower = raw.toLowerCase();
  if (POSIX_SHELL.has(lower)) return "bash";
  if (lower === "pwsh" || lower === "ps1" || lower === "ps") return "powershell";
  if (lower === "bat" || lower === "batch") return "cmd";
  return lower || "text";
}

export function isDiagramLanguage(raw: string | null): boolean {
  return DIAGRAM_LANGS.has(normalizeLangLabel(raw ?? ""));
}

export type ChatCodeBlockProps = {
  code: string;
  lang: string | null;
  variant?: "chat" | "document";
};

/**
 * Markdown 围栏代码块。
 *
 * 普通代码在聊天和文档中使用同一只读外壳，文档上下文仅扩展 Mermaid 浏览能力。
 */
export function ChatCodeBlock({
  code,
  lang,
  variant = "chat",
}: ChatCodeBlockProps) {
  const streaming = useContext(StreamingCtx);
  const label = normalizeLangLabel(lang ?? "");

  if (streaming) {
    return <GeneratingPlaceholder label={label} />;
  }

  if (isDiagramLanguage(lang)) {
    return (
      <MermaidCode
        code={code}
        documentContext={variant === "document"}
      />
    );
  }

  return <FinalizedCodeBlock code={code} lang={label} />;
}

function GeneratingPlaceholder({ label }: { label: string }) {
  return (
    <div className="not-prose my-2 flex items-center gap-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
      <span className="inline-block size-1.5 animate-pulse rounded-full bg-muted-foreground/60" />
      <Shimmer as="span">
        {label === "text" ? "Generating code…" : `Generating ${label}…`}
      </Shimmer>
    </div>
  );
}

function MermaidCode({
  code,
  documentContext,
}: {
  code: string;
  documentContext: boolean;
}) {
  const isIncomplete = useIsCodeFenceIncomplete();
  const { resolvedMode } = useTheme();
  const [state, setState] = useState<
    | { kind: "waiting" }
    | { kind: "loading" }
    | { kind: "ready"; svg: string }
    | { kind: "error"; message: string }
  >({ kind: "waiting" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: isIncomplete ? "waiting" : "loading" });

    if (isIncomplete || !code.trim()) {
      return () => {
        cancelled = true;
      };
    }

    const id = `terax-mermaid-${++mermaidRenderId}`;
    void loadMermaid()
      .then((mermaid) => {
        mermaid.initialize(mermaidConfig(resolvedMode, documentContext));
        return mermaid.render(id, code);
      })
      .then(({ svg }) => {
        if (!cancelled) setState({ kind: "ready", svg });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message =
          error instanceof Error ? error.message : "Mermaid syntax error";
        setState({ kind: "error", message });
      });

    return () => {
      cancelled = true;
    };
  }, [code, documentContext, isIncomplete, resolvedMode]);

  if (documentContext && state.kind === "ready") {
    return <MermaidViewport key={state.svg} svg={state.svg} />;
  }

  return (
    <BlockChrome label="mermaid" code={code}>
      {state.kind === "ready" ? (
        <div
          role="img"
          aria-label="Mermaid diagram"
          className="flex min-h-32 justify-center overflow-auto bg-background/40 p-4"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG 由启用 strict 安全模式的 Mermaid 生成。
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      ) : state.kind === "error" ? (
        <pre className="text-foreground">
          {code}
          {"\n\n"}
          <span className="text-destructive">{state.message}</span>
        </pre>
      ) : state.kind === "waiting" ? (
        <pre className="text-foreground">
          {code}
        </pre>
      ) : (
        <div className="flex min-h-32 items-center justify-center px-3 py-6 text-[11px] text-muted-foreground">
          Rendering diagram…
        </div>
      )}
    </BlockChrome>
  );
}

const MERMAID_MIN_ZOOM = 0.5;
const MERMAID_MAX_ZOOM = 3;
const MERMAID_ZOOM_STEP = 0.2;

type MermaidView = { scale: number; x: number; y: number };

function MermaidViewport({ svg }: { svg: string }) {
  const [panEnabled, setPanEnabled] = useState(false);
  const [view, setView] = useState<MermaidView>({ scale: 1, x: 0, y: 0 });
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const zoom = (delta: number) => {
    setView((current) => ({
      ...current,
      scale: Math.max(
        MERMAID_MIN_ZOOM,
        Math.min(MERMAID_MAX_ZOOM, current.scale + delta),
      ),
    }));
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!panEnabled || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: view.x,
      originY: view.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    setView((current) => ({
      ...current,
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY,
    }));
  };

  const handlePointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const reset = () => setView({ scale: 1, x: 0, y: 0 });

  return (
    <div
      data-markdown-interactive="mermaid"
      className="relative my-4 min-h-32 overflow-hidden rounded-md border border-transparent bg-background transition-colors duration-150 hover:border-border/70 focus-within:border-border/70"
    >
      <div
        data-markdown-visual-toolbar
        className="flex items-center"
      >
        <DiagramButton
          label="Pan diagram"
          active={panEnabled}
          onClick={() => setPanEnabled((enabled) => !enabled)}
          icon={ArrowAllDirectionIcon}
        />
        <DiagramButton
          label="Zoom out"
          disabled={view.scale <= MERMAID_MIN_ZOOM}
          onClick={() => zoom(-MERMAID_ZOOM_STEP)}
          icon={ZoomOutAreaIcon}
        />
        <DiagramButton
          label="Zoom in"
          disabled={view.scale >= MERMAID_MAX_ZOOM}
          onClick={() => zoom(MERMAID_ZOOM_STEP)}
          icon={ZoomInAreaIcon}
        />
        <DiagramButton
          label="Fit diagram"
          onClick={reset}
          icon={FitToScreenIcon}
        />
      </div>
      <div
        data-markdown-mermaid-viewport
        className={cn(
          "flex min-h-32 items-center justify-center overflow-hidden p-4",
          panEnabled && "cursor-grab active:cursor-grabbing",
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onWheel={(event) => {
          if (!event.ctrlKey) return;
          event.preventDefault();
          zoom(event.deltaY > 0 ? -MERMAID_ZOOM_STEP : MERMAID_ZOOM_STEP);
        }}
      >
        <div
          role="img"
          aria-label="Mermaid diagram"
          className="flex w-full max-w-full origin-center justify-center transition-transform duration-150 ease-out"
          style={{
            transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`,
          }}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG 由启用 strict 安全模式的 Mermaid 生成。
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );
}

function DiagramButton({
  label,
  icon,
  active = false,
  disabled = false,
  onClick,
}: {
  label: string;
  icon: typeof ArrowAllDirectionIcon;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Hint content={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active || undefined}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          "flex size-7 items-center justify-center rounded-sm transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
          active && "bg-accent text-foreground",
        )}
      >
        <HugeiconsIcon icon={icon} size={16} strokeWidth={1.6} />
      </button>
    </Hint>
  );
}

function BlockChrome({
  label,
  code,
  children,
}: {
  label: string;
  code: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-markdown-code-block
      className="not-prose overflow-hidden"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-muted-foreground">
          {label}
        </span>
        <CopyButton text={code} />
      </div>
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

function FinalizedCodeBlock({ code, lang }: { code: string; lang: string }) {
  if (!isHighlightable(lang)) {
    return (
      <BlockChrome label={lang} code={code}>
        <pre className="text-foreground">
          {code}
        </pre>
      </BlockChrome>
    );
  }
  return (
    <BlockChrome label={lang} code={code}>
      <HighlightedPre code={code} lang={lang} />
    </BlockChrome>
  );
}

const HighlightedPre = memo(function HighlightedPre({
  code,
  lang,
}: {
  code: string;
  lang: string;
}) {
  const [nodes, setNodes] = useState<HighlightedNode[] | null>(null);
  const cancelRef = useRef(false);

  useEffect(() => {
    cancelRef.current = false;
    let cancelled = false;
    highlight(code, lang)
      .then((result) => {
        if (cancelled || cancelRef.current) return;
        setNodes(result);
      })
      .catch(() => {
        if (cancelled) return;
        setNodes(null);
      });
    return () => {
      cancelled = true;
      cancelRef.current = true;
    };
  }, [code, lang]);

  if (!nodes) {
    return (
      <pre className="text-foreground">
        {code}
      </pre>
    );
  }

  return (
    <pre className="text-foreground">
      {nodes.map((node, i) =>
        node.kind === "break" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: 高亮节点是无状态文本，随整段代码重新生成。
          <span key={i}>{"\n"}</span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: 高亮节点是无状态文本，随整段代码重新生成。
          <span key={i} className={node.cls || undefined}>
            {node.value}
          </span>
        ),
      )}
    </pre>
  );
});

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const tRef = useRef<number>(0);

  useEffect(() => () => window.clearTimeout(tRef.current), []);

  const onCopy = async () => {
    if (!navigator?.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      tRef.current = window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      /* swallow */
    }
  };

  return (
    <button
      aria-label="Copy code"
      className="cursor-pointer p-1 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      onClick={onCopy}
      type="button"
    >
      <HugeiconsIcon
        icon={copied ? Tick02Icon : Copy01Icon}
        size={14}
      />
    </button>
  );
}
