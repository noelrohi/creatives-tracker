"use client";

import { useState } from "react";
import { ChevronRight } from "@/components/icons";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { howWeCount as copy } from "./copy";

export function HowWeCount({ timeZone }: { timeZone: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        {copy.trigger}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="mt-3 flex flex-col gap-2.5 rounded-md border border-border bg-muted/20 p-4">
          {copy.entries(timeZone).map((entry) => (
            <div key={entry.term} className="flex flex-col gap-0.5">
              <dt className="text-[12px] font-semibold">{entry.term}</dt>
              <dd className="text-[12px] leading-relaxed text-muted-foreground">
                {entry.body}
              </dd>
            </div>
          ))}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}
