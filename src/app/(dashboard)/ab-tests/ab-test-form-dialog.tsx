"use client";

import { useForm } from "react-hook-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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

interface ABTestFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (id: string) => void;
  abTest?: {
    id: string;
    name: string;
    hypothesis: string | null;
  };
}

interface FormValues {
  name: string;
  hypothesis: string;
}

export function ABTestFormDialog({
  open,
  onOpenChange,
  onSuccess,
  abTest,
}: ABTestFormDialogProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const isEdit = !!abTest;

  const { register, handleSubmit, reset } = useForm<FormValues>({
    defaultValues: {
      name: abTest?.name ?? "",
      hypothesis: abTest?.hypothesis ?? "",
    },
  });

  const createMutation = useMutation({
    ...trpc.abTest.create.mutationOptions(),
    onSuccess: (data) => {
      toast.success("A/B test created");
      queryClient.invalidateQueries({ queryKey: trpc.abTest.list.queryKey() });
      reset();
      onOpenChange(false);
      onSuccess?.(data.id);
    },
    onError: (error) => toast.error(error.message),
  });

  const updateMutation = useMutation({
    ...trpc.abTest.update.mutationOptions(),
    onSuccess: () => {
      toast.success("A/B test updated");
      queryClient.invalidateQueries({ queryKey: trpc.abTest.list.queryKey() });
      if (abTest) {
        queryClient.invalidateQueries({
          queryKey: trpc.abTest.getById.queryKey({ id: abTest.id }),
        });
      }
      onOpenChange(false);
    },
    onError: (error) => toast.error(error.message),
  });

  const onSubmit = (values: FormValues) => {
    if (isEdit) {
      updateMutation.mutate({
        id: abTest.id,
        name: values.name || undefined,
        hypothesis: values.hypothesis || null,
      });
    } else {
      createMutation.mutate({
        name: values.name || undefined,
        hypothesis: values.hypothesis || undefined,
      });
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit A/B Test" : "New A/B Test"}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={handleSubmit(onSubmit)}
          className="flex flex-col gap-5"
        >
          <FieldGroup>
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input {...register("name")} placeholder="e.g. Hero copy test" />
            </Field>
            <Field>
              <FieldLabel>Hypothesis</FieldLabel>
              <Textarea
                {...register("hypothesis")}
                placeholder="e.g. Changing the CTA to 'Get Started Free' will increase conversions by 15%"
                className="min-h-[80px]"
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
              {isPending ? "Saving..." : isEdit ? "Save" : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
