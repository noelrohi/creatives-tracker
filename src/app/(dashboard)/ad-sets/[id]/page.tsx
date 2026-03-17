"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTRPC } from "@/lib/trpc/client";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
import { toast } from "sonner";
import { Plus, ExternalLink } from "lucide-react";

const performanceLogSchema = z.object({
  dateStart: z.string().min(1),
  dateEnd: z.string().min(1),
  roas: z.string().optional(),
  cpa: z.string().optional(),
  ctr: z.string().optional(),
  conversionRate: z.string().optional(),
  spend: z.string().optional(),
  conversions: z.string().optional(),
});

type PerformanceLogFormValues = z.infer<typeof performanceLogSchema>;

export default function AdSetDetailPage() {
  const params = useParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const id = params.id as string;

  const adSet = useQuery(trpc.adSet.getById.queryOptions({ id }));
  const logs = useQuery(trpc.performanceLog.listByAdSet.queryOptions({ adSetId: id }));

  const [showLogForm, setShowLogForm] = useState(false);

  if (adSet.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-48" />
        </div>
        <Card><CardContent className="pt-6">
          <div className="grid gap-3 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i}>
                <Skeleton className="mb-1 h-4 w-16" />
                <Skeleton className="h-5 w-32" />
              </div>
            ))}
          </div>
        </CardContent></Card>
        <Skeleton className="h-6 w-36" />
        <div className="rounded-lg border p-4 space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (adSet.isError || !adSet.data) {
    return <div className="p-6 text-destructive">Failed to load ad set.</div>;
  }

  const data = adSet.data;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={data.name} description="Ad set details and performance logs." />

      <Card>
        <CardHeader>
          <CardTitle>Ad Set Info</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <span className="text-sm text-muted-foreground">Creative</span>
              <div>
                {data.adCreativeId ? (
                  <Link
                    href={`/creatives/${data.adCreativeId}`}
                    className="inline-flex items-center gap-1 font-medium hover:underline"
                  >
                    {data.adCreativeName ?? "Unknown"} <ExternalLink className="size-3" />
                  </Link>
                ) : (
                  "-"
                )}
              </div>
            </div>
            <div>
              <span className="text-sm text-muted-foreground">Landing Page</span>
              <div>
                {data.landingPageName ? (
                  <span className="font-medium">
                    {data.landingPageName} <Badge variant="secondary">v{data.landingPageVersion}</Badge>
                  </span>
                ) : (
                  "-"
                )}
              </div>
            </div>
            <div>
              <span className="text-sm text-muted-foreground">Campaign</span>
              <div>
                {data.campaignConfigId ? (
                  <Link
                    href={`/campaigns/${data.campaignConfigId}`}
                    className="inline-flex items-center gap-1 font-medium hover:underline"
                  >
                    {data.campaignConfigName ?? "Unknown"} <ExternalLink className="size-3" />
                  </Link>
                ) : (
                  "-"
                )}
              </div>
            </div>
            {data.notes && (
              <div>
                <span className="text-sm text-muted-foreground">Notes</span>
                <div>{data.notes}</div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Performance Logs</h2>
          <Button onClick={() => setShowLogForm(!showLogForm)}>
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
                    {log.dateStart} — {log.dateEnd}
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

  const {
    register,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<PerformanceLogFormValues>({
    resolver: zodResolver(performanceLogSchema),
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
      onSuccess();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const onSubmit = (formData: PerformanceLogFormValues) => {
    createLog.mutate({
      adSetId,
      dateStart: formData.dateStart,
      dateEnd: formData.dateEnd,
      roas: formData.roas || undefined,
      cpa: formData.cpa || undefined,
      ctr: formData.ctr || undefined,
      conversionRate: formData.conversionRate || undefined,
      spend: formData.spend || undefined,
      conversions: formData.conversions ? parseInt(formData.conversions, 10) : undefined,
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>New Performance Log</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="dateStart">Date Start</Label>
              <Input
                id="dateStart"
                type="date"
                {...register("dateStart")}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="dateEnd">Date End</Label>
              <Input
                id="dateEnd"
                type="date"
                {...register("dateEnd")}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="roas">ROAS</Label>
              <Input
                id="roas"
                {...register("roas")}
                placeholder="e.g. 3.5"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="cpa">CPA</Label>
              <Input
                id="cpa"
                {...register("cpa")}
                placeholder="e.g. 25.00"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ctr">CTR (%)</Label>
              <Input
                id="ctr"
                {...register("ctr")}
                placeholder="e.g. 2.5"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="conversionRate">Conv Rate (%)</Label>
              <Input
                id="conversionRate"
                {...register("conversionRate")}
                placeholder="e.g. 4.2"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="spend">Spend</Label>
              <Input
                id="spend"
                {...register("spend")}
                placeholder="e.g. 500.00"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="conversions">Conversions</Label>
              <Input
                id="conversions"
                {...register("conversions")}
                placeholder="e.g. 20"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={createLog.isPending || isSubmitting}>
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
