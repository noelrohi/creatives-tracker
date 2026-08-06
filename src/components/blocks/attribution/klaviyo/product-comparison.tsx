"use client";

import { Badge } from "@/components/ui/badge";

export type ProductsData =
  | {
      kind: "canonical";
      productStatus: string;
      links: Array<{ status: string; reasonCodes: string[] }>;
    }
  | { kind: "non_canonical"; orderStatus: string }
  | { kind: "diagnostic"; matcherVersion: string; comparison: unknown }
  | { kind: "not_found" };

/**
 * Product multiset comparison. One order-level Shopify Net sales figure is
 * shown by the sheet header; observations are never summed across Placed
 * Order and Ordered Product sources, no product revenue exists, and a
 * per-edge diagnostic comparison never publishes a concluded status.
 */
export function ProductComparison(props: {
  data: ProductsData;
  candidateSelected: boolean;
}) {
  if (props.data.kind === "not_found") {
    return <p className="text-sm text-muted-foreground">Not found.</p>;
  }
  if (props.data.kind === "non_canonical") {
    return (
      <p className="text-sm text-muted-foreground">
        No published product conclusion for a {props.data.orderStatus} order.
        Select a candidate edge from the explanation tab for a diagnostic
        comparison.
      </p>
    );
  }
  if (props.data.kind === "diagnostic") {
    return (
      <div className="space-y-2 text-sm">
        <Badge variant="secondary">Per-edge diagnostic — not a conclusion</Badge>
        <p className="text-xs text-muted-foreground">
          Matcher {props.data.matcherVersion}. Overlap shown for the inspected
          edge only; no product status is published from this view.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-center gap-2">
        <span>Published product status</span>
        <Badge variant="outline">{props.data.productStatus}</Badge>
      </div>
      {props.data.links.map((link, index) => (
        <p key={index} className="text-xs text-muted-foreground">
          Selected Klaviyo source: {link.status}
          {link.reasonCodes.length > 0 ? ` · ${link.reasonCodes.join(", ")}` : ""}
        </p>
      ))}
      {props.candidateSelected ? (
        <p className="text-xs text-muted-foreground">
          Candidate inspection does not change this published status.
        </p>
      ) : null}
    </div>
  );
}
