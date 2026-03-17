"use client";

import { useParams, useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTRPC } from "@/lib/trpc/client";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MultiSelect } from "@/components/multi-select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";

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

const editCampaignSchema = z.object({
  name: z.string().min(1),
  objective: z.enum(["conversions", "traffic", "engagement", "awareness", "leads", "app_installs"]),
  costCap: z.string().optional(),
  targetingMethod: z.array(z.string()),
  demographics: z.string().optional(),
  geosInput: z.string(),
  dailyBudget: z.string(),
  placements: z.array(z.string()),
  notes: z.string().optional(),
});

type EditCampaignFormValues = z.infer<typeof editCampaignSchema>;

type CampaignData = {
  id: string;
  name: string;
  objective: "conversions" | "traffic" | "engagement" | "awareness" | "leads" | "app_installs";
  costCap: string | null;
  targetingMethod: string[];
  demographics: string | null;
  geos: string[];
  dailyBudget: string;
  placements: string[] | null;
  notes: string | null;
  createdBy: string;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export default function CampaignDetailPage() {
  const params = useParams();
  const trpc = useTRPC();
  const id = params.id as string;

  const campaign = useQuery(trpc.campaignConfig.getById.queryOptions({ id }));

  if (campaign.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-9 w-24" />
        </div>
        <div className="flex max-w-2xl flex-col gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (campaign.isError || !campaign.data) {
    return <div className="p-6 text-destructive">Failed to load campaign.</div>;
  }

  return <EditCampaignForm key={id} data={campaign.data} />;
}

function EditCampaignForm({ data }: { data: CampaignData }) {
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const {
    register,
    handleSubmit,
    control,
    formState: { isSubmitting },
  } = useForm<EditCampaignFormValues>({
    resolver: zodResolver(editCampaignSchema),
    defaultValues: {
      name: data.name,
      objective: data.objective,
      costCap: data.costCap ?? "",
      targetingMethod: data.targetingMethod,
      demographics: data.demographics ?? "",
      geosInput: data.geos.join(", "),
      dailyBudget: data.dailyBudget ?? "",
      placements: data.placements ?? [],
      notes: data.notes ?? "",
    },
  });

  const updateCampaign = useMutation({
    ...trpc.campaignConfig.update.mutationOptions(),
    onSuccess: () => {
      toast.success("Campaign updated successfully");
      queryClient.invalidateQueries({ queryKey: trpc.campaignConfig.getById.queryKey({ id: data.id }) });
      queryClient.invalidateQueries({ queryKey: trpc.campaignConfig.list.queryKey() });
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const deleteCampaign = useMutation({
    ...trpc.campaignConfig.delete.mutationOptions(),
    onSuccess: () => {
      toast.success("Campaign deleted");
      router.push("/campaigns");
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const onSubmit = (formData: EditCampaignFormValues) => {
    const geos = formData.geosInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    updateCampaign.mutate({
      id: data.id,
      name: formData.name,
      objective: formData.objective,
      costCap: formData.costCap || null,
      targetingMethod: formData.targetingMethod,
      demographics: formData.demographics || null,
      geos,
      dailyBudget: formData.dailyBudget,
      placements: formData.placements.length > 0 ? formData.placements : null,
      notes: formData.notes || null,
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Edit Campaign" description="Update your campaign configuration.">
        <Button
          variant="destructive"
          onClick={() => {
            if (confirm("Are you sure you want to delete this campaign?")) {
              deleteCampaign.mutate({ id: data.id });
            }
          }}
        >
          <Trash2 className="mr-2 size-4" /> Delete
        </Button>
      </PageHeader>

      <form onSubmit={handleSubmit(onSubmit)} className="flex max-w-2xl flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="name">Campaign Name</Label>
          <Input id="name" {...register("name")} />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="objective">Objective</Label>
          <Controller
            name="objective"
            control={control}
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select objective" />
                </SelectTrigger>
                <SelectContent>
                  {objectiveOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="costCap">Cost Cap (optional)</Label>
          <Input
            id="costCap"
            {...register("costCap")}
            placeholder="e.g. 50.00"
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label>Targeting Method</Label>
          <Controller
            name="targetingMethod"
            control={control}
            render={({ field }) => (
              <MultiSelect
                options={targetingMethodOptions}
                value={field.value}
                onChange={field.onChange}
                placeholder="Select targeting methods"
              />
            )}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="demographics">Demographics (optional)</Label>
          <Input id="demographics" {...register("demographics")} />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="geos">Geos (comma-separated)</Label>
          <Input id="geos" {...register("geosInput")} />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="dailyBudget">Daily Budget</Label>
          <Input
            id="dailyBudget"
            type="number"
            {...register("dailyBudget")}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label>Placements</Label>
          <Controller
            name="placements"
            control={control}
            render={({ field }) => (
              <MultiSelect
                options={placementOptions}
                value={field.value}
                onChange={field.onChange}
                placeholder="Select placements"
              />
            )}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="notes">Notes (optional)</Label>
          <Textarea id="notes" {...register("notes")} />
        </div>

        <div className="flex gap-2">
          <Button type="submit" disabled={updateCampaign.isPending || isSubmitting}>
            {updateCampaign.isPending ? "Saving..." : "Save Changes"}
          </Button>
          <Button type="button" variant="outline" onClick={() => router.push("/campaigns")}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
