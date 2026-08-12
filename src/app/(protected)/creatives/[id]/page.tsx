"use client";

import { useState, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQueryState, parseAsString } from "nuqs";
import { subDays } from "date-fns";
import Link from "next/link";
import { formatDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date";
import { BREAKDOWN_RETENTION_DAYS, breakdownWindowStart } from "@/lib/retention/policy";
import { useForm, Controller, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
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
import { CreativeAdsTab } from "@/components/blocks/creatives/creative-ads-tab";
import { CreativePerformanceTab } from "@/components/blocks/creatives/creative-performance-tab";
import { DateRangePicker } from "@/components/blocks/dashboard/date-range-picker";
import { DemographicBreakdownChart } from "@/components/blocks/dashboard/demographic-chart";
import { Field, FieldContent, FieldError, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  Copy,
  MoreHorizontalIcon,
  PlayIcon,
  Trash2,
} from "@/components/icons";
import { TagInput } from "@/components/tag-input";
import { useActiveOrganizationRole } from "@/hooks/use-active-organization-role";
import {
  AWARENESS_OPTIONS,
  creativeFormSchema,
  FORMAT_OPTIONS,
  getCreativeFormValues,
  TONE_OPTIONS,
  toCreativeMutationInput,
  type CreativeFormValues,
} from "@/lib/creative-form";
import type { MetaCreativePreview } from "@/lib/meta-creative-assets";

function isVideoFileUrl(value: string | null | undefined) {
  return Boolean(value?.match(/\.(mp4|webm|mov)(\?|$)/i));
}

export default function CreativeDetailPage() {
  const trpc = useTRPC();
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const id = params.id as string;
  const { role } = useActiveOrganizationRole();
  const isReadOnly = role === "member";

  const [creativeTab, setCreativeTab] = useQueryState("tab", parseAsString.withDefault("performance"));
  const [from, setFrom] = useQueryState("from", parseAsString.withDefault(formatDateOnly(subDays(new Date(), 29))));
  const [to, setTo] = useQueryState("to", parseAsString.withDefault(formatDateOnly(new Date())));
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [metaPreview, setMetaPreview] = useState<MetaCreativePreview | null>(null);
  const [wantsVideo, setWantsVideo] = useState(false);
  const fromValue = isDateOnlyString(from) ? from : formatDateOnly(subDays(new Date(), 29));
  const toValue = isDateOnlyString(to) ? to : formatDateOnly(new Date());
  const fromDate = parseDateOnly(fromValue);
  const toDate = parseDateOnly(toValue);

  const dateParams = useMemo(() => ({
    id,
    from: fromValue,
    to: toValue,
  }), [id, fromValue, toValue]);

  const detailSearchParams = useMemo(() => {
    const params = new URLSearchParams();
    params.set("from", fromValue);
    params.set("to", toValue);
    return params.toString();
  }, [fromValue, toValue]);

  const creative = useQuery(trpc.adCreative.getById.queryOptions({ id }));
  const perf = useQuery(trpc.adCreative.getPerformance.queryOptions(dateParams));
  const dailyPerf = useQuery(trpc.adCreative.getDailyPerformance.queryOptions(dateParams));
  const linkedAds = useQuery(trpc.ad.listByCreative.queryOptions({
    adCreativeId: id,
    from: fromValue,
    to: toValue,
  }));
  const accountsQuery = useQuery({
    ...trpc.adAccount.list.queryOptions(),
    enabled: !isReadOnly,
  });
  const teamsQuery = useQuery(trpc.team.list.queryOptions());
  const tagsQuery = useQuery(
    trpc.tag.listForEntity.queryOptions({
      entityType: "ad_creative",
      entityId: id,
    }),
  );

  const [demoDimension, setDemoDimension] = useState<"age" | "gender" | "country" | "device">("gender");
  // Breakdown rows are only retained for 14 days; the page default is 30, so
  // this clamp (and its caption) is the normal case, not an edge case.
  const breakdownStart = breakdownWindowStart(formatDateOnly(new Date()));
  const demoFromValue = fromValue < breakdownStart ? breakdownStart : fromValue;
  const isDemoClamped = demoFromValue !== fromValue;
  const hasDemoWindow = demoFromValue <= toValue;
  const creativeDemographic = useQuery({
    ...trpc.performanceLog.creativeDemographicBreakdown.queryOptions({
      creativeId: id,
      dimension: demoDimension,
      from: demoFromValue,
      to: toValue,
    }),
    enabled: hasDemoWindow,
  });

  // Fetch ad preview iframe URL from Meta on demand (user clicks play)
  const adPreviewQuery = useQuery({
    ...trpc.adCreative.getAdPreviewUrl.queryOptions({ id }),
    enabled: wantsVideo,
    staleTime: 1000 * 60 * 30,
  });

  const form = useForm<CreativeFormValues>({
    resolver: zodResolver(creativeFormSchema),
    values: getCreativeFormValues(creative.data),
  });

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

  const duplicateMutation = useMutation({
    ...trpc.adCreative.duplicate.mutationOptions(),
    onSuccess: (data) => {
      toast.success("Creative duplicated");
      router.push(`/creatives/${data.id}?${detailSearchParams}`);
    },
    onError: (error) => toast.error(error.message || "Failed to duplicate"),
  });

  const deleteMutation = useMutation({
    ...trpc.adCreative.delete.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.adCreative.list.queryKey() });
      toast.success("Creative deleted");
      router.push(`/creatives?${detailSearchParams}`);
    },
    onError: (error) => toast.error(error.message || "Failed to delete"),
  });

  const metaPreviewMutation = useMutation(
    trpc.adCreative.fetchMetaPreview.mutationOptions({
      onSuccess: (preview) => {
        setMetaPreview(preview);
        // Refresh the creative query so persisted URLs are reflected
        queryClient.invalidateQueries({ queryKey: trpc.adCreative.getById.queryKey({ id }) });
        if (preview.videoUrl) {
          toast.success("Video loaded");
          return;
        }
        if (preview.assetUrl) {
          toast.success("Loaded Meta poster preview");
          return;
        }
        toast.error("Meta preview is not available for this creative");
      },
      onError: (error) => toast.error(error.message || "Failed to load Meta preview"),
    }),
  );

  function onSubmit(values: CreativeFormValues) {
    updateMutation.mutate({ id, ...toCreativeMutationInput(values) });
  }

  const assetUrl = useWatch({ control: form.control, name: "assetUrl" });
  const format = useWatch({ control: form.control, name: "format" });
  const displayAssetUrl = assetUrl ?? metaPreview?.assetUrl ?? null;
  const previewFormat = format ?? metaPreview?.format ?? creative.data?.format ?? null;
  const playableVideoUrl = metaPreview?.videoUrl
    ?? (isVideoFileUrl(assetUrl) ? assetUrl : creative.data?.videoUrl ?? null);
  const adPreviewUrl = adPreviewQuery.data?.previewUrl ?? null;
  const isLoadingVideo = wantsVideo && adPreviewQuery.isLoading;
  const canFetchMetaPreview = (!displayAssetUrl || (previewFormat === "video" && !playableVideoUrl));

  if (creative.isLoading) {
    return (
      <div className="mx-auto max-w-4xl space-y-6 pt-2">
        <div className="flex items-center gap-3">
          <Skeleton className="size-7 rounded" />
          <Skeleton className="h-7 w-56" />
        </div>
        <Skeleton className="aspect-video w-full max-h-[360px] rounded-lg" />
        <div className="flex gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-24 rounded-md" />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-lg" />
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

  return (
    <div className="mx-auto max-w-4xl pt-2">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground/60 hover:text-foreground"
            onClick={() => router.back()}
          >
            <ArrowLeft className="size-3.5" />
          </Button>
          <h1 className="text-lg font-medium tracking-tight">
            {creative.data.name || "Untitled"}
          </h1>

          {perf.data && (
            <Badge
              variant={perf.data.liveStatus === "active" ? "outline" : "secondary"}
              className={
                perf.data.liveStatus === "active"
                  ? "text-[10px] text-emerald-600 border-emerald-200"
                  : "text-[10px]"
              }
            >
              {perf.data.liveStatus === "active"
                ? "Live"
                : perf.data.liveStatus === "paused"
                  ? "Paused"
                  : "No ads"}
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-2">
          {!isReadOnly ? (
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
          ) : null}
        </div>
      </div>

      {/* Asset preview */}
      <div className="overflow-hidden rounded-lg border border-border/40 bg-muted/20 mb-5">
        {playableVideoUrl ? (
          <video
            src={playableVideoUrl}
            poster={displayAssetUrl && displayAssetUrl !== playableVideoUrl ? displayAssetUrl : undefined}
            controls
            playsInline
            preload="metadata"
            className="w-full max-h-[400px]"
          />
        ) : displayAssetUrl ? (
          isVideoFileUrl(displayAssetUrl) ? (
            <video
              src={displayAssetUrl}
              controls
              className="w-full max-h-[400px]"
            />
          ) : previewFormat === "video" ? (
            <button
              type="button"
              className="flex w-full items-center justify-center py-10 cursor-pointer group"
              disabled={isLoadingVideo}
              onClick={() => setWantsVideo(true)}
            >
              <div className="relative">
                <img
                  src={displayAssetUrl}
                  alt={creative.data.name}
                  className="object-contain max-h-[280px] rounded"
                />
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="rounded-full bg-black/50 p-3 group-hover:bg-black/70 transition-colors">
                    {isLoadingVideo ? (
                      <div className="size-8 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    ) : (
                      <PlayIcon className="size-8 text-white" fill="white" />
                    )}
                  </div>
                </div>
              </div>
            </button>
          ) : (
            <img
              src={displayAssetUrl}
              alt={creative.data.name}
              className="w-full object-contain max-h-[400px]"
            />
          )
        ) : (
          <div className="flex items-center justify-center py-16 text-sm text-muted-foreground/40">
            No asset uploaded
          </div>
        )}
      </div>

      {/* Meta ad preview dialog */}
      <Dialog open={wantsVideo && !!adPreviewUrl} onOpenChange={setWantsVideo}>
        <DialogContent className="sm:max-w-[360px] p-0 gap-0 overflow-hidden">
          <DialogHeader className="px-4 pt-4 pb-3">
            <DialogTitle className="text-sm">Ad Preview</DialogTitle>
          </DialogHeader>
          {adPreviewUrl && (
            <div className="bg-white">
              <iframe
                src={adPreviewUrl}
                className="w-full border-none aspect-[9/16]"
                scrolling="yes"
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
      {!isReadOnly && canFetchMetaPreview && !displayAssetUrl && (
        <div className="mb-5 flex items-center gap-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => metaPreviewMutation.mutate({ id })}
            disabled={metaPreviewMutation.isPending}
          >
            {metaPreviewMutation.isPending ? "Loading..." : "Load Preview From Meta"}
          </Button>
        </div>
      )}

      {/* Tabs */}
      <div className="mb-4 flex justify-end">
        <DateRangePicker
          from={fromDate}
          to={toDate}
          onChange={(range) => {
            if (range) {
              setFrom(formatDateOnly(range.from));
              setTo(formatDateOnly(range.to));
            }
          }}
        />
      </div>

      <Tabs value={creativeTab} onValueChange={setCreativeTab}>
        <TabsList variant="line">
          <TabsTrigger value="performance">Performance</TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="ads">
            Ads
            {linkedAds.data && linkedAds.data.length > 0 && (
              <span className="ml-1 text-[11px] tabular-nums text-muted-foreground/50">
                {linkedAds.data.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="demographics">Demographics</TabsTrigger>
        </TabsList>

        {/* Performance tab */}
        <TabsContent value="performance" className="pt-4">
          <CreativePerformanceTab
            perf={perf.data}
            dailyPerf={dailyPerf.data}
            account={accountsQuery.data?.[0]}
            from={fromDate}
            to={toDate}
            onDateRangeChange={(range) => {
              if (range) {
                setFrom(formatDateOnly(range.from));
                setTo(formatDateOnly(range.to));
              }
            }}
            showDateRange={false}
          />
        </TabsContent>

        {/* Details tab */}
        <TabsContent value="details" className="pt-4">
          {isReadOnly ? (
            <div className="max-w-2xl space-y-6">
              <div className="rounded-lg border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
                Members have read-only access to creative details.
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <ReadOnlyField label="Name" value={creative.data.name} />
                <ReadOnlyField
                  label="Format"
                  value={
                    FORMAT_OPTIONS.find((option) => option.value === creative.data.format)?.label ??
                    creative.data.format
                  }
                />
                <ReadOnlyField
                  label="Awareness"
                  value={
                    AWARENESS_OPTIONS.find(
                      (option) => option.value === creative.data.awarenessLevel,
                    )?.label ?? creative.data.awarenessLevel
                  }
                />
                <ReadOnlyField
                  label="Team"
                  value={
                    teamsQuery.data?.find((t) => t.id === creative.data.teamId)?.name ?? null
                  }
                />
                <ReadOnlyField label="Angle" value={creative.data.angle} />
                <ReadOnlyField label="Persona" value={creative.data.persona} />
                <ReadOnlyField label="Hook" value={creative.data.attributes.hook ?? null} />
                <ReadOnlyField label="CTA" value={creative.data.attributes.cta ?? null} />
              </div>

              <ReadOnlyField
                label="Tone"
                value={creative.data.tone?.length ? creative.data.tone.join(", ") : null}
              />
              <ReadOnlyField label="Notes" value={creative.data.notes} multiline />

              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground">Tags</p>
                <div className="flex flex-wrap gap-1.5">
                  {tagsQuery.data?.length ? (
                    tagsQuery.data.map((tag) => (
                      <Badge
                        key={tag.id}
                        variant="secondary"
                        style={
                          tag.color
                            ? {
                                backgroundColor: `${tag.color}20`,
                                borderColor: tag.color,
                              }
                            : undefined
                        }
                      >
                        {tag.name}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-sm text-muted-foreground">No tags</span>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <>
              <form onSubmit={form.handleSubmit(onSubmit)} className="max-w-lg space-y-4">
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

              <Field data-invalid={!!form.formState.errors.name}>
                <FieldLabel htmlFor="creative-detail-name">Name</FieldLabel>
                <FieldContent>
                  <Input
                    id="creative-detail-name"
                    {...form.register("name")}
                    placeholder="Creative name"
                  />
                  <FieldError errors={[form.formState.errors.name]} />
                </FieldContent>
              </Field>

              <div className="grid gap-3 grid-cols-3">
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
                          <SelectValue placeholder="Select" />
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
                  <FieldLabel>Awareness</FieldLabel>
                  <Controller
                    control={form.control}
                    name="awarenessLevel"
                    render={({ field }) => (
                      <Select
                        value={field.value ?? ""}
                        onValueChange={(v) => field.onChange(v || null)}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select" />
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

                {teamsQuery.data && teamsQuery.data.length > 0 && (
                  <Field>
                    <FieldLabel>Team</FieldLabel>
                    <Controller
                      control={form.control}
                      name="teamId"
                      render={({ field }) => (
                        <Select
                          value={field.value ?? "none"}
                          onValueChange={(v) => field.onChange(v === "none" ? null : v)}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">None</SelectItem>
                            {teamsQuery.data.map((t) => (
                              <SelectItem key={t.id} value={t.id}>
                                {t.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </Field>
                )}
              </div>

              <Field>
                <FieldLabel>Angle</FieldLabel>
                <Input {...form.register("angle")} placeholder="e.g., sleep quality" />
              </Field>

              <Field>
                <FieldLabel>Persona</FieldLabel>
                <Input {...form.register("persona")} placeholder="e.g., busy professionals" />
              </Field>

              <Field>
                <FieldLabel>Hook</FieldLabel>
                <Input {...form.register("hook")} placeholder="First 3 seconds or headline" />
              </Field>

              <div className="grid gap-3 grid-cols-2">
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
                        placeholder="Select"
                      />
                    )}
                  />
                </Field>

                <Field>
                  <FieldLabel>CTA</FieldLabel>
                  <Input {...form.register("cta")} placeholder="e.g., Shop Now" />
                </Field>
              </div>

              <Field>
                <FieldLabel>Notes</FieldLabel>
                <Textarea {...form.register("notes")} placeholder="Add notes..." rows={3} />
              </Field>

              <div className="flex items-center justify-between pt-1">
                <p className="text-[11px] text-muted-foreground/40">
                  Created {new Date(creative.data.createdAt).toLocaleDateString()}
                </p>
                <Button
                  type="submit"
                  disabled={updateMutation.isPending || !form.formState.isDirty}
                  size="sm"
                >
                  {updateMutation.isPending ? "Saving..." : "Save"}
                </Button>
              </div>
              </form>

              <div className="mt-6 max-w-lg">
                <h3 className="text-sm font-medium text-muted-foreground mb-2">Tags</h3>
                <TagInput entityType="ad_creative" entityId={id} />
              </div>
            </>
          )}
        </TabsContent>

        {/* Ads tab */}
        <TabsContent value="ads" className="pt-4">
          <CreativeAdsTab
            key={`${id}-${fromValue}-${toValue}`}
            ads={linkedAds.data}
            creativeId={id}
            from={fromValue}
            to={toValue}
            canPauseMetaAds={!isReadOnly}
          />
        </TabsContent>

        {/* Demographics tab */}
        <TabsContent value="demographics" className="space-y-2 pt-4">
          {!hasDemoWindow ? (
            <p className="text-[11px] text-muted-foreground/70">
              No demographic detail for this range. Breakdown data is kept for {BREAKDOWN_RETENTION_DAYS} days.
            </p>
          ) : isDemoClamped ? (
            <p className="text-[11px] text-muted-foreground/70">
              Demographic detail covers {demoFromValue}–{toValue}. Breakdown data is kept for {BREAKDOWN_RETENTION_DAYS} days.
            </p>
          ) : null}
          {hasDemoWindow ? (
            <DemographicBreakdownChart
              data={creativeDemographic.data}
              dimension={demoDimension}
              onDimensionChange={setDemoDimension}
              isLoading={creativeDemographic.isLoading}
            />
          ) : null}
        </TabsContent>
      </Tabs>

      {/* Delete dialog */}
      {!isReadOnly ? (
        <ConfirmDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title="Delete creative"
          description="This will permanently delete this creative and all its data."
          confirmLabel="Delete"
          onConfirm={() => deleteMutation.mutate({ id })}
          loading={deleteMutation.isPending}
        />
      ) : null}
    </div>
  );
}

function ReadOnlyField({
  label,
  value,
  multiline = false,
}: {
  label: string;
  value: string | null | undefined;
  multiline?: boolean;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      <div
        className={
          multiline
            ? "rounded-lg border bg-muted/20 px-3 py-2 text-sm whitespace-pre-wrap"
            : "rounded-lg border bg-muted/20 px-3 py-2 text-sm"
        }
      >
        {value || "—"}
      </div>
    </div>
  );
}
