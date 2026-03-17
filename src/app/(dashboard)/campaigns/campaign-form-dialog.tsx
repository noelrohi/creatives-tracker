"use client";

import { useEffect } from "react";
import { useForm, Controller } from "react-hook-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
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

interface FormValues {
  name: string;
  objective: string;
  costCap: string;
  targetingMethod: string[];
  demographics: string;
  geos: string;
  dailyBudget: string;
  placements: string[];
  notes: string;
}

interface CampaignFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaign?: {
    id: string;
    name: string;
    objective: string | null;
    costCap: string | null;
    targetingMethod: string[] | null;
    demographics: string | null;
    geos: string[] | null;
    dailyBudget: string | null;
    placements: string[] | null;
    notes: string | null;
  };
  onSuccess?: (id: string) => void;
}

export function CampaignFormDialog({
  open,
  onOpenChange,
  campaign,
  onSuccess,
}: CampaignFormDialogProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const isEdit = !!campaign;

  const { register, handleSubmit, reset, control, formState } =
    useForm<FormValues>({
      defaultValues: {
        name: "",
        objective: "",
        costCap: "",
        targetingMethod: [],
        demographics: "",
        geos: "",
        dailyBudget: "",
        placements: [],
        notes: "",
      },
    });

  useEffect(() => {
    if (open) {
      if (campaign) {
        reset({
          name: campaign.name || "",
          objective: campaign.objective || "",
          costCap: campaign.costCap || "",
          targetingMethod: campaign.targetingMethod || [],
          demographics: campaign.demographics || "",
          geos: campaign.geos?.join(", ") || "",
          dailyBudget: campaign.dailyBudget || "",
          placements: campaign.placements || [],
          notes: campaign.notes || "",
        });
      } else {
        reset({
          name: "",
          objective: "",
          costCap: "",
          targetingMethod: [],
          demographics: "",
          geos: "",
          dailyBudget: "",
          placements: [],
          notes: "",
        });
      }
    }
  }, [open, campaign, reset]);

  const createMutation = useMutation({
    ...trpc.campaignConfig.create.mutationOptions(),
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const updateMutation = useMutation({
    ...trpc.campaignConfig.update.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: trpc.campaignConfig.list.queryKey(),
      });
      if (campaign) {
        queryClient.invalidateQueries({
          queryKey: trpc.campaignConfig.getById.queryKey({ id: campaign.id }),
        });
      }
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const isPending = createMutation.isPending || updateMutation.isPending;

  const onSubmit = async (values: FormValues) => {
    const geos = values.geos
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const updatePayload = {
      name: values.name || undefined,
      objective:
        (values.objective as
          | "conversions"
          | "traffic"
          | "engagement"
          | "awareness"
          | "leads"
          | "app_installs") || null,
      costCap: values.costCap || null,
      targetingMethod:
        values.targetingMethod.length > 0 ? values.targetingMethod : null,
      demographics: values.demographics || null,
      geos: geos.length > 0 ? geos : null,
      dailyBudget: values.dailyBudget || null,
      placements: values.placements.length > 0 ? values.placements : null,
      notes: values.notes || null,
    };

    if (isEdit) {
      updateMutation.mutate(
        { id: campaign.id, ...updatePayload },
        {
          onSuccess: () => {
            onOpenChange(false);
            onSuccess?.(campaign.id);
          },
        }
      );
    } else {
      createMutation.mutate(
        { name: values.name || undefined },
        {
          onSuccess: (data) => {
            const hasExtraFields =
              updatePayload.objective ||
              updatePayload.costCap ||
              (updatePayload.targetingMethod &&
                updatePayload.targetingMethod.length > 0) ||
              updatePayload.demographics ||
              (updatePayload.geos && updatePayload.geos.length > 0) ||
              updatePayload.dailyBudget ||
              (updatePayload.placements &&
                updatePayload.placements.length > 0) ||
              updatePayload.notes;

            if (hasExtraFields) {
              updateMutation.mutate(
                { id: data.id, ...updatePayload },
                {
                  onSuccess: () => {
                    queryClient.invalidateQueries({
                      queryKey: trpc.campaignConfig.list.queryKey(),
                    });
                    onOpenChange(false);
                    onSuccess?.(data.id);
                  },
                }
              );
            } else {
              queryClient.invalidateQueries({
                queryKey: trpc.campaignConfig.list.queryKey(),
              });
              onOpenChange(false);
              onSuccess?.(data.id);
            }
          },
        }
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit Campaign" : "New Campaign"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col overflow-hidden">
          <div className="relative overflow-y-auto flex-1 px-1 -mx-1 [mask-image:linear-gradient(to_bottom,transparent,black_12px,black_calc(100%-12px),transparent)]">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input
                {...register("name", { required: true })}
                placeholder="Campaign name"
              />
            </Field>

            <Field>
              <FieldLabel>Objective</FieldLabel>
              <Controller
                control={control}
                name="objective"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select objective..." />
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
            </Field>

            <Field>
              <FieldLabel>Cost Cap</FieldLabel>
              <Input {...register("costCap")} placeholder="e.g., 50.00" />
            </Field>

            <Field>
              <FieldLabel>Daily Budget</FieldLabel>
              <Input
                {...register("dailyBudget")}
                placeholder="e.g., 100"
              />
            </Field>

            <Field>
              <FieldLabel>Targeting</FieldLabel>
              <Controller
                control={control}
                name="targetingMethod"
                render={({ field }) => (
                  <MultiSelect
                    options={targetingMethodOptions}
                    value={field.value}
                    onChange={field.onChange}
                    placeholder="Select targeting methods..."
                  />
                )}
              />
            </Field>

            <Field>
              <FieldLabel>Placements</FieldLabel>
              <Controller
                control={control}
                name="placements"
                render={({ field }) => (
                  <MultiSelect
                    options={placementOptions}
                    value={field.value}
                    onChange={field.onChange}
                    placeholder="Select placements..."
                  />
                )}
              />
            </Field>

            <Field>
              <FieldLabel>Demographics</FieldLabel>
              <Input
                {...register("demographics")}
                placeholder="e.g., 25-44, Male"
              />
            </Field>

            <Field>
              <FieldLabel>Geos</FieldLabel>
              <Input
                {...register("geos")}
                placeholder="e.g., US, CA, UK"
              />
            </Field>

            <Field className="sm:col-span-2">
              <FieldLabel>Notes</FieldLabel>
              <Textarea {...register("notes")} placeholder="Add notes..." />
            </Field>
          </div>
          </div>

          <DialogFooter className="bg-transparent border-t-0 pt-4 mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending
                ? "Saving..."
                : isEdit
                  ? "Save Changes"
                  : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
