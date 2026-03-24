"use client";

import {
  type ColumnDef,
  type SortingState,
  type RowSelectionState,
  type VisibilityState,
  type Table as TanstackTable,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, SlidersHorizontal } from "lucide-react";

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  pageSize?: number;
  onRowClick?: (row: TData) => void;
  rowSelection?: RowSelectionState;
  onRowSelectionChange?: (selection: RowSelectionState) => void;
  columnVisibility?: VisibilityState;
  onColumnVisibilityChange?: (visibility: VisibilityState) => void;
  defaultColumnVisibility?: VisibilityState;
  meta?: Record<string, unknown>;
}

export function DataTable<TData, TValue>({
  columns,
  data,
  pageSize = 20,
  onRowClick,
  rowSelection,
  onRowSelectionChange,
  columnVisibility: controlledVisibility,
  onColumnVisibilityChange,
  defaultColumnVisibility,
  meta,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [internalSelection, setInternalSelection] = useState<RowSelectionState>({});
  const [internalVisibility, setInternalVisibility] = useState<VisibilityState>(
    defaultColumnVisibility ?? {},
  );

  const selection = rowSelection ?? internalSelection;
  const setSelection = onRowSelectionChange ?? setInternalSelection;
  const visibility = controlledVisibility ?? internalVisibility;
  const setVisibility = onColumnVisibilityChange ?? setInternalVisibility;

  const table = useReactTable({
    data,
    columns,
    state: { sorting, rowSelection: selection, columnVisibility: visibility },
    onSortingChange: setSorting,
    onColumnVisibilityChange: (updater) => {
      const next = typeof updater === "function" ? updater(visibility) : updater;
      setVisibility(next);
    },
    onRowSelectionChange: (updater) => {
      const next = typeof updater === "function" ? updater(selection) : updater;
      setSelection(next);
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
    meta,
  });

  return (
    <div>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && "selected"}
                  className={onRowClick ? "cursor-pointer" : undefined}
                  onClick={() => onRowClick?.(row.original)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                  No results.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {table.getPageCount() > 1 && (
        <div className="flex items-center justify-center gap-2 pt-3">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.previousPage()}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="text-[13px] tabular-nums text-muted-foreground">
            {table.getState().pagination.pageIndex + 1} / {table.getPageCount()}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            disabled={!table.getCanNextPage()}
            onClick={() => table.nextPage()}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

export function DataTableColumnToggle<TData>({
  columns,
  visibility,
  onVisibilityChange,
}: {
  columns: ColumnDef<TData, unknown>[];
  visibility: VisibilityState;
  onVisibilityChange: (visibility: VisibilityState) => void;
}) {
  const toggleableColumns = columns.filter(
    (col) => col.enableHiding !== false && (col.id || ("accessorKey" in col && col.accessorKey)),
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <SlidersHorizontal className="size-3.5" />
          Columns
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>Toggle columns</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {toggleableColumns.map((col) => {
          const id = col.id || ("accessorKey" in col ? (col.accessorKey as string) : "");
          if (!id) return null;
          const isVisible = visibility[id] !== false;
          return (
            <DropdownMenuCheckboxItem
              key={id}
              checked={isVisible}
              onCheckedChange={(checked) =>
                onVisibilityChange({ ...visibility, [id]: !!checked })
              }
              className="capitalize"
            >
              {typeof col.header === "string"
                ? col.header
                : id.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase())}
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
