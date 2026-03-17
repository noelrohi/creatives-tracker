"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  EditableText,
  EditableSelect,
  EditableMultiSelect,
  EditableTags,
} from "@/components/editable-field";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Trash2, ArrowLeft } from "lucide-react";
import Link from "next/link";

const objectiveOptions = [
  { label: "Conversions", value: "conversions" },
  { label: "Traffic", value: "traffic" },
  { label: "Engagement", value: "engagement" },
  { label: "Awareness", value: "awareness" },
  { label: "Leads", value: "leads" },
  { label: "App Installs", value: "app_installs" },
];

const targetingMethodOptions = [
  { label: "Interests", value: "interests" },
  { label: "Lookalikes", value: "lookalikes" },
  { label: "Broad", value: "broad" },
  { label: "Retargeting", value: "retargeting" },
  { label: "Custom Audience", value: "custom_audience" },
];

const placementOptions = [
  { label: "Feed", value: "feed" },
  { label: "Stories", value: "stories" },
  { label: "Reels", value: "reels" },
  { label: "Auto", value: "auto" },
];

export default function CampaignDetailPage() {
  const params = useParams();
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const id = params.id as string;

  const campaign = useQuery(trpc.campaignConfig.getById.queryOptions({ id }));

  const [savingField, setSavingField] = useState<string | null>(null);

  const updateMutation = useMutation({
    ...trpc.campaignConfig.update.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.campaignConfig.getById.queryKey({ id }) });
      queryClient.invalidateQueries({ queryKey: trpc.campaignConfig.list.queryKey() });
      setSavingField(null);
    },
    onError: (error) => {
      toast.error(error.message);
      setSavingField(null);
    },
  });

  const deleteMutation = useMutation({
    ...trpc.campaignConfig.delete.mutationOptions(),
    onSuccess: () => {
      toast.success("Campaign deleted");
      router.push("/campaigns");
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const saveField = (field: string, value: unknown) => {
    setSavingField(field);
    updateMutation.mutate({ id, [field]: value });
  };

  if (campaign.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-10 w-64" />
        <div className="flex max-w-2xl flex-col gap-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (campaign.isError || !campaign.data) {
    return <div className="p-6 text-destructive">Failed to load campaign.</div>;
  }

  const data = campaign.data;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/campaigns">
              <ArrowLeft className="size-4" />
            </Link>
          </Button>
          <div className="flex-1">
            <input
              type="text"
              defaultValue={data.name}
              className="w-full border-none bg-transparent text-2xl font-semibold tracking-tight outline-none placeholder:text-muted-foreground/60 focus:ring-0"
              placeholder="Untitled Campaign"
              onBlur={(e) => {
                const val = e.target.value.trim();
                if (val && val !== data.name) {
                  saveField("name", val);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
          </div>
        </div>
        <ConfirmDialog
          title="Delete campaign"
          description="This will permanently delete this campaign configuration."
          confirmLabel="Delete"
          onConfirm={() => deleteMutation.mutate({ id })}
          loading={deleteMutation.isPending}
          trigger={
            <Button variant="ghost" size="sm" className="text-muted-foreground/50 hover:text-destructive">
              <Trash2 className="mr-1.5 size-3.5" /> Delete
            </Button>
          }
        />
      </div>

      <div className="max-w-2xl divide-y rounded-lg border">
        <EditableSelect
          value={data.objective}
          onSave={(v) => saveField("objective", v)}
          options={objectiveOptions}
          placeholder="Select objective..."
          label="Objective"
          saving={savingField === "objective"}
        />
        <EditableText
          value={data.costCap}
          onSave={(v) => saveField("costCap", v || null)}
          placeholder="e.g., 50.00"
          label="Cost Cap"
          saving={savingField === "costCap"}
        />
        <EditableMultiSelect
          value={data.targetingMethod}
          onSave={(v) => saveField("targetingMethod", v)}
          options={targetingMethodOptions}
          placeholder="Select targeting methods..."
          label="Targeting"
          saving={savingField === "targetingMethod"}
        />
        <EditableText
          value={data.demographics}
          onSave={(v) => saveField("demographics", v || null)}
          placeholder="e.g., 25-44, Male"
          label="Demographics"
          saving={savingField === "demographics"}
        />
        <EditableTags
          value={data.geos}
          onSave={(v) => saveField("geos", v)}
          label="Geos"
          placeholder="Type country code and press Enter..."
          saving={savingField === "geos"}
        />
        <EditableText
          value={data.dailyBudget}
          onSave={(v) => saveField("dailyBudget", v || null)}
          placeholder="e.g., 100"
          label="Daily Budget"
          type="number"
          saving={savingField === "dailyBudget"}
        />
        <EditableMultiSelect
          value={data.placements}
          onSave={(v) => saveField("placements", v)}
          options={placementOptions}
          placeholder="Select placements..."
          label="Placements"
          saving={savingField === "placements"}
        />
        <EditableText
          value={data.notes}
          onSave={(v) => saveField("notes", v || null)}
          placeholder="Add notes..."
          label="Notes"
          multiline
          saving={savingField === "notes"}
        />
      </div>
    </div>
  );
}
