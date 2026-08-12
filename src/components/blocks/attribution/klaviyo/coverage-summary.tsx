"use client";

export type LabCoverage = {
  orders: Record<string, number>;
  events: Record<string, number>;
  boundaryWarnings?: number;
};

const ORDER_KEYS = [
  "confirmed",
  "candidate",
  "ambiguous",
  "no_klaviyo_event",
  "duplicate_conversion_events",
  "not_evaluated",
] as const;

const EVENT_KEYS = [
  "confirmed",
  "candidate",
  "ambiguous",
  "unmatched",
  "not_evaluated",
] as const;

function count(record: Record<string, number>, key: string): string {
  const value = record[key];
  return value === undefined ? "0" : String(value);
}

/**
 * Explicit coverage counts. Zero renders as 0; nothing is inferred from
 * another count; event-side `not_evaluated` keeps its boundary caveat.
 */
export function CoverageSummary({ coverage }: { coverage: LabCoverage }) {
  return (
    <div className="grid gap-3 rounded-md border p-4 md:grid-cols-2">
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          Shopify orders
        </p>
        <dl className="mt-1 grid grid-cols-2 gap-x-4 text-sm">
          {ORDER_KEYS.map((key) => (
            <div key={key} className="flex justify-between gap-2">
              <dt className="text-muted-foreground">
                {key === "not_evaluated" ? "Not evaluated" : key.replaceAll("_", " ")}
              </dt>
              <dd data-testid={`order-${key}`}>{count(coverage.orders, key)}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          Klaviyo events
        </p>
        <dl className="mt-1 grid grid-cols-2 gap-x-4 text-sm">
          {EVENT_KEYS.map((key) => (
            <div key={key} className="flex justify-between gap-2">
              <dt className="text-muted-foreground">
                {key === "not_evaluated"
                  ? "Outside evaluated boundary"
                  : key.replaceAll("_", " ")}
              </dt>
              <dd data-testid={`event-${key}`}>{count(coverage.events, key)}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-1 text-xs text-muted-foreground">
          A counterpart may exist outside this window.
        </p>
      </div>
    </div>
  );
}
