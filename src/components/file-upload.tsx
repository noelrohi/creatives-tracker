"use client";

import { useState, useRef, type DragEvent } from "react";
import { Upload, X, FileVideo } from "@/components/icons";
import { cn } from "@/lib/utils";
import { uploadFile } from "@/lib/upload";

interface FileUploadProps {
  value?: string;
  onChange: (url: string | undefined) => void;
  accept?: string;
  className?: string;
}

export function FileUpload({
  value,
  onChange,
  accept = "image/*,video/*",
  className,
}: FileUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setUploading(true);
    try {
      const url = await uploadFile(file);
      onChange(url);
    } catch {
      // upload failed
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  if (value) {
    const isVideo = value.match(/\.(mp4|webm|mov)(\?|$)/i);
    return (
      <div className={cn("group/file relative", className)}>
        {isVideo ? (
          <div className="flex items-center gap-2 rounded bg-muted/40 px-2.5 py-1.5 text-[13px] text-muted-foreground">
            <FileVideo className="size-3.5" />
            <span className="truncate">{value.split("/").pop()}</span>
          </div>
        ) : (
          <img
            src={value}
            alt="Upload preview"
            className="max-h-28 rounded object-contain"
          />
        )}
        <button
          type="button"
          className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-muted text-muted-foreground opacity-0 transition-opacity group-hover/file:opacity-100 hover:bg-destructive hover:text-destructive-foreground"
          onClick={() => onChange(undefined)}
        >
          <X className="size-2.5" />
        </button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded border border-dashed border-border/60 px-3 py-2.5 text-[13px] text-muted-foreground/50 transition-colors hover:border-border hover:text-muted-foreground",
        dragOver && "border-foreground/20 bg-muted/30 text-muted-foreground",
        uploading && "pointer-events-none opacity-50",
        className,
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
    >
      <Upload className="size-3.5" />
      <span>{uploading ? "Uploading..." : "Drop file or click to upload"}</span>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={handleChange}
      />
    </div>
  );
}
