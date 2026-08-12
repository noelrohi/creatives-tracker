"use client";

import { Check } from "@/components/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { FindingRow } from "@/components/blocks/attribution/finding-row";
import { useFindingsState } from "@/components/blocks/attribution/findings-content";
import type { VoiceContext } from "@/components/blocks/attribution/copy";
import type { FindingType } from "@/lib/findings";
import { findings as copy } from "./insights-copy";

/** The three rules this screen owns (§8) — the other five live on /attribution. */
const INSIGHTS_FINDING_TYPES: readonly FindingType[] = [
  "ad_lp_funnel_mismatch",
  "untagged_spend",
  "utm_template_drift",
];

/**
 * The same findings chassis the attribution screen uses, filtered to what this
 * screen is about. Filtering here rather than in the query keeps one source of
 * findings state — the row actions, mutes and refresh behave identically.
 */
export function InsightsFindings({
  ctx,
  canAct,
  links,
}: {
  ctx: VoiceContext;
  canAct: boolean;
  links: { metaVsShopify: string; connections: string };
}) {
  const state = useFindingsState();
  const items = state.items.filter((item) =>
    INSIGHTS_FINDING_TYPES.includes(item.type),
  );

  return (
    <section className="overflow-hidden rounded-md border border-border bg-card">
      <div className="flex items-baseline justify-between gap-3 px-3 py-2.5">
        <span className="text-[12.5px] font-semibold">{copy.title}</span>
        {state.isPending ? null : (
          <span className="text-[11px] text-muted-foreground">
            {items.length > 0 ? copy.subtitle(items.length) : ""}
          </span>
        )}
      </div>

      {state.isPending ? (
        <div className="flex flex-col gap-2 px-3 pb-3">
          {Array.from({ length: 2 }).map((_, index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
          <span
            className="flex size-8 items-center justify-center rounded-full"
            style={{
              backgroundColor: "var(--attr-good-soft)",
              color: "var(--attr-good)",
            }}
          >
            <Check className="size-4" />
          </span>
          <span className="text-[13px] font-semibold">{copy.allClear}</span>
          <span className="text-[12px] leading-relaxed text-muted-foreground">
            {copy.allClearBody}
          </span>
        </div>
      ) : (
        <div className="border-t border-border">
          {items.map((item, index) => {
            const key = item.id ?? `${item.type}:${index}`;
            return (
              <FindingRow
                key={key}
                item={item}
                expanded={state.openId === key}
                onToggle={() =>
                  state.setOpenId(state.openId === key ? null : key)
                }
                context={{
                  ctx,
                  frozen: false,
                  canAct,
                  busy: state.busy,
                  links,
                }}
                handlers={{
                  // Orders belong to the attribution screen; none of these three
                  // rules asks for them, so the jump is never offered here.
                  onSeeOrders: () => undefined,
                  onResolve: () =>
                    item.id && state.resolve.mutate({ findingId: item.id }),
                  onSnooze: () => state.mute.mutate({ type: item.type }),
                  onRerun: () =>
                    item.id && state.rerun.mutate({ findingId: item.id }),
                }}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
