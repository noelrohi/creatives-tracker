"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc/client";
import { getUserFacingErrorMessage } from "@/lib/errors";
import { featureFlagDefs, type FeatureFlagKey } from "@/lib/feature-flags";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

export default function FeatureSettingsPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const flagsQuery = useQuery(trpc.orgSettings.getFeatureFlags.queryOptions());

  const setFlagMutation = useMutation(
    trpc.orgSettings.setFeatureFlag.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.orgSettings.getFeatureFlags.queryKey(),
        });
        toast.success("Feature updated");
      },
      onError: (error) => {
        toast.error(
          getUserFacingErrorMessage(error, "Failed to update feature."),
        );
      },
    }),
  );

  const flags = flagsQuery.data ?? {};
  const pendingKey = setFlagMutation.isPending
    ? (setFlagMutation.variables?.key as FeatureFlagKey | undefined)
    : undefined;

  return (
    <div className="mx-auto max-w-2xl space-y-10">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Features</h1>
        <p className="text-sm text-muted-foreground">
          Turn optional features on for this workspace.
        </p>
      </div>

      <div className="rounded-lg border divide-y">
        {flagsQuery.isLoading
          ? featureFlagDefs.map((def) => (
              <div
                key={def.key}
                className="flex items-center justify-between gap-4 px-5 py-4"
              >
                <div className="min-w-0 space-y-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-64" />
                </div>
                <Skeleton className="h-5 w-8 rounded-full" />
              </div>
            ))
          : featureFlagDefs.map((def) => (
              <div
                key={def.key}
                className="flex items-center justify-between gap-4 px-5 py-4"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{def.label}</span>
                    <Badge
                      variant="outline"
                      className="px-2 text-[10px] font-semibold uppercase tracking-wide"
                    >
                      {def.badge}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {def.description}
                  </p>
                </div>
                <Switch
                  checked={flags[def.key] ?? false}
                  disabled={pendingKey === def.key}
                  aria-label={def.label}
                  onCheckedChange={(enabled) =>
                    setFlagMutation.mutate({ key: def.key, enabled })
                  }
                />
              </div>
            ))}
      </div>
    </div>
  );
}
