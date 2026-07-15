"use client";

import { useState } from "react";
import { Loader2, Sparkles } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { StudioFormat } from "@/lib/studio-prompt";
import { StudioComposer } from "./studio-composer";
import type { ComposerReference } from "./studio-types";

export type StudioDialogValue = {
  brief: string;
  format: StudioFormat;
  count: number;
  references: ComposerReference[];
  copyPackageId?: string | null;
};

export function StudioCreateDialog({
  open,
  onOpenChange,
  title = "Start from scratch",
  description = "A focused brief, image size, and optional reference images.",
  initialValue,
  copyPackages = [],
  pending,
  submitLabel = "Generate",
  onSubmit,
  secondaryAction,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  description?: string;
  initialValue?: Partial<StudioDialogValue>;
  copyPackages?: Array<{ id: string; name: string }>;
  pending: boolean;
  submitLabel?: string;
  onSubmit: (value: StudioDialogValue) => void;
  secondaryAction?: {
    label: string;
    pending?: boolean;
    onClick: (value: StudioDialogValue) => void;
  };
}) {
  const [brief, setBrief] = useState(initialValue?.brief ?? "");
  const [format, setFormat] = useState<StudioFormat>(
    initialValue?.format ?? "square",
  );
  const [count, setCount] = useState(initialValue?.count ?? 3);
  const [references, setReferences] = useState<ComposerReference[]>(
    initialValue?.references ?? [],
  );
  const [copyPackageId, setCopyPackageId] = useState(
    initialValue?.copyPackageId ?? "none",
  );
  const value = {
    brief,
    format,
    count,
    references,
    copyPackageId: copyPackageId === "none" ? null : copyPackageId,
  };
  const disabled = !brief.trim() || pending || secondaryAction?.pending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <StudioComposer
          value={brief}
          onChange={setBrief}
          pending={pending || Boolean(secondaryAction?.pending)}
          count={count}
          onCountChange={setCount}
          format={format}
          onFormatChange={setFormat}
          references={references}
          onAddReference={(reference) =>
            setReferences((current) =>
              current.some((item) => item.url === reference.url)
                ? current
                : [...current, reference].slice(0, 4),
            )
          }
          onRemoveReference={(url) =>
            setReferences((current) => current.filter((item) => item.url !== url))
          }
          onSubmit={() => {
            if (!disabled) onSubmit(value);
          }}
          autoFocus
        />
        {copyPackages.length > 0 ? (
          <div className="space-y-1.5">
            <label htmlFor="studio-copy-package" className="text-sm font-medium">
              Copy package
            </label>
            <Select value={copyPackageId} onValueChange={setCopyPackageId}>
              <SelectTrigger id="studio-copy-package" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {copyPackages.map((pkg) => (
                  <SelectItem key={pkg.id} value={pkg.id}>
                    {pkg.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          {secondaryAction ? (
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() => secondaryAction.onClick(value)}
            >
              {secondaryAction.pending ? <Loader2 className="animate-spin" /> : null}
              {secondaryAction.label}
            </Button>
          ) : null}
          <Button disabled={disabled} onClick={() => onSubmit(value)}>
            {pending ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {submitLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
