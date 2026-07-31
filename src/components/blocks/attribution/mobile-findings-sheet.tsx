"use client";

import { useState } from "react";
import { ChevronRight } from "@/components/icons";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { rail as copy } from "./copy";
import { FindingsRail, useOpenFindingsCount, type FindingsRailProps } from "./findings-rail";

/**
 * Under the rail breakpoint the findings live behind a status bar pinned under
 * the header; tapping it slides up the same rail content, unchanged.
 */
export function MobileFindingsSheet(props: Omit<FindingsRailProps, "variant">) {
  const [open, setOpen] = useState(false);
  const { count, critical } = useOpenFindingsCount(props.ctx);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          className="sticky top-0 z-20 flex w-full items-center gap-2 rounded-md border border-border bg-card/95 px-3 py-2 text-left backdrop-blur min-[1100px]:hidden"
        >
          {count > 0 ? (
            <span
              className="size-2 shrink-0 rounded-full"
              style={{
                backgroundColor: critical
                  ? "var(--attr-critical)"
                  : "var(--attr-warning)",
              }}
            />
          ) : (
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: "var(--attr-good)" }}
            />
          )}
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
            {count > 0 ? copy.mobileOpen(count) : copy.mobileNone}
          </span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground/50" />
        </button>
      </SheetTrigger>

      <SheetContent
        side="bottom"
        showCloseButton={false}
        style={{ height: "78svh" }}
        className="flex flex-col gap-0 p-0 min-[1100px]:hidden"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>{copy.title}</SheetTitle>
          <SheetDescription>
            {count > 0 ? copy.mobileOpen(count) : copy.mobileNone}
          </SheetDescription>
        </SheetHeader>
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border" />
        <div className="min-h-0 flex-1">
          <FindingsRail {...props} variant="sheet" />
        </div>
      </SheetContent>
    </Sheet>
  );
}
