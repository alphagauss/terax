/**
 * 本文件实现终端命令块的悬浮操作层。
 * 负责命令块操作、AI 入口及相关下拉菜单，不持有终端会话生命周期。
 */

import { writeClipboardText } from "@/lib/clipboard";
import { Button } from "@/components/controls/button";
import { Hint } from "@/components/controls/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuPortal,
} from "@/components/menu/dropdown-menu";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/modules/ai/store/chatStore";
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import ArrowUp01Icon from "@hugeicons/core-free-icons/ArrowUp01Icon";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import Clock01Icon from "@hugeicons/core-free-icons/Clock01Icon";
import ComputerTerminal02Icon from "@hugeicons/core-free-icons/ComputerTerminal02Icon";
import Copy01Icon from "@hugeicons/core-free-icons/Copy01Icon";
import MoreHorizontalIcon from "@hugeicons/core-free-icons/MoreHorizontalIcon";
import Refresh01Icon from "@hugeicons/core-free-icons/Refresh01Icon";
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import SparklesIcon from "@hugeicons/core-free-icons/SparklesIcon";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type {
  BlockMatch,
  PositionedBlock,
  VisibleBlocks,
} from "./lib/blockDecorations";
import { capAttachOutput } from "./lib/outputCap";

type Props = {
  hidden?: boolean;
  subscribe: (cb: () => void) => () => void;
  getVisible: () => VisibleBlocks;
  readOutput: (id: string) => string | null;
  searchBlock: (id: string, query: string) => BlockMatch[];
  revealMatch: (m: BlockMatch) => void;
  clearSearch: () => void;
  promptReady: boolean;
  onRunAgain: (command: string) => void;
  onRestoreFocus: () => void;
};

const EMPTY: VisibleBlocks = { blocks: [], recent: [], geometryVersion: 0 };

function fmtDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60000);
    const s = Math.round((ms % 60000) / 1000);
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60000);
  return m ? `${h}h ${m}m` : `${h}h`;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function copy(text: string, message: string) {
  void writeClipboardText(text)
    .then(() => toast.success(message))
    .catch(() => {});
}

function signature(v: VisibleBlocks): string {
  let s = `${v.geometryVersion}`;
  for (const b of v.blocks) {
    s += `|${b.id}:${b.actionTop}:${b.actionHeight}`;
  }
  for (const b of v.recent) s += `|recent:${b.id}:${b.canSearch}`;
  return s;
}

export function BlockOverlay(props: Props) {
  const { subscribe, getVisible, readOutput } = props;
  const [vis, setVis] = useState<VisibleBlocks>(EMPTY);
  const [searchId, setSearchId] = useState<string | null>(null);
  const lastSig = useRef("");
  const geometryVersion = useRef(0);

  useEffect(() => {
    if (props.hidden) {
      props.clearSearch();
      setSearchId(null);
    }
  }, [props.hidden, props.clearSearch]);

  useEffect(() => {
    const update = () => {
      const v = getVisible();
      const resized = v.geometryVersion !== geometryVersion.current;
      geometryVersion.current = v.geometryVersion;
      setSearchId((id) =>
        id &&
        (resized ||
          readOutput(id) === null ||
          v.recent.some((b) => b.id === id && !b.canSearch))
          ? null
          : id,
      );
      const sig = signature(v);
      if (sig === lastSig.current) return;
      lastSig.current = sig;
      setVis(v);
    };
    update();
    return subscribe(update);
  }, [subscribe, getVisible, readOutput]);

  const closeSearch = () => {
    props.clearSearch();
    setSearchId(null);
  };

  if (props.hidden) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      <div className="absolute inset-0 overflow-hidden">
        {vis.blocks.map((b) => (
          <BlockChrome
            key={b.id}
            block={b}
            all={props}
            onSearch={setSearchId}
          />
        ))}
      </div>
      {vis.recent.length > 0 && (
        <RecentBlocks blocks={vis.recent} all={props} onSearch={setSearchId} />
      )}
      {searchId && (
        <SearchBar
          key={searchId}
          blockId={searchId}
          searchBlock={props.searchBlock}
          revealMatch={props.revealMatch}
          clearSearch={props.clearSearch}
          onClose={closeSearch}
        />
      )}
    </div>
  );
}

type ChromeProps = {
  block: PositionedBlock;
  all: Props;
  onSearch: (id: string) => void;
};

/** 操作入口只在悬停或操作期间显示，完整元数据留在原有菜单内。 */
function BlockChrome({ block, all, onSearch }: ChromeProps) {
  if (block.actionTop === null) return null;
  return (
    <div
      className="bt-action"
      style={{ top: block.actionTop, height: block.actionHeight }}
    >
      <BlockMenu block={block} all={all} onSearch={onSearch} />
    </div>
  );
}

function BlockMenu({ block, all, onSearch }: ChromeProps) {
  const { t } = useTranslation("terminal");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={t("block.actions")}
          variant="secondary"
          size="icon-xs"
          className="h-full shrink-0"
        >
          <HugeiconsIcon icon={MoreHorizontalIcon} size={18} strokeWidth={2} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="left"
        align="start"
        className="w-64 max-w-[calc(100vw-16px)]"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          all.onRestoreFocus();
        }}
      >
        <BlockMenuItems block={block} all={all} onSearch={onSearch} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 失去网格定位后复用同一份菜单，复制已完成输出不依赖旧标记。 */
function RecentBlocks({
  blocks,
  all,
  onSearch,
}: Omit<ChromeProps, "block"> & { blocks: PositionedBlock[] }) {
  const { t } = useTranslation("terminal");
  return (
    <div className="bt-recent">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" size="sm">
            {t("block.recent")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-64"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            all.onRestoreFocus();
          }}
        >
          {blocks.map((block) => (
            <DropdownMenuSub key={block.id}>
              <DropdownMenuSubTrigger>
                <span className="min-w-0 flex-1 truncate font-mono">
                  {block.command || t("block.commandFallback")}
                </span>
                <span className="text-muted-foreground">
                  {fmtTime(block.startedAt)}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent className="w-64 max-w-[calc(100vw-16px)]">
                  <BlockMenuItems block={block} all={all} onSearch={onSearch} />
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function BlockMenuItems({ block, all, onSearch }: ChromeProps) {
  const { t } = useTranslation("terminal");
  const duration = fmtDuration(block.finishedAt - block.startedAt);
  const output = () => all.readOutput(block.id) ?? "";
  const attach = () => {
    const out = capAttachOutput(output());
    const text = out ? `$ ${block.command}\n${out}` : `$ ${block.command}`;
    useChatStore.getState().attachSelection({ text, source: "terminal" });
  };
  return (
    <>
      <div className="space-y-1 px-2 py-1.5 text-xs">
        {block.cwd && (
          <div className="break-all font-mono text-foreground">{block.cwd}</div>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <HugeiconsIcon icon={Clock01Icon} size={11} strokeWidth={1.75} />
            {fmtTime(block.startedAt)}
          </span>
          {duration && <span>{duration}</span>}
          {block.exitCode !== null && (
            <span className={cn(!block.ok && "text-destructive")}>
              {t("block.exit", { code: block.exitCode })}
            </span>
          )}
        </div>
      </div>
      <DropdownMenuSeparator />
      <MenuItem
        icon={Refresh01Icon}
        label={t("block.runAgain")}
        disabled={!all.promptReady || !block.command}
        onClick={() => all.onRunAgain(block.command)}
      />
      <MenuItem
        icon={Copy01Icon}
        label={t("block.copyCommand")}
        disabled={!block.command}
        onClick={() => copy(block.command, t("block.toast.commandCopied"))}
      />
      <MenuItem
        icon={ComputerTerminal02Icon}
        label={t("block.copyOutput")}
        onClick={() => {
          const o = output();
          if (o) copy(o, t("block.toast.outputCopied"));
        }}
      />
      <MenuItem
        icon={Copy01Icon}
        label={t("block.copyCommandAndOutput")}
        onClick={() => {
          const text = `$ ${block.command}\n${output()}`;
          copy(text, t("block.toast.blockCopied"));
        }}
      />
      <MenuItem
        icon={SparklesIcon}
        label={t("block.attachToAiChat")}
        onClick={attach}
      />
      <MenuItem
        icon={Search01Icon}
        label={t("block.findInBlock")}
        disabled={!block.canSearch}
        onClick={() => onSearch(block.id)}
      />
    </>
  );
}

function MenuItem({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: typeof Copy01Icon;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={onClick}
      className="gap-2 text-xs"
    >
      <HugeiconsIcon icon={icon} size={13} strokeWidth={1.75} />
      {label}
    </DropdownMenuItem>
  );
}

// One fixed search bar pinned to the top of the terminal so it stays put while
// navigating matches (the grid scrolls underneath).
function SearchBar({
  blockId,
  searchBlock,
  revealMatch,
  clearSearch,
  onClose,
}: {
  blockId: string;
  searchBlock: (id: string, query: string) => BlockMatch[];
  revealMatch: (m: BlockMatch) => void;
  clearSearch: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["terminal", "common"]);
  const [matches, setMatches] = useState<BlockMatch[]>([]);
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    return clearSearch;
  }, [clearSearch]);

  const run = (query: string) => {
    const m = searchBlock(blockId, query);
    setMatches(m);
    setIdx(0);
    if (m.length) revealMatch(m[0]);
    else clearSearch();
  };
  const nav = (dir: number) => {
    if (!matches.length) return;
    const next = (idx + dir + matches.length) % matches.length;
    setIdx(next);
    revealMatch(matches[next]);
  };

  return (
    <div className="bt-search pointer-events-auto">
      <HugeiconsIcon icon={Search01Icon} size={12} strokeWidth={1.75} />
      <input
        ref={inputRef}
        className="bt-search-input"
        placeholder={t("block.findInBlock")}
        onChange={(e) => run(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            nav(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className="bt-search-count">
        {matches.length ? `${idx + 1}/${matches.length}` : "0"}
      </span>
      <SearchBtn
        title={t("common:previous")}
        icon={ArrowUp01Icon}
        onClick={() => nav(-1)}
      />
      <SearchBtn
        title={t("common:next")}
        icon={ArrowDown01Icon}
        onClick={() => nav(1)}
      />
      <SearchBtn
        title={t("common:close")}
        icon={Cancel01Icon}
        onClick={onClose}
      />
    </div>
  );
}

function SearchBtn({
  title,
  icon,
  onClick,
}: {
  title: string;
  icon: typeof Copy01Icon;
  onClick: () => void;
}) {
  return (
    <Hint content={title}>
      <button
        aria-label={title}
        type="button"
        onClick={onClick}
        className="bt-btn"
      >
        <HugeiconsIcon icon={icon} size={13} strokeWidth={1.75} />
      </button>
    </Hint>
  );
}
