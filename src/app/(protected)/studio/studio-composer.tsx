"use client";

import { useRef } from "react";
import { ArrowUp, Loader2, X } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { ComposerReference } from "./studio-types";

type StudioComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  pending: boolean;
  count: number;
  onCountChange: (count: number) => void;
  activeAngle?: string;
  references?: ComposerReference[];
  onRemoveReference?: (url: string) => void;
  className?: string;
  autoFocus?: boolean;
};

export function StudioComposer({
  value,
  onChange,
  onSubmit,
  pending,
  count,
  onCountChange,
  activeAngle,
  references = [],
  onRemoveReference,
  className,
  autoFocus,
}: StudioComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSend = value.trim().length > 0 && !pending;

  return (
    <div
      className={cn(
        "w-full overflow-hidden rounded-2xl border bg-card shadow-sm transition-colors focus-within:border-primary/50",
        className,
      )}
    >
      <Textarea
        ref={textareaRef}
        value={value}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (canSend) onSubmit();
          }
        }}
        placeholder="Describe the static ad — angle, offer, hook…"
        className="max-h-40 min-h-[52px] resize-none border-0 bg-transparent px-4 pt-4 text-base shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
      {references.length > 0 ? (
        <div className="flex flex-wrap gap-2 px-3 pb-1">
          {references.map((ref) => (
            <div
              key={ref.url}
              className="group/ref relative size-16 shrink-0 overflow-hidden rounded-lg border"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={ref.url} alt={ref.label} className="size-full object-cover" />
              <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent px-1 pt-2 pb-0.5 text-[10px] font-medium text-white">
                {ref.label}
              </span>
              {onRemoveReference ? (
                <button
                  type="button"
                  aria-label={`Remove ${ref.label}`}
                  onClick={() => onRemoveReference(ref.url)}
                  className="absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover/ref:opacity-100"
                >
                  <X className="size-2.5" />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-2 px-3 pb-3">
        {activeAngle ? (
          <Badge variant="outline" className="max-w-[220px] truncate">
            {activeAngle}
          </Badge>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <Select
            value={String(count)}
            onValueChange={(next) => onCountChange(Number(next))}
          >
            <SelectTrigger size="sm" className="h-8 w-auto gap-1 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {[1, 2, 3, 4].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} variant{n > 1 ? "s" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button
            type="button"
            aria-label="Generate"
            disabled={!canSend}
            onClick={() => canSend && onSubmit()}
            className={cn(
              "flex size-8 items-center justify-center rounded-full transition-colors",
              canSend
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "bg-muted text-muted-foreground",
            )}
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ArrowUp className="size-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
