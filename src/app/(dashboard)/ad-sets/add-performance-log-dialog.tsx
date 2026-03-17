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
import { Button } from "@/components/ui/button";

interface AddPerformanceLogDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adSetId: string;
}

interface FormValues {
  dateStart: string;
  dateEnd: string;
  roas: string;
  cpa: string;
  ctr: string;
  conversionRate: string;
  spend: string;
  conversions: string;
}

export function AddPerformanceLogDialog({
  open,
  onOpenChange,
  adSetId,
}: AddPerformanceLogDialogProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { register, handleSubmit, reset } = useForm<FormValues>({
    defaultValues: {
      dateStart: "",
      dateEnd: "",
      roas: "",
      cpa: "",
      ctr: "",
      conversionRate: "",
      spend: "",
      conversions: "",
    },
  });

  const createLog = useMutation({
    ...trpc.performanceLog.create.mutationOptions(),
    onSuccess: () => {
      toast.success("Performance log added");
      queryClient.invalidateQueries({
        queryKey: trpc.performanceLog.listByAdSet.queryKey({ adSetId }),
      });
      reset();
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const onSubmit = (values: FormValues) => {
    if (!values.dateStart || !values.dateEnd) {
      toast.error("Date range is required");
      return;
    }
    createLog.mutate({
      adSetId,
      dateStart: values.dateStart,
      dateEnd: values.dateEnd,
      roas: values.roas || undefined,
      cpa: values.cpa || undefined,
      ctr: values.ctr || undefined,
      conversionRate: values.conversionRate || undefined,
      spend: values.spend || undefined,
      conversions: values.conversions
        ? parseInt(values.conversions, 10)
        : undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Performance Log</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={handleSubmit(onSubmit)}
          className="flex flex-col gap-5"
        >
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>Date Start</FieldLabel>
                <Input
                  type="date"
                  {...register("dateStart", { required: true })}
                />
              </Field>
              <Field>
                <FieldLabel>Date End</FieldLabel>
                <Input
                  type="date"
                  {...register("dateEnd", { required: true })}
                />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>ROAS</FieldLabel>
                <Input
                  {...register("roas")}
                  placeholder="e.g. 3.5"
                />
              </Field>
              <Field>
                <FieldLabel>CPA</FieldLabel>
                <Input
                  {...register("cpa")}
                  placeholder="e.g. 25.00"
                />
              </Field>
              <Field>
                <FieldLabel>CTR %</FieldLabel>
                <Input
                  {...register("ctr")}
                  placeholder="e.g. 2.5"
                />
              </Field>
              <Field>
                <FieldLabel>Conv Rate %</FieldLabel>
                <Input
                  {...register("conversionRate")}
                  placeholder="e.g. 4.2"
                />
              </Field>
              <Field>
                <FieldLabel>Spend</FieldLabel>
                <Input
                  {...register("spend")}
                  placeholder="e.g. 500.00"
                />
              </Field>
              <Field>
                <FieldLabel>Conversions</FieldLabel>
                <Input
                  {...register("conversions")}
                  placeholder="e.g. 20"
                />
              </Field>
            </div>
          </FieldGroup>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={createLog.isPending}>
              {createLog.isPending ? "Adding..." : "Add Log"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
