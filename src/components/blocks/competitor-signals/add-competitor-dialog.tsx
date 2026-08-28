"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { ExternalLink } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useTRPC } from "@/lib/trpc/client";
import {
  adLibrarySearchUrl,
  parseMetaAdLibraryPageUrl,
} from "./ad-library";

interface CompetitorForm {
  name: string;
  metaAdLibraryUrl: string;
}

function adLibraryUrlError(value: string): true | string {
  const result = parseMetaAdLibraryPageUrl(value);
  if (result.error === null) return true;
  if (result.error === "individual_ad") {
    return "Open the advertiser's page in Meta Ad Library, then copy that page URL.";
  }
  return "Paste a Meta Ad Library advertiser page URL.";
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
    defaultValues: { name: "", metaAdLibraryUrl: "" },
  });
  const competitorName = useWatch({ control: form.control, name: "name" });

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
    form.reset({ name: "", metaAdLibraryUrl: "" });
    setFormError(null);
    onOpenChange(false);
  }

  function onSubmit(values: CompetitorForm) {
    const parsed = parseMetaAdLibraryPageUrl(values.metaAdLibraryUrl);
    if (parsed.error !== null) return;

    setFormError(null);
    addMutation.mutate({
      name: values.name.trim(),
      metaPageId: parsed.pageId,
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
          noValidate
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

          <Field
            data-invalid={Boolean(form.formState.errors.metaAdLibraryUrl)}
          >
            <FieldLabel htmlFor="competitor-ad-library-url">
              Meta Ad Library page URL
            </FieldLabel>
            <Input
              id="competitor-ad-library-url"
              type="url"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="https://www.facebook.com/ads/library/?view_all_page_id=…"
              aria-invalid={Boolean(form.formState.errors.metaAdLibraryUrl)}
              {...form.register("metaAdLibraryUrl", {
                required: "Paste a Meta Ad Library advertiser page URL.",
                validate: adLibraryUrlError,
              })}
            />
            <FieldDescription className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <span>
                Search for the advertiser, open its page, then copy the URL.
              </span>
              <a
                href={adLibrarySearchUrl(competitorName)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex shrink-0 items-center gap-1 font-medium"
              >
                Open Meta Ad Library <ExternalLink className="size-3.5" />
              </a>
            </FieldDescription>
            <FieldError
              errors={
                form.formState.errors.metaAdLibraryUrl
                  ? [form.formState.errors.metaAdLibraryUrl]
                  : undefined
              }
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
