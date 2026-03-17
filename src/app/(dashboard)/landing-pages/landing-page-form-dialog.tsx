"use client";

import { useForm } from "react-hook-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { toast } from "sonner";

interface LandingPageFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  landingPage?: { id: string; name: string; url: string | null };
  onSuccess?: (id: string) => void;
}

interface FormData {
  name: string;
  url: string;
}

export function LandingPageFormDialog({
  open,
  onOpenChange,
  landingPage,
  onSuccess,
}: LandingPageFormDialogProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const isEdit = !!landingPage;

  const { register, handleSubmit, reset } = useForm<FormData>({
    values: {
      name: landingPage?.name ?? "",
      url: landingPage?.url ?? "",
    },
  });

  const createMutation = useMutation({
    ...trpc.landingPage.create.mutationOptions(),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: trpc.landingPage.list.queryKey() });
      toast.success("Landing page created");
      reset();
      onOpenChange(false);
      onSuccess?.(data.id);
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const updateMutation = useMutation({
    ...trpc.landingPage.update.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.landingPage.list.queryKey() });
      if (landingPage) {
        queryClient.invalidateQueries({
          queryKey: trpc.landingPage.getById.queryKey({ id: landingPage.id }),
        });
      }
      toast.success("Landing page updated");
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const isPending = createMutation.isPending || updateMutation.isPending;

  const onSubmit = (data: FormData) => {
    if (isEdit) {
      updateMutation.mutate({
        id: landingPage.id,
        name: data.name || undefined,
        url: data.url || undefined,
      });
    } else {
      createMutation.mutate({
        name: data.name || undefined,
        url: data.url || undefined,
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit Landing Page" : "New Landing Page"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
          <FieldGroup>
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input
                {...register("name")}
                placeholder="Landing page name"
                required
              />
            </Field>
            <Field>
              <FieldLabel>URL</FieldLabel>
              <Input
                {...register("url")}
                type="url"
                placeholder="https://..."
              />
            </Field>
          </FieldGroup>
          <DialogFooter className="bg-transparent border-t-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending
                ? isEdit
                  ? "Saving..."
                  : "Creating..."
                : isEdit
                  ? "Save"
                  : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
