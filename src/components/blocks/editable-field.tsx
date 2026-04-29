"use client";

import { useState, useRef, useEffect, type KeyboardEvent } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MultiSelect } from "@/components/multi-select";
import { FileUpload } from "@/components/file-upload";
import { cn } from "@/lib/utils";

function FieldRow({
  label,
  saving,
  children,
  className,
}: {
  label: string;
  saving?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "group grid grid-cols-[120px_1fr] items-start gap-4 rounded-md px-2 py-[7px] transition-colors hover:bg-muted/40",
        className,
      )}
    >
      <span className="flex items-center gap-1.5 pt-px text-[13px] text-muted-foreground/70 select-none">
        {label}
        {saving ? (
          <span className="inline-block size-1 animate-pulse rounded-full bg-muted-foreground/40" />
        ) : null}
      </span>
      {children}
    </div>
  );
}

function ReadOnlyValue({
  children,
  empty,
  placeholder,
}: {
  children?: React.ReactNode;
  empty?: boolean;
  placeholder?: string;
}) {
  return (
    <span
      className={cn(
        "min-h-6 px-2 text-[13px] whitespace-pre-wrap",
        empty ? "text-muted-foreground/40 italic" : "text-foreground",
      )}
    >
      {empty ? (placeholder ?? "Empty") : children}
    </span>
  );
}

// -------------------------------------------------------------------
// EditableText
// -------------------------------------------------------------------

interface EditableTextProps {
  value: string | null | undefined;
  onSave: (value: string) => void;
  placeholder?: string;
  label: string;
  saving?: boolean;
  multiline?: boolean;
  type?: string;
  readOnly?: boolean;
}

export function EditableText({
  value,
  onSave,
  placeholder = "Empty",
  label,
  saving,
  multiline,
  type,
  readOnly,
}: EditableTextProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft !== (value ?? "")) onSave(draft);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !multiline) commit();
    if (e.key === "Escape") {
      setDraft(value ?? "");
      setEditing(false);
    }
  };

  if (readOnly) {
    return (
      <FieldRow label={label}>
        <ReadOnlyValue empty={!value} placeholder={placeholder}>
          {value}
        </ReadOnlyValue>
      </FieldRow>
    );
  }

  return (
    <FieldRow label={label} saving={saving}>
      {editing ? (
        multiline ? (
          <textarea
            ref={ref as React.RefObject<HTMLTextAreaElement>}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={handleKeyDown}
            rows={3}
            className="w-full resize-none rounded bg-transparent text-[13px] text-foreground outline-none ring-1 ring-border/60 px-2 py-1 focus:ring-foreground/20"
          />
        ) : (
          <input
            ref={ref as React.RefObject<HTMLInputElement>}
            type={type}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={handleKeyDown}
            className="h-6 w-full rounded bg-transparent text-[13px] text-foreground outline-none ring-1 ring-border/60 px-2 focus:ring-foreground/20"
          />
        )
      ) : (
        <button
          type="button"
          className={cn(
            "min-h-6 w-full cursor-text rounded px-2 text-left text-[13px] transition-colors",
            value
              ? "text-foreground"
              : "text-muted-foreground/40 italic",
          )}
          onClick={() => {
            setDraft(value ?? "");
            setEditing(true);
          }}
        >
          {value || placeholder}
        </button>
      )}
    </FieldRow>
  );
}

// -------------------------------------------------------------------
// EditableSelect
// -------------------------------------------------------------------

interface EditableSelectProps {
  value: string | null | undefined;
  onSave: (value: string) => void;
  options: { label: string; value: string }[];
  placeholder?: string;
  label: string;
  saving?: boolean;
  readOnly?: boolean;
}

export function EditableSelect({
  value,
  onSave,
  options,
  placeholder = "Select...",
  label,
  saving,
  readOnly,
}: EditableSelectProps) {
  if (readOnly) {
    const selected = options.find((o) => o.value === value);
    return (
      <FieldRow label={label}>
        <ReadOnlyValue empty={!selected} placeholder={placeholder}>
          {selected?.label}
        </ReadOnlyValue>
      </FieldRow>
    );
  }

  return (
    <FieldRow label={label} saving={saving}>
      <Select
        value={value ?? ""}
        onValueChange={(v) => {
          if (v !== (value ?? "")) onSave(v);
        }}
      >
        <SelectTrigger className="h-6 w-full border-none bg-transparent px-2 text-[13px] shadow-none focus:ring-0 [&>svg]:size-3 [&>svg]:text-muted-foreground/50">
          <SelectValue placeholder={<span className="text-muted-foreground/40 italic">{placeholder}</span>} />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldRow>
  );
}

// -------------------------------------------------------------------
// EditableMultiSelect
// -------------------------------------------------------------------

interface EditableMultiSelectProps {
  value: string[] | null | undefined;
  onSave: (value: string[]) => void;
  options: { label: string; value: string }[];
  placeholder?: string;
  label: string;
  saving?: boolean;
  readOnly?: boolean;
}

export function EditableMultiSelect({
  value,
  onSave,
  options,
  placeholder = "Add...",
  label,
  saving,
  readOnly,
}: EditableMultiSelectProps) {
  if (readOnly) {
    const vals = value ?? [];
    const labels = vals
      .map((v) => options.find((o) => o.value === v)?.label ?? v)
    return (
      <FieldRow label={label}>
        {labels.length === 0 ? (
          <ReadOnlyValue empty placeholder={placeholder} />
        ) : (
          <div className="flex flex-wrap items-center gap-1 px-2">
            {labels.map((l) => (
              <Badge
                key={l}
                variant="secondary"
                className="h-5 rounded px-1.5 text-[11px] font-normal"
              >
                {l}
              </Badge>
            ))}
          </div>
        )}
      </FieldRow>
    );
  }

  return (
    <FieldRow label={label} saving={saving}>
      <MultiSelect
        options={options}
        value={value ?? []}
        onChange={(v) => onSave(v)}
        placeholder={placeholder}
      />
    </FieldRow>
  );
}

// -------------------------------------------------------------------
// EditableFile
// -------------------------------------------------------------------

interface EditableFileProps {
  value: string | null | undefined;
  onSave: (value: string | undefined) => void;
  label: string;
  accept?: string;
  saving?: boolean;
  readOnly?: boolean;
}

export function EditableFile({
  value,
  onSave,
  label,
  accept,
  saving,
  readOnly,
}: EditableFileProps) {
  if (readOnly) {
    return (
      <FieldRow label={label}>
        {value ? (
          <img src={value} alt="" className="h-16 rounded object-cover" />
        ) : (
          <ReadOnlyValue empty placeholder="No file" />
        )}
      </FieldRow>
    );
  }

  return (
    <FieldRow label={label} saving={saving}>
      <FileUpload value={value ?? undefined} onChange={onSave} accept={accept} />
    </FieldRow>
  );
}

// -------------------------------------------------------------------
// EditableTags
// -------------------------------------------------------------------

interface EditableTagsProps {
  value: string[] | null | undefined;
  onSave: (value: string[]) => void;
  label: string;
  placeholder?: string;
  saving?: boolean;
  readOnly?: boolean;
}

export function EditableTags({
  value,
  onSave,
  label,
  placeholder = "Type and press Enter",
  saving,
  readOnly,
}: EditableTagsProps) {
  const [input, setInput] = useState("");
  const tags = value ?? [];

  const addTag = () => {
    const trimmed = input.trim();
    if (trimmed && !tags.includes(trimmed)) {
      onSave([...tags, trimmed]);
      setInput("");
    }
  };

  const removeTag = (tag: string) => {
    onSave(tags.filter((t) => t !== tag));
  };

  if (readOnly) {
    return (
      <FieldRow label={label}>
        {tags.length === 0 ? (
          <ReadOnlyValue empty placeholder={placeholder} />
        ) : (
          <div className="flex flex-wrap items-center gap-1 px-2">
            {tags.map((tag) => (
              <Badge
                key={tag}
                variant="secondary"
                className="h-5 rounded px-1.5 text-[11px] font-normal"
              >
                {tag}
              </Badge>
            ))}
          </div>
        )}
      </FieldRow>
    );
  }

  return (
    <FieldRow label={label} saving={saving}>
      <div className="flex flex-wrap items-center gap-1">
        {tags.map((tag) => (
          <Badge
            key={tag}
            variant="secondary"
            className="h-5 gap-0.5 rounded px-1.5 text-[11px] font-normal"
          >
            {tag}
            <button
              type="button"
              className="ml-0.5 opacity-40 hover:opacity-100"
              onClick={() => removeTag(tag)}
            >
              ×
            </button>
          </Badge>
        ))}
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addTag();
            }
          }}
          onBlur={addTag}
          placeholder={tags.length === 0 ? placeholder : "+"}
          className="h-5 min-w-[60px] flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/30"
        />
      </div>
    </FieldRow>
  );
}
