"use client";

import { Badge } from "@/components/ui/badge";

function fmt(
  value: string | number | null | undefined,
  opts?: { prefix?: string; suffix?: string; decimals?: number },
) {
  if (value == null || value === "") return "—";
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return "—";
  const decimals = opts?.decimals ?? 2;
  const formatted = num >= 1000 ? `${(num / 1000).toFixed(1)}k` : num.toFixed(decimals);
  return `${opts?.prefix ?? ""}${formatted}${opts?.suffix ?? ""}`;
}

interface LinkedAd {
  id: string;
  name: string;
  status: string | null;
  campaignName: string | null;
  totalSpend: string | null;
  avgRoas: string | null;
  totalConversions: number | null;
  minDate: string | null;
  maxDate: string | null;
}

export function CreativeAdsTab({ ads }: { ads: LinkedAd[] | undefined }) {
  if (!ads || ads.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/40 px-4 py-12 text-center">
        <p className="text-sm text-muted-foreground/50">Not used in any ads yet</p>
      </div>
    );
  }

  return (
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
          {ads.map((ad) => (
            <tr key={ad.id} className="border-b border-border/20 last:border-0">
              <td className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="max-w-[200px] truncate font-medium">{ad.name}</span>
                  <Badge
                    variant={ad.status === "active" ? "outline" : "secondary"}
                    className={
                      ad.status === "active"
                        ? "border-emerald-200 text-[9px] text-emerald-600"
                        : "text-[9px]"
                    }
                  >
                    {ad.status === "active"
                      ? "Active"
                      : ad.status === "paused"
                        ? "Paused"
                        : "Archived"}
                  </Badge>
                </div>
              </td>
              <td className="max-w-[140px] truncate px-3 py-2 text-muted-foreground/60">
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
              <td className="px-3 py-2 text-right text-[11px] text-muted-foreground/50">
                {ad.minDate && ad.maxDate ? `${ad.minDate} — ${ad.maxDate}` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
