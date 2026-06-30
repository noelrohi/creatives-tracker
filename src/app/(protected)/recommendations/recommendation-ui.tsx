"use client";

import Image from "next/image";
import { useState, type ReactNode } from "react";
import { Copy, ImageIcon, TriangleAlert, Video } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function MediaPreview({
  assetUrl,
  videoUrl,
  format,
  name,
  onOpenPlayable,
}: {
  assetUrl: string | null;
  videoUrl: string | null;
  format: string | null;
  name: string;
  onOpenPlayable?: () => void;
}) {
  const href = videoUrl || assetUrl;
  const isVideo = format === "video" || format === "ugc";

  if (!href) {
    return (
      <div className="flex aspect-square w-full items-center justify-center rounded-lg bg-muted/40">
        <ImageIcon className="size-5 text-muted-foreground/30" />
      </div>
    );
  }

  const preview = (
    <>
      {assetUrl ? (
        <Image
          src={assetUrl}
          alt={name}
          fill
          sizes="112px"
          className="object-cover transition-transform duration-300 group-hover:scale-[1.03]"
        />
      ) : (
        <div className="flex size-full items-center justify-center">
          <Video className="size-5 text-muted-foreground/50" />
        </div>
      )}
      {isVideo ? (
        <div className="absolute bottom-1.5 left-1.5 flex size-6 items-center justify-center rounded-full bg-black/55 backdrop-blur-sm">
          <Video className="size-3 text-white" />
        </div>
      ) : null}
    </>
  );

  if (onOpenPlayable) {
    return (
      <button
        type="button"
        onClick={onOpenPlayable}
        aria-label={`Open Meta preview for ${name}`}
        className="group relative block aspect-square w-full overflow-hidden rounded-lg bg-muted/40 text-left ring-1 ring-border/50 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {preview}
      </button>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group relative block aspect-square w-full overflow-hidden rounded-lg bg-muted/40 ring-1 ring-border/50"
    >
      {preview}
    </a>
  );
}

export function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/45">
        {label}
      </span>
      <span className="text-sm font-semibold tabular-nums">{value}</span>
    </div>
  );
}

export function CopyButton({
  text,
  label,
  className,
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const [pending, setPending] = useState(false);

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={cn("h-6 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground", className)}
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          await navigator.clipboard.writeText(text);
          toast.success(`${label} copied`);
        } finally {
          setPending(false);
        }
      }}
    >
      <Copy className="size-3" /> Copy
    </Button>
  );
}

export function LoadError({ title, message }: { title: string; message: string }) {
  return (
    <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0">
          <p className="font-medium text-destructive">{title}</p>
          <p className="mt-1 break-words text-muted-foreground">{message}</p>
        </div>
      </div>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border/70 bg-muted/10 py-14 text-center">
      <p className="mx-auto max-w-sm text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

export function WinnerSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="rounded-xl border p-4">
          <div className="grid gap-4 sm:grid-cols-[112px_1fr]">
            <Skeleton className="aspect-square rounded-lg" />
            <div className="space-y-3">
              <Skeleton className="h-4 w-56" />
              <Skeleton className="h-3 w-full" />
              <div className="flex gap-6">
                <Skeleton className="h-8 w-12" />
                <Skeleton className="h-8 w-12" />
                <Skeleton className="h-8 w-12" />
                <Skeleton className="h-8 w-12" />
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
