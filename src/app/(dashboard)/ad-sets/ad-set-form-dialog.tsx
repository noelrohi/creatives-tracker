"use client";

import { useState, useEffect } from "react";
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

interface AdSetFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adSet?: {
    id: string;
    name: string;
    adCreativeId: string | null;
    landingPageVersionId: string | null;
    campaignConfigId: string | null;
    notes: string | null;
  };
  onSuccess?: (id: string) => void;
}

interface FormValues {
  name: string;
  adCreativeId: string | null;
  landingPageVersionId: string | null;
  campaignConfigId: string | null;
  notes: string;
}

export function AdSetFormDialog({
  open,
  onOpenChange,
  adSet,
  onSuccess,
}: AdSetFormDialogProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const isEditing = !!adSet;

  const [selectedLpId, setSelectedLpId] = useState<string | null>(null);

  const creatives = useQuery({
    ...trpc.adCreative.list.queryOptions({}),
    enabled: open,
  });
  const campaigns = useQuery({
    ...trpc.campaignConfig.list.queryOptions(),
    enabled: open,
  });
  const landingPages = useQuery({
    ...trpc.landingPage.list.queryOptions(),
    enabled: open,
  });
  const landingPageVersions = useQuery({
    ...trpc.landingPage.listVersions.queryOptions({
      landingPageId: selectedLpId ?? "",
    }),
    enabled: !!selectedLpId,
  });

  const { register, handleSubmit, control, reset, formState } =
    useForm<FormValues>({
      defaultValues: {
        name: adSet?.name ?? "",
        adCreativeId: adSet?.adCreativeId ?? null,
        landingPageVersionId: adSet?.landingPageVersionId ?? null,
        campaignConfigId: adSet?.campaignConfigId ?? null,
        notes: adSet?.notes ?? "",
      },
    });

  useEffect(() => {
    if (open) {
      reset({
        name: adSet?.name ?? "",
        adCreativeId: adSet?.adCreativeId ?? null,
        landingPageVersionId: adSet?.landingPageVersionId ?? null,
        campaignConfigId: adSet?.campaignConfigId ?? null,
        notes: adSet?.notes ?? "",
      });
      setSelectedLpId(null);
    }
  }, [open, adSet, reset]);

  const createMutation = useMutation({
    ...trpc.adSet.create.mutationOptions(),
  });

  const updateMutation = useMutation({
    ...trpc.adSet.update.mutationOptions(),
  });

  const isPending = createMutation.isPending || updateMutation.isPending;

  const onSubmit = async (values: FormValues) => {
    try {
      if (isEditing) {
        await updateMutation.mutateAsync({
          id: adSet.id,
          name: values.name || undefined,
          adCreativeId: values.adCreativeId,
          landingPageVersionId: values.landingPageVersionId,
          campaignConfigId: values.campaignConfigId,
          notes: values.notes || null,
        });
        queryClient.invalidateQueries({
          queryKey: trpc.adSet.getById.queryKey({ id: adSet.id }),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.adSet.list.queryKey(),
        });
        toast.success("Ad set updated");
        onOpenChange(false);
        onSuccess?.(adSet.id);
      } else {
        const created = await createMutation.mutateAsync({
          name: values.name || undefined,
        });
        // Now update with the other fields if any are set
        const hasOtherFields =
          values.adCreativeId ||
          values.landingPageVersionId ||
          values.campaignConfigId ||
          values.notes;
        if (hasOtherFields) {
          await updateMutation.mutateAsync({
            id: created.id,
            adCreativeId: values.adCreativeId,
            landingPageVersionId: values.landingPageVersionId,
            campaignConfigId: values.campaignConfigId,
            notes: values.notes || null,
          });
        }
        queryClient.invalidateQueries({
          queryKey: trpc.adSet.list.queryKey(),
        });
        toast.success("Ad set created");
        onOpenChange(false);
        onSuccess?.(created.id);
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Something went wrong"
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Ad Set" : "New Ad Set"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-5">
          <FieldGroup>
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input
                {...register("name", { required: true })}
                placeholder="Ad set name"
              />
            </Field>

            <Field>
              <FieldLabel>Creative</FieldLabel>
              <Controller
                name="adCreativeId"
                control={control}
                render={({ field }) => (
                  <Select
                    value={field.value ?? ""}
                    onValueChange={(v) => field.onChange(v || null)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select creative..." />
                    </SelectTrigger>
                    <SelectContent>
                      {(creatives.data ?? []).map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>

            <Field>
              <FieldLabel>Landing Page</FieldLabel>
              <Select
                value={selectedLpId ?? ""}
                onValueChange={(v) => setSelectedLpId(v || null)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select landing page..." />
                </SelectTrigger>
                <SelectContent>
                  {(landingPages.data ?? []).map((lp) => (
                    <SelectItem key={lp.id} value={lp.id}>
                      {lp.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedLpId && (
                <Controller
                  name="landingPageVersionId"
                  control={control}
                  render={({ field }) => (
                    <Select
                      value={field.value ?? ""}
                      onValueChange={(v) => field.onChange(v || null)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select version..." />
                      </SelectTrigger>
                      <SelectContent>
                        {(landingPageVersions.data ?? []).map((v) => (
                          <SelectItem key={v.id} value={v.id}>
                            v{v.version} - {v.pageType}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              )}
            </Field>

            <Field>
              <FieldLabel>Campaign</FieldLabel>
              <Controller
                name="campaignConfigId"
                control={control}
                render={({ field }) => (
                  <Select
                    value={field.value ?? ""}
                    onValueChange={(v) => field.onChange(v || null)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select campaign..." />
                    </SelectTrigger>
                    <SelectContent>
                      {(campaigns.data ?? []).map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>

            <Field>
              <FieldLabel>Notes</FieldLabel>
              <Textarea
                {...register("notes")}
                placeholder="Add notes..."
                rows={3}
              />
            </Field>
          </FieldGroup>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Saving..." : isEditing ? "Save" : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
