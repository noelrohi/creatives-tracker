"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ImagePlus,
  Loader2,
  X,
} from "@/components/icons";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  isSupportedStudioSize,
  studioDimensions,
  type StudioSize,
} from "@/lib/studio-prompt";
import { cn } from "@/lib/utils";
import type { ComposerReference, StudioFormat } from "./studio-types";

const MAX_REFERENCES = 4;
const DEFAULT_CUSTOM_SIZE: StudioSize = "1024x1536";

function isPrimaryFormat(format: StudioFormat) {
  return format === "square" || format === "vertical";
}

type UploadingItem = {
  id: string;
  name: string;
};

type StudioComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  pending: boolean;
  count: number;
  onCountChange: (count: number) => void;
  format: StudioFormat;
  onFormatChange: (format: StudioFormat) => void;
  references?: ComposerReference[];
  onAddReference?: (reference: ComposerReference) => void;
  onRemoveReference?: (url: string) => void;
  className?: string;
  autoFocus?: boolean;
  focusToken?: number;
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function StudioComposer({
  value,
  onChange,
  onSubmit,
  pending,
  count,
  onCountChange,
  format,
  onFormatChange,
  references = [],
  onAddReference,
  onRemoveReference,
  className,
  autoFocus,
  focusToken,
}: StudioComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<UploadingItem[]>([]);
  const [sizeOpen, setSizeOpen] = useState(false);
  const initialDimensions = studioDimensions(
    isPrimaryFormat(format) ? DEFAULT_CUSTOM_SIZE : format,
  );
  const [customWidth, setCustomWidth] = useState(String(initialDimensions.width));
  const [customHeight, setCustomHeight] = useState(String(initialDimensions.height));
  const customMode = !isPrimaryFormat(format);
  const customSize = `${customWidth}x${customHeight}`;
  const customSizeValid = isSupportedStudioSize(customSize);

  useEffect(() => {
    if (focusToken == null) return;
    textareaRef.current?.focus();
  }, [focusToken]);

  useEffect(() => {
    if (!customMode) return;
    const dimensions = studioDimensions(format);
    setCustomWidth(String(dimensions.width));
    setCustomHeight(String(dimensions.height));
  }, [customMode, format]);

  const uploading = uploads.length > 0;
  const canSend =
    value.trim().length > 0 &&
    !pending &&
    !uploading &&
    (!customMode || customSizeValid);
  const usedSlots = references.length + uploads.length;
  const canAttach = onAddReference != null && usedSlots < MAX_REFERENCES;

  function updateCustomSize(width: string, height: string) {
    setCustomWidth(width);
    setCustomHeight(height);
    const next = `${width}x${height}`;
    if (isSupportedStudioSize(next)) onFormatChange(next);
  }

  function activateCustomSize() {
    if (customMode) return;
    onFormatChange(customSizeValid ? (customSize as StudioSize) : DEFAULT_CUSTOM_SIZE);
  }

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || !onAddReference) return;
    const files = Array.from(fileList).filter((file) =>
      file.type.startsWith("image/"),
    );
    let remaining = MAX_REFERENCES - (references.length + uploads.length);
    for (const file of files) {
      if (remaining <= 0) {
        toast.error(`You can attach up to ${MAX_REFERENCES} reference images.`);
        break;
      }
      remaining -= 1;
      const id = crypto.randomUUID();
      setUploads((prev) => [...prev, { id, name: file.name }]);
      try {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/api/upload", { method: "POST", body: form });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(body?.error ?? "Upload failed");
        }
        const { url } = (await res.json()) as { url: string };
        onAddReference({
          url,
          label: file.name,
          description: formatBytes(file.size),
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Upload failed");
      } finally {
        setUploads((prev) => prev.filter((item) => item.id !== id));
      }
    }
  }

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
        onPaste={(event) => {
          if (!canAttach) return;
          const files = Array.from(event.clipboardData.files).filter((file) =>
            file.type.startsWith("image/"),
          );
          if (files.length === 0) return;
          event.preventDefault();
          const transfer = new DataTransfer();
          for (const file of files) transfer.items.add(file);
          void handleFiles(transfer.files);
        }}
        placeholder="Describe the static ad — angle, offer, hook…"
        className="max-h-40 min-h-[52px] resize-none border-0 bg-transparent px-4 pt-4 text-base shadow-none focus-visible:ring-0 dark:bg-transparent"
      />

      {references.length > 0 || uploads.length > 0 ? (
        <AttachmentGroup className="px-3 pb-1">
          {references.map((reference) => (
            <Attachment key={reference.url} size="sm">
              <AttachmentMedia variant="image">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={reference.url} alt={reference.label} />
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle>{reference.label}</AttachmentTitle>
                {reference.description ? (
                  <AttachmentDescription>{reference.description}</AttachmentDescription>
                ) : null}
              </AttachmentContent>
              {onRemoveReference ? (
                <AttachmentActions>
                  <AttachmentAction
                    aria-label={`Remove ${reference.label}`}
                    onClick={() => onRemoveReference(reference.url)}
                  >
                    <X />
                  </AttachmentAction>
                </AttachmentActions>
              ) : null}
            </Attachment>
          ))}
          {uploads.map((item) => (
            <Attachment key={item.id} size="sm" state="uploading">
              <AttachmentMedia variant="image">
                <ImagePlus />
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle>{item.name}</AttachmentTitle>
                <AttachmentDescription>Uploading…</AttachmentDescription>
              </AttachmentContent>
            </Attachment>
          ))}
        </AttachmentGroup>
      ) : null}

      <div className="flex items-center gap-1 px-3 pb-3">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            void handleFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Attach reference image"
          disabled={!canAttach}
          onClick={() => fileInputRef.current?.click()}
          className="rounded-full text-muted-foreground"
        >
          <ImagePlus className="size-4" />
        </Button>

        <div className="ml-auto flex items-center gap-2">
          <Popover
            open={sizeOpen}
            onOpenChange={(next) => {
              if (!next && !isSupportedStudioSize(`${customWidth}x${customHeight}`)) {
                const dimensions = studioDimensions(
                  customMode ? format : DEFAULT_CUSTOM_SIZE,
                );
                setCustomWidth(String(dimensions.width));
                setCustomHeight(String(dimensions.height));
              }
              setSizeOpen(next);
            }}
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex h-8 w-auto items-center justify-between gap-1 rounded-[min(var(--radius-md),10px)] border border-input bg-transparent px-2.5 text-xs whitespace-nowrap transition-colors hover:bg-accent dark:bg-input/30 dark:hover:bg-input/50"
              >
                {format === "square"
                  ? "1:1"
                  : format === "vertical"
                    ? "9:16"
                    : `${studioDimensions(format).width}×${studioDimensions(format).height}`}
                <ChevronDown className="size-3.5 opacity-50" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-48 p-2">
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs hover:bg-accent"
                onClick={() => {
                  onFormatChange("square");
                  setSizeOpen(false);
                }}
              >
                <span>1:1 · Square</span>
                {!customMode && format === "square" ? (
                  <Check className="size-3.5" />
                ) : null}
              </button>
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs hover:bg-accent"
                onClick={() => {
                  onFormatChange("vertical");
                  setSizeOpen(false);
                }}
              >
                <span>9:16 · Vertical</span>
                {!customMode && format === "vertical" ? (
                  <Check className="size-3.5" />
                ) : null}
              </button>
              <Separator className="my-2" />
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs hover:bg-accent"
                onClick={activateCustomSize}
              >
                <span>Custom size</span>
                {customMode ? <Check className="size-3.5" /> : null}
              </button>
              <div className="mt-1.5 flex items-center gap-2 px-2">
                <Input
                  type="number"
                  inputMode="numeric"
                  min={16}
                  max={3840}
                  step={16}
                  value={customWidth}
                  onChange={(event) =>
                    updateCustomSize(event.target.value, customHeight)
                  }
                  onFocus={activateCustomSize}
                  aria-label="Image width"
                  aria-invalid={!customSizeValid}
                  className="h-7 min-w-0 flex-1 bg-background px-2 text-xs tabular-nums"
                />
                <span className="text-xs text-muted-foreground">×</span>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={16}
                  max={3840}
                  step={16}
                  value={customHeight}
                  onChange={(event) =>
                    updateCustomSize(customWidth, event.target.value)
                  }
                  onFocus={activateCustomSize}
                  aria-label="Image height"
                  aria-invalid={!customSizeValid}
                  className="h-7 min-w-0 flex-1 bg-background px-2 text-xs tabular-nums"
                />
              </div>
              {!customSizeValid ? (
                <p className="mt-1.5 px-2 text-[11px] text-destructive">
                  Use multiples of 16, 655K–8.3M total pixels, up to 3840px, and a ratio from 1:3 to 3:1.
                </p>
              ) : null}
            </PopoverContent>
          </Popover>
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
            {pending || uploading ? (
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
