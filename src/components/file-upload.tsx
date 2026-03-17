"use client";

import { useState, useRef, type DragEvent } from "react";
import { Upload, X, FileImage, FileVideo } from "lucide-react";
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
      // TODO: toast error
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
      <div className={cn("relative rounded-md border p-2", className)}>
        {isVideo ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <FileVideo className="size-4" />
            <span className="truncate">{value}</span>
          </div>
        ) : (
          <img
            src={value}
            alt="Upload preview"
            className="max-h-40 rounded object-contain"
          />
        )}
        <button
          type="button"
          className="absolute -right-2 -top-2 rounded-full bg-destructive p-1 text-destructive-foreground"
          onClick={() => onChange(undefined)}
        >
          <X className="size-3" />
        </button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center rounded-md border-2 border-dashed p-6 transition-colors hover:border-primary/50",
        dragOver && "border-primary bg-primary/5",
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
      <Upload className="mb-2 size-6 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        {uploading ? "Uploading..." : "Drop file here or click to upload"}
      </p>
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
