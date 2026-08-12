"use client";

import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTRPC } from "@/lib/trpc/client";
import { ClaimsChain } from "./claims-chain";
import { DETAIL_TABS, type DetailTab } from "./copy";
import { JourneyTimeline } from "./journey-timeline";
import { OrderExplanation } from "./order-explanation";
import { LabPanelState } from "./panel-state";
import { ProductComparison } from "./product-comparison";
import { SourceInspector } from "./source-inspector";
import type { useKlaviyoLabState } from "./use-klaviyo-lab-state";

const TAB_LABELS: Record<DetailTab, string> = {
  explanation: "Explanation",
  products: "Products",
  journey: "Journey",
  claims: "Claims",
  inspector: "Inspector",
};

/**
 * URL-addressable five-tab detail sheet. Each tab owns a lazy query;
 * `candidateId` reaches only products/claims/inspector and never journey;
 * a stale bookmarked candidate returns NOT_FOUND server-side, clears the
 * candidate key, and keeps the order sheet open.
 */
export function OrderDetailSheet({
  lab,
}: {
  lab: ReturnType<typeof useKlaviyoLabState>;
}) {
  const trpc = useTRPC();
  const orderId = lab.state.order;
  const candidateId = lab.state.candidate;
  const detail = lab.state.detail;

  const explanation = useQuery({
    ...trpc.klaviyo.orderExplanation.queryOptions({ orderId: orderId ?? "" }),
    enabled: orderId !== null,
  });
  const products = useQuery({
    ...trpc.klaviyo.orderProducts.queryOptions({
      orderId: orderId ?? "",
      candidateId: candidateId ?? undefined,
    }),
    enabled: orderId !== null && detail === "products",
    retry: false,
  });
  const journey = useQuery({
    ...trpc.klaviyo.orderJourney.queryOptions({
      orderId: orderId ?? "",
      lookbackDays: lab.lookback,
    }),
    enabled: orderId !== null && detail === "journey",
  });
  const claims = useQuery({
    ...trpc.klaviyo.orderClaims.queryOptions({
      orderId: orderId ?? "",
      candidateId: candidateId ?? undefined,
    }),
    enabled: orderId !== null && detail === "claims",
    retry: false,
  });
  const inspector = useQuery({
    ...trpc.klaviyo.orderInspector.queryOptions({
      orderId: orderId ?? "",
      candidateId: candidateId ?? undefined,
    }),
    enabled: orderId !== null && detail === "inspector",
    retry: false,
  });

  // A stale bookmarked candidate: clear only the candidate key; the order
  // sheet stays open on the canonical view.
  const staleCandidate =
    candidateId !== null &&
    [products, claims, inspector].some(
      (query) =>
        query.isError &&
        (query.error as { data?: { code?: string } })?.data?.code ===
          "NOT_FOUND",
    );
  if (staleCandidate) {
    void lab.setState({ candidate: null });
  }

  if (orderId === null) return null;

  return (
    <Sheet
      open={orderId !== null}
      onOpenChange={(open) => {
        if (!open) lab.closeDetail();
      }}
    >
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-4xl">
        <SheetHeader>
          <SheetTitle>Order evidence</SheetTitle>
          <p className="text-xs text-muted-foreground">
            Advisory evidence only
          </p>
        </SheetHeader>
        <Tabs
          value={detail}
          onValueChange={(value) =>
            void lab.setState({ detail: value as DetailTab })
          }
        >
          <TabsList>
            {DETAIL_TABS.map((value) => (
              <TabsTrigger key={value} value={value}>
                {TAB_LABELS[value]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="p-1">
          {detail === "explanation" ? (
            explanation.isError ? (
              <LabPanelState
                kind="error"
                title="Explanation could not load"
                body=""
                onRetry={() => void explanation.refetch()}
              />
            ) : explanation.data ? (
              <OrderExplanation
                data={explanation.data}
                selectedCandidateId={candidateId}
                onInspectCandidate={(next) =>
                  void lab.setState({ candidate: next })
                }
              />
            ) : (
              <LabPanelState kind="loading" title="Loading" body="" />
            )
          ) : null}
          {detail === "products" ? (
            products.isError && !staleCandidate ? (
              <LabPanelState
                kind="error"
                title="Products could not load"
                body=""
                onRetry={() => void products.refetch()}
              />
            ) : products.data ? (
              <ProductComparison
                data={products.data}
                candidateSelected={candidateId !== null}
              />
            ) : (
              <LabPanelState kind="loading" title="Loading" body="" />
            )
          ) : null}
          {detail === "journey" ? (
            journey.isError ? (
              <LabPanelState
                kind="error"
                title="Journey could not load"
                body=""
                onRetry={() => void journey.refetch()}
              />
            ) : journey.data ? (
              <JourneyTimeline
                data={journey.data}
                lookback={lab.lookback}
                onLookbackChange={(lookback) =>
                  void lab.setState({ lookback })
                }
              />
            ) : (
              <LabPanelState kind="loading" title="Loading" body="" />
            )
          ) : null}
          {detail === "claims" ? (
            claims.isError && !staleCandidate ? (
              <LabPanelState
                kind="error"
                title="Claims could not load"
                body=""
                onRetry={() => void claims.refetch()}
              />
            ) : claims.data ? (
              <ClaimsChain data={claims.data} />
            ) : (
              <LabPanelState kind="loading" title="Loading" body="" />
            )
          ) : null}
          {detail === "inspector" ? (
            inspector.isError && !staleCandidate ? (
              <LabPanelState
                kind="error"
                title="Inspector could not load"
                body=""
                onRetry={() => void inspector.refetch()}
              />
            ) : inspector.data ? (
              <SourceInspector
                data={inspector.data}
                onCopyEventId={(externalEventId) => {
                  void navigator.clipboard?.writeText(externalEventId);
                  toast.success("Event ID copied");
                }}
              />
            ) : (
              <LabPanelState kind="loading" title="Loading" body="" />
            )
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
