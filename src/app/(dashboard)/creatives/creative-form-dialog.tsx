"use client";

import { useEffect } from "react";
import { useForm, Controller } from "react-hook-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
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
import { FileUpload } from "@/components/file-upload";

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

interface FormValues {
  name: string;
  assetUrl: string | null;
  format: string | null;
  angle: string | null;
  persona: string | null;
  awarenessLevel: string | null;
  hook: string | null;
  tone: string[] | null;
  cta: string | null;
  landingPageId: string | null;
  notes: string | null;
}

export interface CreativeFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  creative?: {
    id: string;
    name: string;
    assetUrl: string | null;
    format: string | null;
    angle: string | null;
    persona: string | null;
    awarenessLevel: string | null;
    hook: string | null;
    tone: string[] | null;
    cta: string | null;
    landingPageId: string | null;
    notes: string | null;
  };
  onSuccess?: (id: string) => void;
}

export function CreativeFormDialog({
  open,
  onOpenChange,
  creative,
  onSuccess,
}: CreativeFormDialogProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const isEdit = !!creative;

  const landingPages = useQuery(trpc.landingPage.list.queryOptions());

  const { control, handleSubmit, reset, register } = useForm<FormValues>({
    defaultValues: {
      name: creative?.name ?? "",
      assetUrl: creative?.assetUrl ?? null,
      format: creative?.format ?? null,
      angle: creative?.angle ?? null,
      persona: creative?.persona ?? null,
      awarenessLevel: creative?.awarenessLevel ?? null,
      hook: creative?.hook ?? null,
      tone: creative?.tone ?? null,
      cta: creative?.cta ?? null,
      landingPageId: creative?.landingPageId ?? null,
      notes: creative?.notes ?? null,
    },
  });

  useEffect(() => {
    if (open) {
      reset({
        name: creative?.name ?? "",
        assetUrl: creative?.assetUrl ?? null,
        format: creative?.format ?? null,
        angle: creative?.angle ?? null,
        persona: creative?.persona ?? null,
        awarenessLevel: creative?.awarenessLevel ?? null,
        hook: creative?.hook ?? null,
        tone: creative?.tone ?? null,
        cta: creative?.cta ?? null,
        landingPageId: creative?.landingPageId ?? null,
        notes: creative?.notes ?? null,
      });
    }
  }, [open, creative, reset]);

  const createMutation = useMutation({
    ...trpc.adCreative.create.mutationOptions(),
    onError: (error) => toast.error(error.message),
  });

  const updateMutation = useMutation({
    ...trpc.adCreative.update.mutationOptions(),
    onError: (error) => toast.error(error.message),
  });

  const isPending = createMutation.isPending || updateMutation.isPending;

  const onSubmit = async (values: FormValues) => {
    try {
      if (isEdit) {
        await updateMutation.mutateAsync({
          id: creative.id,
          name: values.name || undefined,
          assetUrl: values.assetUrl,
          format: (values.format as "static" | "video" | "ugc" | "carousel") ?? null,
          angle: values.angle,
          persona: values.persona,
          awarenessLevel: (values.awarenessLevel as "unaware" | "problem_aware" | "solution_aware" | "product_aware" | "most_aware") ?? null,
          hook: values.hook,
          tone: values.tone,
          cta: values.cta,
          landingPageId: values.landingPageId,
          notes: values.notes,
        });
        queryClient.invalidateQueries({
          queryKey: trpc.adCreative.getById.queryKey({ id: creative.id }),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.adCreative.list.queryKey(),
        });
        toast.success("Creative updated");
        onOpenChange(false);
        onSuccess?.(creative.id);
      } else {
        const created = await createMutation.mutateAsync({
          name: values.name || undefined,
        });

        // If there are additional fields, update them
        const hasExtra =
          values.assetUrl ||
          values.format ||
          values.angle ||
          values.persona ||
          values.awarenessLevel ||
          values.hook ||
          (values.tone && values.tone.length > 0) ||
          values.cta ||
          values.landingPageId ||
          values.notes;

        if (hasExtra) {
          await updateMutation.mutateAsync({
            id: created.id,
            assetUrl: values.assetUrl,
            format: (values.format as "static" | "video" | "ugc" | "carousel") ?? null,
            angle: values.angle,
            persona: values.persona,
            awarenessLevel: (values.awarenessLevel as "unaware" | "problem_aware" | "solution_aware" | "product_aware" | "most_aware") ?? null,
            hook: values.hook,
            tone: values.tone,
            cta: values.cta,
            landingPageId: values.landingPageId,
            notes: values.notes,
          });
        }

        queryClient.invalidateQueries({
          queryKey: trpc.adCreative.list.queryKey(),
        });
        toast.success("Creative created");
        onOpenChange(false);
        onSuccess?.(created.id);
      }
    } catch {
      // Error already handled by mutation onError
    }
  };

  const landingPageOptions = (landingPages.data ?? []).map((lp) => ({
    label: lp.name,
    value: lp.id,
  }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Creative" : "New Creative"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col overflow-hidden">
          <div className="relative overflow-y-auto flex-1 px-1 -mx-1 [mask-image:linear-gradient(to_bottom,transparent,black_12px,black_calc(100%-12px),transparent)]">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field className="sm:col-span-2">
              <FieldLabel>Name</FieldLabel>
              <Input {...register("name", { required: true })} placeholder="Creative name" />
            </Field>

            <Field className="sm:col-span-2">
              <FieldLabel>Asset</FieldLabel>
              <Controller
                control={control}
                name="assetUrl"
                render={({ field }) => (
                  <FileUpload
                    value={field.value ?? undefined}
                    onChange={(url) => field.onChange(url ?? null)}
                    accept="image/*,video/*"
                  />
                )}
              />
            </Field>

            <Field>
              <FieldLabel>Format</FieldLabel>
              <Controller
                control={control}
                name="format"
                render={({ field }) => (
                  <Select
                    value={field.value ?? ""}
                    onValueChange={(v) => field.onChange(v || null)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select format" />
                    </SelectTrigger>
                    <SelectContent>
                      {FORMAT_OPTIONS.map((opt) => (
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
              <FieldLabel>Awareness Level</FieldLabel>
              <Controller
                control={control}
                name="awarenessLevel"
                render={({ field }) => (
                  <Select
                    value={field.value ?? ""}
                    onValueChange={(v) => field.onChange(v || null)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select awareness level" />
                    </SelectTrigger>
                    <SelectContent>
                      {AWARENESS_OPTIONS.map((opt) => (
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
              <FieldLabel>Angle</FieldLabel>
              <Input
                {...register("angle")}
                placeholder="e.g., sleep quality"
              />
            </Field>

            <Field>
              <FieldLabel>Persona</FieldLabel>
              <Input
                {...register("persona")}
                placeholder="e.g., busy professionals"
              />
            </Field>

            <Field className="sm:col-span-2">
              <FieldLabel>Hook</FieldLabel>
              <Input
                {...register("hook")}
                placeholder="First 3 seconds or headline"
              />
            </Field>

            <Field>
              <FieldLabel>Tone</FieldLabel>
              <Controller
                control={control}
                name="tone"
                render={({ field }) => (
                  <MultiSelect
                    options={TONE_OPTIONS}
                    value={field.value ?? []}
                    onChange={(v) => field.onChange(v.length > 0 ? v : null)}
                    placeholder="Select tone"
                  />
                )}
              />
            </Field>

            <Field>
              <FieldLabel>CTA</FieldLabel>
              <Input
                {...register("cta")}
                placeholder="e.g., Shop Now"
              />
            </Field>

            <Field className="sm:col-span-2">
              <FieldLabel>Landing Page</FieldLabel>
              <Controller
                control={control}
                name="landingPageId"
                render={({ field }) => (
                  <Select
                    value={field.value ?? ""}
                    onValueChange={(v) => field.onChange(v || null)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select landing page" />
                    </SelectTrigger>
                    <SelectContent>
                      {landingPageOptions.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>

            <Field className="sm:col-span-2">
              <FieldLabel>Notes</FieldLabel>
              <Textarea {...register("notes")} placeholder="Add notes..." />
            </Field>
          </div>
          </div>

          <div className="flex justify-end gap-2 pt-4 mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Saving..." : isEdit ? "Save" : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
