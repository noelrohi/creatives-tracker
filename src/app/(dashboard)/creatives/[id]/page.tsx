"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useForm, Controller } from "react-hook-form";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MultiSelect } from "@/components/multi-select";
import { FileUpload } from "@/components/file-upload";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ArrowLeft, Copy, Layers, MoreHorizontalIcon, Sparkles, Trash2 } from "lucide-react";
import { TagInput } from "@/components/tag-input";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemMedia,
  ItemGroup,
} from "@/components/ui/item";

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

export default function CreativeDetailPage() {
  const trpc = useTRPC();
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const id = params.id as string;

  const [deleteOpen, setDeleteOpen] = useState(false);

  const creative = useQuery(trpc.adCreative.getById.queryOptions({ id }));
  const landingPages = useQuery(trpc.landingPage.list.queryOptions());
  const linkedAds = useQuery(trpc.ad.listByCreative.queryOptions({ adCreativeId: id }));

  const form = useForm<FormValues>({
    defaultValues: {
      name: "",
      assetUrl: null,
      format: null,
      angle: null,
      persona: null,
      awarenessLevel: null,
      hook: null,
      tone: null,
      cta: null,
      landingPageId: null,
      notes: null,
    },
  });

  // Sync form when data loads
  useEffect(() => {
    if (creative.data) {
      const d = creative.data;
      form.reset({
        name: d.name,
        assetUrl: d.assetUrl,
        format: d.format,
        angle: d.angle,
        persona: d.persona,
        awarenessLevel: d.awarenessLevel,
        hook: d.hook,
        tone: d.tone,
        cta: d.cta,
        landingPageId: d.landingPageId,
        notes: d.notes,
      });
    }
  }, [creative.data, form]);

  const updateMutation = useMutation(
    trpc.adCreative.update.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.adCreative.getById.queryKey({ id }) });
        queryClient.invalidateQueries({ queryKey: trpc.adCreative.list.queryKey() });
        toast.success("Creative saved");
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const analyzeMutation = useMutation(
    trpc.ai.analyze.mutationOptions({
      onSuccess: (suggestions) => {
        // Fill form fields — don't save yet
        if (suggestions.format) form.setValue("format", suggestions.format, { shouldDirty: true });
        if (suggestions.angle) form.setValue("angle", suggestions.angle, { shouldDirty: true });
        if (suggestions.persona) form.setValue("persona", suggestions.persona, { shouldDirty: true });
        if (suggestions.awarenessLevel) form.setValue("awarenessLevel", suggestions.awarenessLevel, { shouldDirty: true });
        if (suggestions.hook) form.setValue("hook", suggestions.hook, { shouldDirty: true });
        if (suggestions.tone) form.setValue("tone", suggestions.tone, { shouldDirty: true });
        if (suggestions.cta) form.setValue("cta", suggestions.cta, { shouldDirty: true });
        toast.success("Fields auto-filled — review and save");
      },
      onError: (error) => toast.error(error.message || "Analysis failed"),
    }),
  );

  const duplicateMutation = useMutation({
    ...trpc.adCreative.duplicate.mutationOptions(),
    onSuccess: (data) => {
      toast.success("Creative duplicated");
      router.push(`/creatives/${data.id}`);
    },
    onError: (error) => toast.error(error.message || "Failed to duplicate"),
  });

  const deleteMutation = useMutation({
    ...trpc.adCreative.delete.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.adCreative.list.queryKey() });
      toast.success("Creative deleted");
      router.push("/creatives");
    },
    onError: (error) => toast.error(error.message || "Failed to delete"),
  });

  function onSubmit(values: FormValues) {
    updateMutation.mutate({
      id,
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
  }

  const assetUrl = form.watch("assetUrl");

  if (creative.isLoading) {
    return (
      <div className="mx-auto max-w-2xl space-y-6 pt-2">
        <div className="flex items-center gap-3">
          <Skeleton className="size-7 rounded" />
          <Skeleton className="h-7 w-56" />
        </div>
        <div className="space-y-4 pt-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (creative.isError || !creative.data) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-24">
        <p className="text-sm text-muted-foreground">Creative not found.</p>
        <Button variant="ghost" size="sm" asChild>
          <Link href="/creatives">Back to Creatives</Link>
        </Button>
      </div>
    );
  }

  const landingPageOptions = (landingPages.data ?? []).map((lp) => ({
    label: lp.name,
    value: lp.id,
  }));

  return (
    <div className="mx-auto max-w-2xl pt-2">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground/60 hover:text-foreground"
            asChild
          >
            <Link href="/creatives">
              <ArrowLeft className="size-3.5" />
            </Link>
          </Button>
          <h1 className="text-lg font-medium tracking-tight">
            {creative.data.name || "Untitled"}
          </h1>
        </div>

        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon-sm" aria-label="More options">
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => duplicateMutation.mutate({ id })}
                disabled={duplicateMutation.isPending}
              >
                <Copy /> Duplicate
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Form */}
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        {/* Asset + Auto-suggest */}
        <Field>
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

        {assetUrl && (
          <Button
            type="button"
            variant="outline"
            className="w-full gap-1.5"
            onClick={() =>
              analyzeMutation.mutate({
                assetUrl: assetUrl,
                name: form.getValues("name"),
              })
            }
            disabled={analyzeMutation.isPending}
          >
            <Sparkles className="size-3.5" />
            {analyzeMutation.isPending ? "Analyzing..." : "Auto-suggest Resolution Tags"}
          </Button>
        )}

        {/* Resolution fields */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field className="sm:col-span-2">
            <FieldLabel>Name</FieldLabel>
            <Input {...form.register("name")} placeholder="Creative name" />
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
            <Input {...form.register("angle")} placeholder="e.g., sleep quality" />
          </Field>

          <Field>
            <FieldLabel>Persona</FieldLabel>
            <Input {...form.register("persona")} placeholder="e.g., busy professionals" />
          </Field>

          <Field className="sm:col-span-2">
            <FieldLabel>Hook</FieldLabel>
            <Input {...form.register("hook")} placeholder="First 3 seconds or headline" />
          </Field>

          <Field>
            <FieldLabel>Tone</FieldLabel>
            <Controller
              control={form.control}
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
            <Input {...form.register("cta")} placeholder="e.g., Shop Now" />
          </Field>

          <Field className="sm:col-span-2">
            <FieldLabel>Landing Page</FieldLabel>
            <Controller
              control={form.control}
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
            <Textarea {...form.register("notes")} placeholder="Add notes..." />
          </Field>
        </div>

        {/* Save button */}
        <div className="flex items-center justify-between">
          <p className="text-[11px] text-muted-foreground/40">
            Created {new Date(creative.data.createdAt).toLocaleDateString()} · Updated{" "}
            {new Date(creative.data.updatedAt).toLocaleDateString()}
          </p>
          <Button
            type="submit"
            disabled={updateMutation.isPending || !form.formState.isDirty}
          >
            {updateMutation.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      </form>

      {/* Tags */}
      <div className="mt-8 px-2">
        <h3 className="text-sm font-medium text-muted-foreground mb-2">Tags</h3>
        <TagInput entityType="ad_creative" entityId={id} />
      </div>

      {/* Used in Ads */}
      <div className="mt-6 px-2">
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-sm font-medium">Used in Ads</h3>
          {linkedAds.data && (
            <span className="text-[13px] tabular-nums text-muted-foreground/50">
              {linkedAds.data.length}
            </span>
          )}
        </div>
        {linkedAds.data?.length === 0 ? (
          <p className="text-sm text-muted-foreground/60">
            Not used in any ads yet.
          </p>
        ) : (
          <ItemGroup>
            {linkedAds.data?.map((ad) => (
              <Item key={ad.id} variant="outline" size="sm">
                <div className="flex items-center gap-3 px-3 py-2">
                  <ItemMedia variant="icon">
                    <div className="flex size-8 items-center justify-center rounded-md bg-rose-500/10">
                      <Layers className="size-3.5 text-rose-500" />
                    </div>
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{ad.name}</ItemTitle>
                    <ItemDescription>
                      {ad.status === "paused" ? (
                        <Badge variant="secondary" className="text-[10px]">Paused</Badge>
                      ) : ad.status === "archived" ? (
                        <Badge variant="secondary" className="text-[10px]">Archived</Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] text-emerald-600">Active</Badge>
                      )}
                    </ItemDescription>
                  </ItemContent>
                </div>
              </Item>
            ))}
          </ItemGroup>
        )}
      </div>

      {/* Delete dialog */}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete creative"
        description="This will permanently delete this creative and all its data."
        confirmLabel="Delete"
        onConfirm={() => deleteMutation.mutate({ id })}
        loading={deleteMutation.isPending}
      />
    </div>
  );
}
