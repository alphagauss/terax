/** Markdown 表格共用复制、原生另存为和全屏操作，格式转换由 Streamdown 负责。 */
import { writeClipboardHtml } from "@/lib/clipboard";
import { Button } from "@/components/controls/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/controls/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/menu/dropdown-menu";
import { cn } from "@/lib/utils";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import Copy01Icon from "@hugeicons/core-free-icons/Copy01Icon";
import Download01Icon from "@hugeicons/core-free-icons/Download01Icon";
import MaximizeScreenIcon from "@hugeicons/core-free-icons/MaximizeScreenIcon";
import Tick02Icon from "@hugeicons/core-free-icons/Tick02Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import {
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { reportError } from "@/lib/errors";
import {
  extractTableDataFromElement,
  StreamdownContext,
  tableDataToCSV,
  tableDataToMarkdown,
  tableDataToTSV,
} from "streamdown";

type Format = "markdown" | "csv" | "tsv";
type Action = "copy" | "download";
const formats: Format[] = ["markdown", "csv", "tsv"];

function tableHeight(value: number | string): string | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? `${value}px` : undefined;
  }
  return value === "0" || value === "none" || value === "Infinity"
    ? undefined
    : value;
}

/** 正文和全屏共用操作状态，但只允许当前可见工具栏展开菜单。 */
export function MarkdownTable({
  children,
  className,
  node: _node,
  ...props
}: ComponentProps<"table"> & { node?: unknown }) {
  const tableRef = useRef<HTMLTableElement>(null);
  const copyTimer = useRef(0);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [menu, setMenu] = useState<Action | null>(null);
  const { controls, isAnimating, tableMaxHeight } =
    useContext(StreamdownContext);
  const maxHeight = tableHeight(tableMaxHeight);
  const { t } = useTranslation("markdown");
  const tableControls =
    typeof controls === "object" ? controls.table : controls;
  const options = typeof tableControls === "object" ? tableControls : {};
  const disabled = isAnimating || saving;
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  async function perform(action: Action, format: Format) {
    setMenu(null);
    try {
      const table = tableRef.current;
      if (!table) throw new Error(t("table.notFound"));
      const data = extractTableDataFromElement(table);
      const content =
        format === "markdown"
          ? tableDataToMarkdown(data)
          : format === "csv"
            ? tableDataToCSV(data, options.csvSeparator ?? ",")
            : tableDataToTSV(data);
      if (action === "download") {
        setSaving(true);
        const extension = format === "markdown" ? "md" : format;
        const filename =
          typeof options.download === "object"
            ? options.download.filename
            : "table";
        const saved = await invoke<boolean>("text_save_as", {
          // CSV 保留 BOM，供桌面表格软件识别中文编码。
          content: format === "csv" ? `\uFEFF${content}` : content,
          filename: `${filename}.${extension}`,
          extension,
          title: t("table.save"),
          fileFilter: t(`table.format.${format}`),
        });
        if (saved) toast.success(t("table.downloaded"));
      } else {
        await writeClipboardHtml(table.outerHTML, content);
        setCopied(true);
        window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => setCopied(false), 2_000);
      }
    } catch (error) {
      reportError(t(`table.${action}Failed`, { message: String(error) }), {
        error,
      });
    } finally {
      if (action === "download") setSaving(false);
    }
  }

  function actions(expanded = false) {
    if (tableControls === false) return null;
    return (
      <div className="flex items-center justify-end gap-1">
        {(["copy", "download"] as const).map(
          (action) =>
            options[action] !== false && (
              <DropdownMenu
                key={action}
                open={fullscreen === expanded && menu === action}
                onOpenChange={(open) =>
                  setMenu((current) =>
                    open ? action : current === action ? null : current,
                  )
                }
              >
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled={disabled}
                    aria-label={t(
                      `table.${action === "copy" && copied ? "copied" : action}`,
                    )}
                  >
                    <HugeiconsIcon
                      size={14}
                      icon={
                        action === "download"
                          ? Download01Icon
                          : copied
                            ? Tick02Icon
                            : Copy01Icon
                      }
                    />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {formats.map((format) => (
                    <DropdownMenuItem
                      key={format}
                      disabled={disabled}
                      onSelect={() => void perform(action, format)}
                    >
                      {t(`table.format.${format}`)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ),
        )}
        {expanded ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t("table.exitFullscreen")}
            onClick={() => setFullscreen(false)}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={20} />
          </Button>
        ) : (
          options.fullscreen !== false && (
            <DialogTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={disabled}
                aria-label={t("table.viewFullscreen")}
              >
                <HugeiconsIcon icon={MaximizeScreenIcon} size={14} />
              </Button>
            </DialogTrigger>
          )
        )}
      </div>
    );
  }

  const table = (expanded = false) => (
    <table
      {...props}
      ref={expanded ? undefined : tableRef}
      data-streamdown="table"
      className={cn(
        "w-full",
        expanded
          ? "border-collapse border border-border"
          : "divide-y divide-border",
        className,
      )}
    >
      {children}
    </table>
  );
  return (
    <Dialog
      open={fullscreen}
      onOpenChange={(open) => {
        setMenu(null);
        setFullscreen(open);
      }}
    >
      <div
        className="my-4 flex flex-col gap-2 rounded-lg border border-border bg-sidebar p-2"
        data-streamdown="table-wrapper"
      >
        {actions()}
        <div
          className="overflow-auto rounded-md border border-border bg-background"
          data-markdown-table-scroll={maxHeight ? "" : undefined}
          style={{ maxHeight }}
        >
          {table()}
        </div>
      </div>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="inset-0 flex h-full max-w-none translate-x-0 translate-y-0 flex-col gap-2 rounded-none bg-background sm:max-w-none"
        data-streamdown="table-fullscreen"
      >
        <DialogTitle className="sr-only">
          {t("table.viewFullscreen")}
        </DialogTitle>
        {actions(true)}
        <div className="min-h-0 flex-1 overflow-auto [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10">
          {table(true)}
        </div>
      </DialogContent>
    </Dialog>
  );
}
