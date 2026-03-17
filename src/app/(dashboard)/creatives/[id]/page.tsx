"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  EditableText,
  EditableSelect,
  EditableMultiSelect,
  EditableFile,
} from "@/components/editable-field";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ArrowLeft, Trash2 } from "lucide-react";

const FORMAT_OPTIONS = [
  { label: "Static", value: "static" },
  { label: "Video", value: "video" },
  { label: "UGC", value: "ugc" },
  { label: "Carousel", value: "carousel" },
];

const AWARENESS_OPTIONS = [
  { label: "Unaware", value: "unaware" },
  { label: "Problem Aware", value: "problem_aware" },
  { label: "Solution Aware", value: "solution_aware" },
  { label: "Product Aware", value: "product_aware" },
  { label: "Most Aware", value: "most_aware" },
];

const TONE_OPTIONS = [
  { label: "Clinical", value: "clinical" },
  { label: "Casual", value: "casual" },
  { label: "Fear-based", value: "fear_based" },
  { label: "Aspirational", value: "aspirational" },
  { label: "Urgent", value: "urgent" },
  { label: "Humorous", value: "humorous" },
];

export default function CreativeDetailPage() {
  const trpc = useTRPC();
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const id = params.id as string;

  const [savingField, setSavingField] = useState<string | null>(null);

  const creative = useQuery(trpc.adCreative.getById.queryOptions({ id }));
  const landingPages = useQuery(trpc.landingPage.list.queryOptions());

  const updateMutation = useMutation({
    ...trpc.adCreative.update.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: trpc.adCreative.getById.queryKey({ id }),
      });
      queryClient.invalidateQueries({
        queryKey: trpc.adCreative.list.queryKey(),
      });
      setSavingField(null);
    },
    onError: (error) => {
      toast.error(error.message);
      setSavingField(null);
    },
  });

  const deleteMutation = useMutation({
    ...trpc.adCreative.delete.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: trpc.adCreative.list.queryKey(),
      });
      toast.success("Creative deleted");
      router.push("/creatives");
    },
    onError: (error) => {
      toast.error(error.message || "Failed to delete");
    },
  });

  const saveField = (field: string, value: unknown) => {
    setSavingField(field);
    updateMutation.mutate({ id, [field]: value });
  };

  if (creative.isLoading) {
    return (
      <div className="mx-auto max-w-2xl space-y-6 pt-2">
        <div className="flex items-center gap-3">
          <Skeleton className="size-7 rounded" />
          <Skeleton className="h-7 w-56" />
        </div>
        <div className="space-y-1 pt-2">
          {Array.from({ length: 10 }).map((_, i) => (
            <div
              key={i}
              className="grid grid-cols-[120px_1fr] gap-4 px-2 py-[7px]"
            >
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-full" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (creative.isError || !creative.data) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-24">
        <p className="text-sm text-muted-foreground">Creative not found.</p>
        <Button variant="ghost" size="sm" asChild>
          <Link href="/creatives">Back to Creatives</Link>
        </Button>
      </div>
    );
  }

  const data = creative.data;

  const landingPageOptions = (landingPages.data ?? []).map((lp) => ({
    label: lp.name,
    value: lp.id,
  }));

  return (
    <div className="mx-auto max-w-2xl pt-2">
      {/* Header — minimal: back arrow, title, ghost delete */}
      <div className="group/header flex items-center gap-2 mb-6">
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground/60 hover:text-foreground"
          asChild
        >
          <Link href="/creatives">
            <ArrowLeft className="size-3.5" />
          </Link>
        </Button>

        <EditableTitle
          value={data.name}
          onSave={(v) => saveField("name", v)}
          saving={savingField === "name"}
        />

        <ConfirmDialog
          title="Delete creative"
          description="This will permanently delete this creative and all its data."
          confirmLabel="Delete"
          onConfirm={() => deleteMutation.mutate({ id })}
          loading={deleteMutation.isPending}
          trigger={
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 text-muted-foreground/30 opacity-0 transition-opacity group-hover/header:opacity-100 hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
            </Button>
          }
        />
      </div>

      {/* Properties — no card, no dividers. Just quiet rows. */}
      <div className="-mx-2 space-y-px">
        <EditableFile
          label="Asset"
          value={data.assetUrl}
          onSave={(v) => saveField("assetUrl", v)}
          accept="image/*,video/*"
          saving={savingField === "assetUrl"}
        />
        <EditableSelect
          label="Format"
          value={data.format}
          onSave={(v) => saveField("format", v)}
          options={FORMAT_OPTIONS}
          placeholder="Select format"
          saving={savingField === "format"}
        />
        <EditableText
          label="Angle"
          value={data.angle}
          onSave={(v) => saveField("angle", v)}
          placeholder="e.g., sleep quality"
          saving={savingField === "angle"}
        />
        <EditableText
          label="Persona"
          value={data.persona}
          onSave={(v) => saveField("persona", v)}
          placeholder="e.g., busy professionals"
          saving={savingField === "persona"}
        />
        <EditableSelect
          label="Awareness"
          value={data.awarenessLevel}
          onSave={(v) => saveField("awarenessLevel", v)}
          options={AWARENESS_OPTIONS}
          placeholder="Select level"
          saving={savingField === "awarenessLevel"}
        />
        <EditableText
          label="Hook"
          value={data.hook}
          onSave={(v) => saveField("hook", v)}
          placeholder="First 3 seconds or headline"
          saving={savingField === "hook"}
        />
        <EditableMultiSelect
          label="Tone"
          value={data.tone}
          onSave={(v) => saveField("tone", v)}
          options={TONE_OPTIONS}
          placeholder="Add tone"
          saving={savingField === "tone"}
        />
        <EditableText
          label="CTA"
          value={data.cta}
          onSave={(v) => saveField("cta", v)}
          placeholder="e.g., Shop Now"
          saving={savingField === "cta"}
        />
        <EditableSelect
          label="Landing Page"
          value={data.landingPageId}
          onSave={(v) => saveField("landingPageId", v)}
          options={landingPageOptions}
          placeholder="Link a page"
          saving={savingField === "landingPageId"}
        />

        {/* Separator before notes */}
        <div className="pt-2" />

        <EditableText
          label="Notes"
          value={data.notes}
          onSave={(v) => saveField("notes", v)}
          placeholder="Add notes..."
          multiline
          saving={savingField === "notes"}
        />
      </div>

      {/* Timestamp — barely visible */}
      <p className="mt-8 text-[11px] text-muted-foreground/40 px-2">
        Created {new Date(data.createdAt).toLocaleDateString()} · Updated{" "}
        {new Date(data.updatedAt).toLocaleDateString()}
      </p>
    </div>
  );
}

// Title — large, clean, inline-editable. No borders until focused.
function EditableTitle({
  value,
  onSave,
  saving,
}: {
  value: string | null | undefined;
  onSave: (value: string) => void;
  saving?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");

  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft !== (value ?? "")) onSave(draft.trim());
    else setDraft(value ?? "");
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setDraft(value ?? "");
            setEditing(false);
          }
        }}
        className="flex-1 bg-transparent text-lg font-medium tracking-tight text-foreground outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        setDraft(value ?? "");
        setEditing(true);
      }}
      className="flex flex-1 items-center gap-2 text-left text-lg font-medium tracking-tight text-foreground transition-colors hover:text-muted-foreground"
    >
      {value || "Untitled"}
      {saving ? (
        <span className="inline-block size-1 animate-pulse rounded-full bg-muted-foreground/50" />
      ) : null}
    </button>
  );
}
