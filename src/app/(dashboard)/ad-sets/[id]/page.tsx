"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { EditableText, EditableSelect } from "@/components/editable-field";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Trash2, ArrowLeft, Plus } from "lucide-react";

export default function AdSetDetailPage() {
  const params = useParams();
  const router = useRouter();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const id = params.id as string;

  const adSet = useQuery(trpc.adSet.getById.queryOptions({ id }));
  const logs = useQuery(trpc.performanceLog.listByAdSet.queryOptions({ adSetId: id }));
  const creatives = useQuery(trpc.adCreative.list.queryOptions({}));
  const campaigns = useQuery(trpc.campaignConfig.list.queryOptions());
  const landingPages = useQuery(trpc.landingPage.list.queryOptions());

  const [showLogForm, setShowLogForm] = useState(false);
  const [savingField, setSavingField] = useState<string | null>(null);

  // Build a flat list of landing page versions for the select
  const [selectedLpId, setSelectedLpId] = useState<string | null>(null);
  const landingPageVersions = useQuery({
    ...trpc.landingPage.listVersions.queryOptions({ landingPageId: selectedLpId ?? "" }),
    enabled: !!selectedLpId,
  });

  const updateMutation = useMutation({
    ...trpc.adSet.update.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.adSet.getById.queryKey({ id }) });
      queryClient.invalidateQueries({ queryKey: trpc.adSet.list.queryKey() });
      setSavingField(null);
    },
    onError: (error) => {
      toast.error(error.message);
      setSavingField(null);
    },
  });

  const deleteMutation = useMutation({
    ...trpc.adSet.delete.mutationOptions(),
    onSuccess: () => {
      toast.success("Ad set deleted");
      router.push("/ad-sets");
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const saveField = (field: string, value: unknown) => {
    setSavingField(field);
    updateMutation.mutate({ id, [field]: value });
  };

  if (adSet.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-10 w-64" />
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col gap-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          </CardContent>
        </Card>
        <Skeleton className="h-6 w-36" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (adSet.isError || !adSet.data) {
    return <div className="p-6 text-destructive">Failed to load ad set.</div>;
  }

  const data = adSet.data;

  const creativeOptions = (creatives.data ?? []).map((c) => ({
    label: c.name,
    value: c.id,
  }));

  const campaignOptions = (campaigns.data ?? []).map((c) => ({
    label: c.name,
    value: c.id,
  }));

  // Build LP options as "PageName" for the first step
  const lpOptions = (landingPages.data ?? []).map((lp) => ({
    label: lp.name,
    value: lp.id,
  }));

  // Build version options for the selected LP
  const versionOptions = (landingPageVersions.data ?? []).map((v) => ({
    label: `v${v.version} - ${v.pageType}`,
    value: v.id,
  }));

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/ad-sets">
              <ArrowLeft className="size-4" />
            </Link>
          </Button>
          <div className="flex-1">
            <input
              type="text"
              defaultValue={data.name}
              className="w-full border-none bg-transparent text-2xl font-semibold tracking-tight outline-none placeholder:text-muted-foreground/60 focus:ring-0"
              placeholder="Untitled Ad Set"
              onBlur={(e) => {
                const val = e.target.value.trim();
                if (val && val !== data.name) {
                  saveField("name", val);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
          </div>
        </div>
        <ConfirmDialog
          title="Delete ad set"
          description="This will permanently delete this ad set and its performance logs."
          confirmLabel="Delete"
          onConfirm={() => deleteMutation.mutate({ id })}
          loading={deleteMutation.isPending}
          trigger={
            <Button variant="ghost" size="sm" className="text-muted-foreground/50 hover:text-destructive">
              <Trash2 className="mr-1.5 size-3.5" /> Delete
            </Button>
          }
        />
      </div>

      {/* Section 1: Ad Set Info */}
      <div className="max-w-2xl divide-y rounded-lg border">
        <EditableSelect
          value={data.adCreativeId}
          onSave={(v) => saveField("adCreativeId", v || null)}
          options={creativeOptions}
          placeholder="Select creative..."
          label="Creative"
          saving={savingField === "adCreativeId"}
        />
        <div className="group grid grid-cols-[140px_1fr] items-center gap-3 rounded-md px-3 py-2 hover:bg-muted/50">
          <span className="text-sm text-muted-foreground">Landing Page</span>
          <div className="flex flex-col gap-2">
            {data.landingPageName ? (
              <span className="text-sm">
                {data.landingPageName} v{data.landingPageVersion}
              </span>
            ) : (
              <span className="text-sm text-muted-foreground/60">No version linked</span>
            )}
            <div className="flex items-center gap-2">
              <select
                className="h-7 rounded border bg-transparent px-2 text-xs"
                value={selectedLpId ?? ""}
                onChange={(e) => setSelectedLpId(e.target.value || null)}
              >
                <option value="">Select page...</option>
                {lpOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              {selectedLpId && (
                <select
                  className="h-7 rounded border bg-transparent px-2 text-xs"
                  value=""
                  onChange={(e) => {
                    if (e.target.value) {
                      saveField("landingPageVersionId", e.target.value);
                      setSelectedLpId(null);
                    }
                  }}
                >
                  <option value="">Select version...</option>
                  {versionOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
        </div>
        <EditableSelect
          value={data.campaignConfigId}
          onSave={(v) => saveField("campaignConfigId", v || null)}
          options={campaignOptions}
          placeholder="Select campaign..."
          label="Campaign"
          saving={savingField === "campaignConfigId"}
        />
        <EditableText
          value={data.notes}
          onSave={(v) => saveField("notes", v || null)}
          placeholder="Add notes..."
          label="Notes"
          multiline
          saving={savingField === "notes"}
        />
      </div>

      {/* Section 2: Performance Logs */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Performance Logs</h2>
          <Button onClick={() => setShowLogForm(!showLogForm)} size="sm">
            <Plus className="mr-2 size-4" /> Add Performance Log
          </Button>
        </div>

        {showLogForm && (
          <AddPerformanceLogForm
            adSetId={id}
            onSuccess={() => {
              queryClient.invalidateQueries({
                queryKey: trpc.performanceLog.listByAdSet.queryKey({ adSetId: id }),
              });
              setShowLogForm(false);
            }}
          />
        )}

        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date Range</TableHead>
                <TableHead>ROAS</TableHead>
                <TableHead>CPA</TableHead>
                <TableHead>CTR</TableHead>
                <TableHead>Conv Rate</TableHead>
                <TableHead>Spend</TableHead>
                <TableHead>Conversions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.data?.map((log) => (
                <TableRow key={log.id}>
                  <TableCell>
                    {log.dateStart} &mdash; {log.dateEnd}
                  </TableCell>
                  <TableCell>{log.roas ?? "-"}</TableCell>
                  <TableCell>{log.cpa ? `$${log.cpa}` : "-"}</TableCell>
                  <TableCell>{log.ctr ? `${log.ctr}%` : "-"}</TableCell>
                  <TableCell>{log.conversionRate ? `${log.conversionRate}%` : "-"}</TableCell>
                  <TableCell>{log.spend ? `$${log.spend}` : "-"}</TableCell>
                  <TableCell>{log.conversions ?? "-"}</TableCell>
                </TableRow>
              ))}
              {logs.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    No performance logs yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

function AddPerformanceLogForm({
  adSetId,
  onSuccess,
}: {
  adSetId: string;
  onSuccess: () => void;
}) {
  const trpc = useTRPC();

  const [form, setForm] = useState({
    dateStart: "",
    dateEnd: "",
    roas: "",
    cpa: "",
    ctr: "",
    conversionRate: "",
    spend: "",
    conversions: "",
  });

  const createLog = useMutation({
    ...trpc.performanceLog.create.mutationOptions(),
    onSuccess: () => {
      toast.success("Performance log added");
      onSuccess();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.dateStart || !form.dateEnd) {
      toast.error("Date range is required");
      return;
    }
    createLog.mutate({
      adSetId,
      dateStart: form.dateStart,
      dateEnd: form.dateEnd,
      roas: form.roas || undefined,
      cpa: form.cpa || undefined,
      ctr: form.ctr || undefined,
      conversionRate: form.conversionRate || undefined,
      spend: form.spend || undefined,
      conversions: form.conversions ? parseInt(form.conversions, 10) : undefined,
    });
  };

  const update = (field: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((prev) => ({ ...prev, [field]: e.target.value }));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>New Performance Log</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="dateStart">Date Start</Label>
              <Input id="dateStart" type="date" value={form.dateStart} onChange={update("dateStart")} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="dateEnd">Date End</Label>
              <Input id="dateEnd" type="date" value={form.dateEnd} onChange={update("dateEnd")} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="roas">ROAS</Label>
              <Input id="roas" value={form.roas} onChange={update("roas")} placeholder="e.g. 3.5" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="cpa">CPA</Label>
              <Input id="cpa" value={form.cpa} onChange={update("cpa")} placeholder="e.g. 25.00" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ctr">CTR (%)</Label>
              <Input id="ctr" value={form.ctr} onChange={update("ctr")} placeholder="e.g. 2.5" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="conversionRate">Conv Rate (%)</Label>
              <Input id="conversionRate" value={form.conversionRate} onChange={update("conversionRate")} placeholder="e.g. 4.2" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="spend">Spend</Label>
              <Input id="spend" value={form.spend} onChange={update("spend")} placeholder="e.g. 500.00" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="conversions">Conversions</Label>
              <Input id="conversions" value={form.conversions} onChange={update("conversions")} placeholder="e.g. 20" />
            </div>
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={createLog.isPending}>
              {createLog.isPending ? "Adding..." : "Add Log"}
            </Button>
            <Button type="button" variant="outline" onClick={onSuccess}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
