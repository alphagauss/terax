/**
 * 本文件实现 Alpha 数据管理场景的证券表格。
 * 表格只管理当前分页的展示状态，行情权威数据仍来自 FastAPI。
 */

import type { AlphaSecurity } from "@/modules/alpha/api";
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
  rows: AlphaSecurity[];
  selectedSymbol: string | null;
  onSelect: (vtSymbol: string) => void;
};

/**
 * 渲染证券摘要并允许选择 K 线标的。
 *
 * TanStack Table 返回内部可变实例，本组件显式退出 React Compiler 自动优化。
 */
export function AlphaSecurityTable({ rows, selectedSymbol, onSelect }: Props) {
  "use no memo";

  const { t } = useTranslation("alpha");
  const number = useMemo(() => new Intl.NumberFormat(), []);
  const columns = useMemo<ColumnDef<AlphaSecurity>[]>(
    () => [
      {
        accessorKey: "vt_symbol",
        header: t("data.columns.symbol"),
        cell: ({ row }) => (
          <button
            type="button"
            aria-pressed={row.original.vt_symbol === selectedSymbol}
            className="font-medium text-foreground outline-none hover:underline focus-visible:underline"
            onClick={(event) => {
              event.stopPropagation();
              onSelect(row.original.vt_symbol);
            }}
          >
            {row.original.vt_symbol}
          </button>
        ),
      },
      {
        accessorKey: "name",
        header: t("data.columns.name"),
      },
      {
        accessorKey: "asset_type",
        header: t("data.columns.assetType"),
        cell: ({ getValue }) =>
          getValue<string | null>() ?? t("data.values.unknown"),
      },
      {
        accessorKey: "data_state",
        header: t("data.columns.dataState"),
        cell: ({ getValue }) =>
          t(`data.states.${getValue<AlphaSecurity["data_state"]>()}`),
      },
      {
        accessorKey: "intervals",
        header: t("data.columns.intervals"),
        cell: ({ getValue }) => {
          const intervals = getValue<string[]>();
          return intervals.length > 0
            ? intervals.join(", ")
            : t("common.unavailable");
        },
      },
      {
        accessorKey: "data_end",
        header: t("data.columns.range"),
        cell: ({ getValue }) =>
          getValue<string | null>() ?? t("common.unavailable"),
      },
      {
        accessorKey: "total_bar_count",
        header: t("data.columns.rows"),
        cell: ({ getValue }) => number.format(getValue<number>()),
      },
    ],
    [number, onSelect, selectedSymbol, t],
  );
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.vt_symbol,
  });

  return (
    <div className="max-h-112 overflow-auto rounded-lg border border-border/70">
      <table className="w-full min-w-200 border-collapse text-left text-xs">
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
              tabIndex={0}
              className={cn(
                "cursor-pointer border-b border-border/50 outline-none last:border-b-0 hover:bg-interactive-hover focus-visible:bg-interactive-active",
                row.original.vt_symbol === selectedSymbol &&
                  "bg-interactive-active hover:bg-interactive-active",
              )}
              onClick={() => onSelect(row.original.vt_symbol)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(row.original.vt_symbol);
                }
              }}
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
