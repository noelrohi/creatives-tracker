"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
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
  ArrowLeft,
  Copy,
  DollarSign,
  Eye,
  MoreHorizontalIcon,
  MousePointerClick,
  ShoppingCart,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
  Trash2,
} from "lucide-react";
import { DataFreshnessLabel } from "@/components/data-freshness";
import { TagInput } from "@/components/tag-input";
import {
  AWARENESS_OPTIONS,
  creativeFormSchema,
  FORMAT_OPTIONS,
  getCreativeFormValues,
  TONE_OPTIONS,
  toCreativeMutationInput,
  type CreativeFormValues,
} from "@/lib/creative-form";

function fmt(value: string | number | null | undefined, opts?: { prefix?: string; suffix?: string; decimals?: number }) {
  if (value == null || value === "") return "—";
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return "—";
  const decimals = opts?.decimals ?? 2;
  const formatted = num >= 1000
    ? `${(num / 1000).toFixed(1)}k`
    : num.toFixed(decimals);
  return `${opts?.prefix ?? ""}${formatted}${opts?.suffix ?? ""}`;
}

function MetricCard({
  label,
  value,
  icon: Icon,
  comparison,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  comparison?: { value: number; label: string } | null;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border/50 bg-card px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60">
        <Icon className="size-3" />
        {label}
      </div>
      <div className="text-lg font-semibold tracking-tight">{value}</div>
      {comparison && comparison.value !== 0 && (
        <div className="flex items-center gap-1 text-[11px]">
          {comparison.value > 0 ? (
            <TrendingUp className="size-3 text-emerald-500" />
          ) : (
            <TrendingDown className="size-3 text-red-400" />
          )}
          <span className={comparison.value > 0 ? "text-emerald-600" : "text-red-500"}>
            {comparison.value > 0 ? "+" : ""}{comparison.value.toFixed(1)}%
          </span>
          <span className="text-muted-foreground/40">{comparison.label}</span>
        </div>
      )}
    </div>
  );
}

function pctDiff(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const na = parseFloat(a);
  const nb = parseFloat(b);
  if (isNaN(na) || isNaN(nb) || nb === 0) return null;
  return ((na - nb) / nb) * 100;
}

export default function CreativeDetailPage() {
  const trpc = useTRPC();
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const id = params.id as string;

  const [deleteOpen, setDeleteOpen] = useState(false);

  const creative = useQuery(trpc.adCreative.getById.queryOptions({ id }));
  const perf = useQuery(trpc.adCreative.getPerformance.queryOptions({ id }));
  const landingPages = useQuery(trpc.landingPage.list.queryOptions());
  const linkedAds = useQuery(trpc.ad.listByCreative.queryOptions({ adCreativeId: id }));
  const accountsQuery = useQuery(trpc.account.list.queryOptions());

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

  const analyzeMutation = useMutation(
    trpc.ai.analyze.mutationOptions({
      onSuccess: (suggestions) => {
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

  function onSubmit(values: CreativeFormValues) {
    updateMutation.mutate({ id, ...toCreativeMutationInput(values) });
  }

  const assetUrl = useWatch({ control: form.control, name: "assetUrl" });

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

  const landingPageOptions = (landingPages.data ?? []).map((lp) => ({
    label: lp.name,
    value: lp.id,
  }));

  const hasPerf = perf.data && perf.data.logCount > 0;
  const roasDiff = pctDiff(perf.data?.avgRoas, perf.data?.portfolioAvgRoas);
  const cpaDiff = pctDiff(perf.data?.avgCpa, perf.data?.portfolioAvgCpa);
  const ctrDiff = pctDiff(perf.data?.avgCtr, perf.data?.portfolioAvgCtr);

  return (
    <div className="mx-auto max-w-4xl pt-2">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
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

      {/* Asset preview */}
      <div className="overflow-hidden rounded-lg border border-border/40 bg-muted/20 mb-5">
        {assetUrl ? (
          assetUrl.match(/\.(mp4|webm|mov)(\?|$)/i) ? (
            <video
              src={assetUrl}
              controls
              className="w-full max-h-[400px]"
            />
          ) : (
            <img
              src={assetUrl}
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

      {/* Tabs */}
      <Tabs defaultValue="performance">
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
        </TabsList>

        {/* Performance tab */}
        <TabsContent value="performance" className="pt-4">
          {hasPerf ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {perf.data.minDate && perf.data.maxDate && (
                    <span className="text-[11px] text-muted-foreground/40">
                      {perf.data.minDate} — {perf.data.maxDate}
                    </span>
                  )}
                </div>
                <DataFreshnessLabel account={accountsQuery.data?.[0]} />
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <MetricCard
                  label="Spend"
                  value={fmt(perf.data.totalSpend, { prefix: "$" })}
                  icon={DollarSign}
                />
                <MetricCard
                  label="ROAS"
                  value={fmt(perf.data.avgRoas, { suffix: "x" })}
                  icon={TrendingUp}
                  comparison={roasDiff != null ? { value: roasDiff, label: "vs avg" } : null}
                />
                <MetricCard
                  label="CPA"
                  value={fmt(perf.data.avgCpa, { prefix: "$" })}
                  icon={Target}
                  comparison={cpaDiff != null ? { value: -cpaDiff, label: "vs avg" } : null}
                />
                <MetricCard
                  label="CTR"
                  value={fmt(perf.data.avgCtr, { suffix: "%", decimals: 2 })}
                  icon={MousePointerClick}
                  comparison={ctrDiff != null ? { value: ctrDiff, label: "vs avg" } : null}
                />
                <MetricCard
                  label="Conversions"
                  value={fmt(perf.data.totalConversions, { decimals: 0 })}
                  icon={ShoppingCart}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <MetricCard
                  label="Impressions"
                  value={fmt(perf.data.totalImpressions, { decimals: 0 })}
                  icon={Eye}
                />
                <MetricCard
                  label="Link Clicks"
                  value={fmt(perf.data.totalClicks, { decimals: 0 })}
                  icon={MousePointerClick}
                />
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border/40 px-4 py-12 text-center">
              <p className="text-sm text-muted-foreground/50">No performance data yet</p>
              <p className="text-[11px] text-muted-foreground/30 mt-1">
                Import CSV data or link this creative to ads to see metrics
              </p>
            </div>
          )}
        </TabsContent>

        {/* Details tab */}
        <TabsContent value="details" className="pt-4">
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

            {assetUrl && (
              <Button
                type="button"
                variant="outline"
                className="w-full gap-1.5"
                size="sm"
                onClick={() =>
                  analyzeMutation.mutate({
                    assetUrl: assetUrl,
                    name: form.getValues("name"),
                  })
                }
                disabled={analyzeMutation.isPending}
              >
                <Sparkles className="size-3.5" />
                {analyzeMutation.isPending ? "Analyzing..." : "Auto-suggest Tags"}
              </Button>
            )}

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

            <div className="grid gap-3 grid-cols-2">
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
        </TabsContent>

        {/* Ads tab */}
        <TabsContent value="ads" className="pt-4">
          {linkedAds.data?.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/40 px-4 py-12 text-center">
              <p className="text-sm text-muted-foreground/50">Not used in any ads yet</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border/50">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border/30 bg-muted/30 text-muted-foreground/60">
                    <th className="px-3 py-2 text-left font-medium">Ad</th>
                    <th className="px-3 py-2 text-left font-medium">Campaign</th>
                    <th className="px-3 py-2 text-right font-medium">Spend</th>
                    <th className="px-3 py-2 text-right font-medium">ROAS</th>
                    <th className="px-3 py-2 text-right font-medium">Conv.</th>
                    <th className="px-3 py-2 text-right font-medium">Dates</th>
                  </tr>
                </thead>
                <tbody>
                  {linkedAds.data?.map((ad) => (
                    <tr key={ad.id} className="border-b border-border/20 last:border-0">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className="font-medium truncate max-w-[200px]">{ad.name}</span>
                          <Badge
                            variant={ad.status === "active" ? "outline" : "secondary"}
                            className={
                              ad.status === "active"
                                ? "text-[9px] text-emerald-600 border-emerald-200"
                                : "text-[9px]"
                            }
                          >
                            {ad.status === "active" ? "Active" : ad.status === "paused" ? "Paused" : "Archived"}
                          </Badge>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground/60 truncate max-w-[140px]">
                        {ad.campaignName ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {fmt(ad.totalSpend, { prefix: "$" })}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {fmt(ad.avgRoas, { suffix: "x" })}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {fmt(ad.totalConversions, { decimals: 0 })}
                      </td>
                      <td className="px-3 py-2 text-right text-muted-foreground/50 text-[11px]">
                        {ad.minDate && ad.maxDate
                          ? `${ad.minDate} — ${ad.maxDate}`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>
      </Tabs>

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
