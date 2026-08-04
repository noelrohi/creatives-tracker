"use client";

import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { getUserFacingErrorMessage } from "@/lib/errors";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
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
import {
  AWARENESS_OPTIONS,
  creativeFormSchema,
  FORMAT_OPTIONS,
  getCreativeFormValues,
  hasCreativeExtraValues,
  TONE_OPTIONS,
  toCreativeMutationInput,
  type CreativeFormValues,
} from "@/lib/creative-form";

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
    ownership: string | null;
    attributes: {
      hook?: string;
      cta?: string;
    };
    tone: string[] | null;
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

  const form = useForm<CreativeFormValues>({
    resolver: zodResolver(creativeFormSchema),
    values: getCreativeFormValues(creative),
  });

  const createMutation = useMutation({
    ...trpc.adCreative.create.mutationOptions(),
    onError: (error) =>
      toast.error(getUserFacingErrorMessage(error, "Failed to create creative.")),
  });

  const updateMutation = useMutation({
    ...trpc.adCreative.update.mutationOptions(),
    onError: (error) =>
      toast.error(getUserFacingErrorMessage(error, "Failed to update creative.")),
  });

  const isPending = createMutation.isPending || updateMutation.isPending;

  const onSubmit = async (values: CreativeFormValues) => {
    const payload = toCreativeMutationInput(values);

    try {
      if (isEdit) {
        await updateMutation.mutateAsync({
          id: creative.id,
          ...payload,
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
          name: payload.name,
        });

        if (hasCreativeExtraValues(payload)) {
          await updateMutation.mutateAsync({
            id: created.id,
            ...payload,
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
      // Error already handled by mutation onError.
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        key={`${creative?.id ?? "new"}:${open ? "open" : "closed"}`}
        className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Creative" : "New Creative"}</DialogTitle>
        </DialogHeader>

        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="flex flex-col overflow-hidden"
        >
          <div className="relative -mx-1 flex-1 overflow-y-auto px-1 [mask-image:linear-gradient(to_bottom,transparent,black_12px,black_calc(100%-12px),transparent)]">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                className="sm:col-span-2"
                data-invalid={!!form.formState.errors.name}
              >
                <FieldLabel htmlFor="creative-name">Name</FieldLabel>
                <FieldContent>
                  <Input
                    id="creative-name"
                    {...form.register("name")}
                    placeholder="Creative name"
                  />
                  <FieldError errors={[form.formState.errors.name]} />
                </FieldContent>
              </Field>

              <Field className="sm:col-span-2">
                <FieldLabel>Asset</FieldLabel>
                <Controller
                  control={form.control}
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
                  control={form.control}
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
                  control={form.control}
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
                  {...form.register("angle")}
                  placeholder="e.g., sleep quality"
                />
              </Field>

              <Field>
                <FieldLabel>Persona</FieldLabel>
                <Input
                  {...form.register("persona")}
                  placeholder="e.g., busy professionals"
                />
              </Field>

              <Field className="sm:col-span-2">
                <FieldLabel>Hook</FieldLabel>
                <Input
                  {...form.register("hook")}
                  placeholder="First 3 seconds or headline"
                />
              </Field>

              <Field>
                <FieldLabel>Tone</FieldLabel>
                <Controller
                  control={form.control}
                  name="tone"
                  render={({ field }) => (
                    <MultiSelect
                      options={TONE_OPTIONS}
                      value={field.value}
                      onChange={field.onChange}
                      placeholder="Select tone"
                    />
                  )}
                />
              </Field>

              <Field>
                <FieldLabel>CTA</FieldLabel>
                <Input {...form.register("cta")} placeholder="e.g., Shop Now" />
              </Field>

              <Field className="sm:col-span-2">
                <FieldLabel>Notes</FieldLabel>
                <Textarea
                  {...form.register("notes")}
                  placeholder="Add notes..."
                />
              </Field>
            </div>
          </div>

          <div className="mt-4 flex justify-end gap-2 pt-4">
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
