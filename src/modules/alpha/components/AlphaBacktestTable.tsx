/**
 * 本文件实现 Alpha 回测结果表格。
 * 表格呈现当前接口页、统一任务进度并选择结果，不在组件内维护任务状态。
 */

import type { AlphaBacktest } from "@/modules/alpha/api";
import { cn } from "@/lib/utils";
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

type Props = {
  rows: AlphaBacktest[];
  selectedId: string | null;
  onSelect: (id: string) => void;
};

/**
 * 渲染回测结果与运行状态。
 *
 * TanStack Table 使用内部可变实例，本组件显式退出 React Compiler 自动优化。
 */
export function AlphaBacktestTable({ rows, selectedId, onSelect }: Props) {
  "use no memo";

  const { t, i18n } = useTranslation("alpha");
  const percent = useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, {
        style: "percent",
        maximumFractionDigits: 2,
      }),
    [i18n.language],
  );
  const columns = useMemo<ColumnDef<AlphaBacktest>[]>(
    () => [
      {
        accessorKey: "name",
        header: t("backtests.columns.name"),
        cell: ({ row }) => (
          <button
            type="button"
            aria-pressed={row.original.id === selectedId}
            className="font-medium text-foreground outline-none hover:underline focus-visible:underline"
            onClick={() => onSelect(row.original.id)}
          >
            {row.original.name}
          </button>
        ),
      },
      {
        accessorKey: "strategy_name",
        header: t("backtests.columns.strategy"),
      },
      {
        accessorKey: "status",
        header: t("backtests.columns.status"),
        cell: ({ getValue, row }) => {
          const status = getValue<string>();
          const statusText = t(`backtests.status.${status}`, {
            defaultValue: status,
          });
          const progress = row.original.progress;
          const progressText =
            progress?.completed != null && progress.total != null
              ? `${progress.completed}/${progress.total}`
              : null;
          const stage = row.original.stage
            ? t(`taskStages.${row.original.stage}`, {
                defaultValue: row.original.stage,
              })
            : null;
          return [statusText, stage, progressText].filter(Boolean).join(" · ");
        },
      },
      {
        accessorKey: "total_return",
        header: t("backtests.columns.return"),
        cell: ({ getValue }) => {
          const value = getValue<number | null>();
          return value === null
            ? t("common.unavailable")
            : percent.format(value);
        },
      },
      {
        accessorKey: "created_at",
        header: t("backtests.columns.created"),
        cell: ({ getValue }) =>
          getValue<string | null>() ?? t("common.unavailable"),
      },
    ],
    [onSelect, percent, selectedId, t],
  );
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
  });

  return (
    <div className="max-h-96 overflow-auto rounded-lg border border-border/70">
      <table className="w-full min-w-150 border-collapse text-left text-xs">
        <thead className="sticky top-0 z-10 bg-muted">
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th
                  key={header.id}
                  className="h-8 border-b border-border px-3 font-medium text-muted-foreground"
                >
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.id}
              className={cn(
                "border-b border-border/50 last:border-b-0",
                row.original.id === selectedId && "bg-interactive-active",
              )}
            >
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className="h-9 whitespace-nowrap px-3">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
