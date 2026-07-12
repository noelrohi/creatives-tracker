"use client";

import { useRef, useState } from "react";
import { ArrowUp, ImagePlus, Loader2, X } from "lucide-react";
import { toast } from "sonner";
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
import { cn } from "@/lib/utils";
import type { ComposerReference } from "./studio-types";

const MAX_REFERENCES = 4;

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
  references?: ComposerReference[];
  onAddReference?: (reference: ComposerReference) => void;
  onRemoveReference?: (url: string) => void;
  className?: string;
  autoFocus?: boolean;
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
  references = [],
  onAddReference,
  onRemoveReference,
  className,
  autoFocus,
}: StudioComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<UploadingItem[]>([]);

  const uploading = uploads.length > 0;
  const canSend = value.trim().length > 0 && !pending && !uploading;
  const usedSlots = references.length + uploads.length;
  const canAttach = onAddReference != null && usedSlots < MAX_REFERENCES;

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
        toast.error(
          error instanceof Error ? error.message : "Upload failed",
        );
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
                  <AttachmentDescription>
                    {reference.description}
                  </AttachmentDescription>
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
      <div className="flex items-center gap-2 px-3 pb-3">
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
        <button
          type="button"
          aria-label="Attach reference image"
          disabled={!canAttach}
          onClick={() => fileInputRef.current?.click()}
          className={cn(
            "flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
          )}
        >
          <ImagePlus className="size-4" />
        </button>
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
