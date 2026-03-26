"use client";

import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC, useTRPCClient } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Field,
  FieldLabel,
  FieldError,
  FieldDescription,
} from "@/components/ui/field";
import { Loader2 } from "lucide-react";

const schema = z.object({
  name: z.string().min(1, "Name is required."),
  metaAccountId: z.string().min(1, "Meta Account ID is required."),
  metaAccessToken: z.string().optional(),
  notes: z.string().optional(),
});

type FormValues = z.infer<typeof schema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  promptForToken?: boolean;
  onSuccess: (account: {
    id: string;
    name: string;
    metaAccountId: string;
    hasMetaAccessToken: boolean;
  }) => void;
}

export function InlineAccountDialog({
  open,
  onOpenChange,
  promptForToken,
  onSuccess,
}: Props) {
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "",
      metaAccountId: "",
      metaAccessToken: "",
      notes: "",
    },
  });

  const mutation = useMutation({
    mutationFn: (data: FormValues) =>
      trpcClient.adAccount.create.mutate({
        name: data.name,
        metaAccountId: data.metaAccountId,
        metaAccessToken: data.metaAccessToken || undefined,
        notes: data.notes || undefined,
      }),
    onSuccess: (account) => {
      queryClient.invalidateQueries({
        queryKey: trpc.adAccount.list.queryKey(),
      });
      form.reset();
      onSuccess(account);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add account</DialogTitle>
          <DialogDescription>
            Connect a Meta ad account to import data.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={form.handleSubmit((data) => mutation.mutate(data))}
          className="flex flex-col gap-4"
        >
          <Controller
            name="name"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor={field.name}>Name</FieldLabel>
                <Input
                  {...field}
                  id={field.name}
                  placeholder="My Brand"
                  aria-invalid={fieldState.invalid}
                  autoFocus
                />
                {fieldState.invalid && (
                  <FieldError errors={[fieldState.error]} />
                )}
              </Field>
            )}
          />

          <Controller
            name="metaAccountId"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor={field.name}>Meta Account ID</FieldLabel>
                <Input
                  {...field}
                  id={field.name}
                  placeholder="123456789"
                  aria-invalid={fieldState.invalid}
                />
                <FieldDescription>
                  Find this in Meta Ads Manager under Account Settings.
                </FieldDescription>
                {fieldState.invalid && (
                  <FieldError errors={[fieldState.error]} />
                )}
              </Field>
            )}
          />

          <Controller
            name="metaAccessToken"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor={field.name}>
                  Access Token
                  {promptForToken && (
                    <span className="ml-1 text-xs font-normal text-primary">
                      Required for API
                    </span>
                  )}
                </FieldLabel>
                <Input
                  {...field}
                  id={field.name}
                  type="password"
                  placeholder={
                    promptForToken
                      ? "Paste your Meta access token"
                      : "Optional"
                  }
                  aria-invalid={fieldState.invalid}
                />
                {promptForToken && (
                  <FieldDescription>
                    Needed to pull data directly from the Meta Marketing API.
                  </FieldDescription>
                )}
                {fieldState.invalid && (
                  <FieldError errors={[fieldState.error]} />
                )}
              </Field>
            )}
          />

          {mutation.error && (
            <p className="text-sm text-destructive">
              {mutation.error.message}
            </p>
          )}

          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending && <Loader2 className="animate-spin" />}
            Create account
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
