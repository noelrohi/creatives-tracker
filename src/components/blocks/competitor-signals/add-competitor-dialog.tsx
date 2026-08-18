"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useTRPC } from "@/lib/trpc/client";

interface CompetitorForm {
  name: string;
  metaPageId: string;
}

export function AddCompetitorDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  // An already-tracked page is a form problem, not a toast problem — it names
  // the field the operator has to change.
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<CompetitorForm>({
    defaultValues: { name: "", metaPageId: "" },
  });

  const addMutation = useMutation(
    trpc.signals.addCompetitor.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.signals.listCompetitors.queryKey(),
        });
        toast.success("Competitor added");
        close();
      },
      onError: (error) => setFormError(error.message),
    }),
  );

  function close() {
    form.reset({ name: "", metaPageId: "" });
    setFormError(null);
    onOpenChange(false);
  }

  function onSubmit(values: CompetitorForm) {
    setFormError(null);
    addMutation.mutate({
      name: values.name.trim(),
      metaPageId: values.metaPageId.trim(),
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add competitor</DialogTitle>
          <DialogDescription>
            Track a public Meta Ad Library page. Ads arrive with the next fill
            the operator runs from their device.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="flex flex-col gap-4"
        >
          <Field>
            <FieldLabel htmlFor="competitor-name">Name</FieldLabel>
            <Input
              id="competitor-name"
              placeholder="AIRWAAV"
              {...form.register("name", { required: true })}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="competitor-page-id">Meta page ID</FieldLabel>
            <Input
              id="competitor-page-id"
              placeholder="123456789012345"
              {...form.register("metaPageId", { required: true })}
            />
          </Field>

          {formError && (
            <p
              role="alert"
              className="text-[13px]"
              style={{ color: "var(--attr-critical)" }}
            >
              {formError}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={addMutation.isPending}>
              {addMutation.isPending ? "Adding…" : "Add competitor"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
