"use client";

import { useRouter } from "next/navigation";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation } from "@tanstack/react-query";
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
import { toast } from "sonner";

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

const schema = z.object({
  name: z.string().min(1, "Name is required"),
  objective: z.enum(["conversions", "traffic", "engagement", "awareness", "leads", "app_installs"]),
  costCap: z.string().optional(),
  targetingMethod: z.array(z.string()).min(1, "Select at least one targeting method"),
  demographics: z.string().optional(),
  geosInput: z.string().min(1, "At least one geo is required"),
  dailyBudget: z.string().min(1, "Daily budget is required"),
  placements: z.array(z.string()),
  notes: z.string().optional(),
});

type FormData = z.infer<typeof schema>;

export default function NewCampaignPage() {
  const router = useRouter();
  const trpc = useTRPC();

  const { register, handleSubmit, control, formState: { isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "",
      objective: "conversions",
      costCap: "",
      targetingMethod: [],
      demographics: "",
      geosInput: "",
      dailyBudget: "",
      placements: [],
      notes: "",
    },
  });

  const createCampaign = useMutation({
    ...trpc.campaignConfig.create.mutationOptions(),
    onSuccess: () => {
      toast.success("Campaign created successfully");
      router.push("/campaigns");
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const onSubmit = (data: FormData) => {
    const { geosInput, ...rest } = data;
    const geos = geosInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    createCampaign.mutate({
      ...rest,
      geos,
      costCap: rest.costCap || undefined,
      demographics: rest.demographics || undefined,
      placements: rest.placements.length > 0 ? rest.placements : undefined,
      notes: rest.notes || undefined,
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="New Campaign" description="Create a new campaign configuration." />

      <form onSubmit={handleSubmit(onSubmit)} className="flex max-w-2xl flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="name">Campaign Name</Label>
          <Input
            id="name"
            placeholder="Campaign name"
            {...register("name")}
            required
          />
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
            placeholder="e.g. 50.00"
            {...register("costCap")}
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
          <Input
            id="demographics"
            placeholder="e.g. 25-44, Male"
            {...register("demographics")}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="geos">Geos (comma-separated)</Label>
          <Input
            id="geos"
            placeholder="e.g. US, CA, UK"
            {...register("geosInput")}
            required
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="dailyBudget">Daily Budget</Label>
          <Input
            id="dailyBudget"
            type="number"
            placeholder="e.g. 100"
            {...register("dailyBudget")}
            required
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
          <Textarea
            id="notes"
            placeholder="Any additional notes..."
            {...register("notes")}
          />
        </div>

        <div className="flex gap-2">
          <Button type="submit" disabled={createCampaign.isPending || isSubmitting}>
            {createCampaign.isPending ? "Creating..." : "Create Campaign"}
          </Button>
          <Button type="button" variant="outline" onClick={() => router.push("/campaigns")}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
