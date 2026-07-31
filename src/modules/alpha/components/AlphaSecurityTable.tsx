/**
 * 本文件实现 Alpha 数据管理页的证券表格。
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
            onClick={() => onSelect(row.original.vt_symbol)}
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
        accessorKey: "product",
        header: t("data.columns.product"),
      },
      {
        accessorKey: "latest_bar_date",
        header: t("data.columns.latest"),
        cell: ({ getValue }) =>
          getValue<string | null>() ?? t("common.unavailable"),
      },
    ],
    [onSelect, selectedSymbol, t],
  );
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.vt_symbol,
  });

  return (
    <div className="max-h-96 overflow-auto rounded-lg border border-border/70">
      <table className="w-full min-w-125 border-collapse text-left text-xs">
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
                row.original.vt_symbol === selectedSymbol && "bg-muted/70",
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
