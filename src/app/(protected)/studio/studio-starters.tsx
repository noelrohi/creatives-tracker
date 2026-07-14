"use client";

import { useQuery } from "@tanstack/react-query";
import { Trophy, Sparkles, Info } from "@/components/icons";
import { useTRPC } from "@/lib/trpc/client";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtRoas, fmtNum } from "@/lib/fmt";
import { awarenessDisplayLabel } from "@/lib/awareness";
import type { AwarenessLevel, Starter } from "./studio-types";

// Fallback library for new / low-data accounts (no winning angles yet).
const DEFAULT_ANGLES: Array<{ angle: string; awarenessLevel: AwarenessLevel }> = [
  { angle: "Problem / agitate", awarenessLevel: "problem_aware" },
  { angle: "Before & after", awarenessLevel: "solution_aware" },
  { angle: "Founder story", awarenessLevel: "unaware" },
  { angle: "Social proof / testimonial", awarenessLevel: "product_aware" },
  { angle: "Bold offer", awarenessLevel: "most_aware" },
];

function StarterRow({
  icon,
  imageUrl,
  title,
  meta,
  metricValue,
  metricLabel,
  onClick,
}: {
  icon: React.ReactNode;
  imageUrl?: string | null;
  title: string;
  meta: string;
  metricValue?: string;
  metricLabel?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 border-t px-2 py-2.5 text-left first:border-t-0 hover:bg-muted/50"
    >
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt=""
          className="size-9 shrink-0 rounded-md border object-cover"
        />
      ) : (
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{meta}</span>
      </span>
      {metricValue ? (
        <span className="shrink-0 text-right">
          <span className="block font-mono text-sm font-semibold text-primary">
            {metricValue}
          </span>
          <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">
            {metricLabel}
          </span>
        </span>
      ) : null}
    </button>
  );
}

function ListSkeleton() {
  return (
    <div className="px-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-3 border-t py-2.5 first:border-t-0">
          <Skeleton className="size-8 rounded-md" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-2.5 w-24" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function StudioStarters({ onPick }: { onPick: (starter: Starter) => void }) {
  const trpc = useTRPC();
  const anglesQuery = useQuery(trpc.studio.winningAngles.queryOptions());
  const topQuery = useQuery(trpc.studio.topByPurchases.queryOptions());

  const angles = anglesQuery.data ?? [];
  const top = topQuery.data ?? [];
  const anglesLoading = anglesQuery.isLoading;

  const showFallback = !anglesLoading && angles.length === 0;

  return (
    <div className="mt-6 w-full">
      <Tabs defaultValue="angles">
        <div className="mb-1 flex items-center gap-2 px-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {showFallback ? "Starter angles" : "Start from what's winning"}
          </span>
          <TabsList className="ml-auto h-7">
            <TabsTrigger value="angles" className="text-xs">
              Winning angles
            </TabsTrigger>
            <TabsTrigger value="creatives" className="text-xs">
              High-purchase
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="angles">
          {anglesLoading ? (
            <ListSkeleton />
          ) : showFallback ? (
            <>
              <div className="scroll-fade max-h-64 overflow-y-auto px-2">
                {DEFAULT_ANGLES.map((item) => (
                  <StarterRow
                    key={item.angle}
                    icon={<Sparkles className="size-4" />}
                    title={item.angle}
                    meta={`${awarenessDisplayLabel(item.awarenessLevel)} · starter template`}
                    onClick={() =>
                      onPick({
                        brief: `Static ad using a "${item.angle}" angle.`,
                        angle: item.angle,
                        awarenessLevel: item.awarenessLevel,
                      })
                    }
                  />
                ))}
              </div>
              <p className="mt-2 flex items-center gap-1.5 px-2 text-xs text-muted-foreground">
                <Info className="size-3" />
                Connect Meta and sync performance to see your own winning angles.
              </p>
            </>
          ) : (
            <div className="scroll-fade max-h-64 overflow-y-auto px-2">
              {angles.map((item) => (
                <StarterRow
                  key={item.angle}
                  icon={<Sparkles className="size-4" />}
                  imageUrl={item.assetUrl}
                  title={`"${item.angle}"`}
                  meta={[
                    item.awarenessLevel
                      ? awarenessDisplayLabel(item.awarenessLevel)
                      : null,
                    `${fmtNum(item.adCount)} ads live`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  metricValue={fmtRoas(item.roas)}
                  metricLabel="ROAS"
                  onClick={() =>
                    onPick({
                      brief: `Static ad for the "${item.angle}" angle.`,
                      angle: item.angle,
                      awarenessLevel: item.awarenessLevel ?? undefined,
                      imageUrl: item.assetUrl,
                    })
                  }
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="creatives">
          {topQuery.isLoading ? (
            <ListSkeleton />
          ) : top.length === 0 ? (
            <p className="flex items-center gap-1.5 px-2 py-4 text-xs text-muted-foreground">
              <Info className="size-3" />
              No purchase data yet — generate from a winning angle instead.
            </p>
          ) : (
            <div className="scroll-fade max-h-64 overflow-y-auto px-2">
              {top.map((item) => (
                <StarterRow
                  key={item.creativeId}
                  icon={<Trophy className="size-4" />}
                  imageUrl={item.assetUrl}
                  title={item.name}
                  meta={[
                    item.angle,
                    item.persona,
                    `${fmtNum(item.purchases)} purchases`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  metricValue={fmtRoas(item.roas)}
                  metricLabel="ROAS"
                  onClick={() =>
                    onPick({
                      brief: `Remix this winning static: "${item.name}"${
                        item.angle ? ` (${item.angle} angle)` : ""
                      }.`,
                      angle: item.angle ?? undefined,
                      persona: item.persona ?? undefined,
                      awarenessLevel: item.awarenessLevel ?? undefined,
                      imageUrl: item.assetUrl,
                      creativeId: item.creativeId,
                    })
                  }
                />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
