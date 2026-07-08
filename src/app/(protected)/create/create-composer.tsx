"use client";

import { useRef } from "react";
import { ArrowUp, Loader2, Sparkles } from "lucide-react";
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

type CreateComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  pending: boolean;
  count: number;
  onCountChange: (count: number) => void;
  activeAngle?: string;
  className?: string;
  autoFocus?: boolean;
};

export function CreateComposer({
  value,
  onChange,
  onSubmit,
  pending,
  count,
  onCountChange,
  activeAngle,
  className,
  autoFocus,
}: CreateComposerProps) {
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
      <div className="flex items-center gap-2 px-3 pb-3">
        <Badge variant="secondary" className="gap-1">
          <Sparkles className="size-3 text-primary" />
          Static
        </Badge>
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
