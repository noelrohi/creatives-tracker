import Papa from "papaparse";
import { normalizeDateOnly } from "./date";

export interface ParsedCSV {
  headers: string[];
  rows: Record<string, string>[];
}

export function parseCSV(csvString: string): ParsedCSV {
  const result = Papa.parse<Record<string, string>>(csvString, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim(),
  });

  return {
    headers: result.meta.fields ?? [],
    rows: result.data,
  };
}

export type ImportLevel = "campaign" | "ad_set" | "ad";

const LEVEL_INDICATORS: { level: ImportLevel; patterns: string[] }[] = [
  { level: "ad", patterns: ["ad name", "ad delivery"] },
  { level: "ad_set", patterns: ["ad set name", "ad set delivery"] },
  { level: "campaign", patterns: ["campaign name", "campaign delivery"] },
];

export function detectLevel(headers: string[]): ImportLevel {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const { level, patterns } of LEVEL_INDICATORS) {
    if (patterns.some((p) => lower.includes(p))) return level;
  }
  return "campaign";
}

const LEVEL_LABELS: Record<ImportLevel, string> = {
  campaign: "Campaigns",
  ad_set: "Ad Sets",
  ad: "Ads",
};

export function getLevelLabel(level: ImportLevel): string {
  return LEVEL_LABELS[level];
}

export interface ColumnMapping {
  name: string | null;
  parentName: string | null;
  campaignName: string | null;
  adSetName: string | null;
  roas: string | null;
  cpa: string | null;
  ctr: string | null;
  conversionRate: string | null;
  spend: string | null;
  conversions: string | null;
  impressions: string | null;
  reach: string | null;
  frequency: string | null;
  cpm: string | null;
  qualityRanking: string | null;
  engagementRateRanking: string | null;
  conversionRateRanking: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  // New fields from Meta reports
  linkClicks: string | null;
  clicksAll: string | null;
  cpc: string | null;
  ctrLinkClick: string | null;
  landingPageViews: string | null;
  costPerLpv: string | null;
  purchaseValue: string | null;
  // Ecom funnel
  addToCart: string | null;
  initiateCheckout: string | null;
  costPerAddToCart: string | null;
  // Video
  videoViews3s: string | null;
  videoThruplay: string | null;
  videoAvgWatchTime: string | null;
  // Breakdowns
  country: string | null;
  platform: string | null;
  placement: string | null;
  device: string | null;
  age: string | null;
  gender: string | null;
  // Meta fields
  delivery: string | null;
  adId: string | null;
  campaignId: string | null;
  adSetId: string | null;
}

interface SuggestionSet {
  name: Record<ImportLevel, string[]>;
  parentName: Record<ImportLevel, string[]>;
  shared: Record<string, string[]>;
}

const SUGGESTIONS: SuggestionSet = {
  name: {
    campaign: ["Campaign name", "Campaign"],
    ad_set: ["Ad set name", "Ad set"],
    ad: ["Ad name", "Ad"],
  },
  parentName: {
    campaign: [],
    ad_set: ["Campaign name", "Campaign"],
    ad: ["Ad set name", "Ad set"],
  },
  shared: {
    campaignName: ["Campaign name", "Campaign"],
    adSetName: ["Ad set name", "Ad set"],
    roas: [
      "Purchase ROAS (return on ad spend)",
      "Purchase ROAS",
      "Results ROAS",
      "ROAS",
    ],
    cpa: [
      "Cost per purchase (USD)",
      "Cost per purchase",
      "Cost per results",
      "Cost per result",
      "CPA",
    ],
    ctr: ["CTR (all)", "CTR"],
    conversionRate: ["Conversion rate", "Conv rate"],
    spend: [
      "Amount spent (USD)",
      "Amount spent",
      "Spend",
      "Cost",
    ],
    conversions: ["Purchases", "Conversions", "Results"],
    impressions: ["Impressions"],
    reach: ["Reach"],
    frequency: ["Frequency"],
    cpm: [
      "CPM (cost per 1,000 impressions) (USD)",
      "CPM (cost per 1,000 impressions)",
      "CPM",
    ],
    qualityRanking: ["Quality ranking"],
    engagementRateRanking: ["Engagement rate ranking"],
    conversionRateRanking: ["Conversion rate ranking"],
    dateStart: ["Day", "Reporting starts", "Start date", "Date start"],
    dateEnd: ["Day", "Reporting ends", "End date", "Date end"],
    // New fields
    linkClicks: ["Link clicks"],
    clicksAll: ["Clicks (all)"],
    cpc: [
      "CPC (cost per link click) (USD)",
      "CPC (cost per link click)",
      "CPC",
    ],
    ctrLinkClick: [
      "CTR (link click-through rate)",
      "Link CTR",
    ],
    landingPageViews: ["Landing page views"],
    costPerLpv: [
      "Cost per landing page view (USD)",
      "Cost per landing page view",
    ],
    purchaseValue: [
      "Purchases conversion value",
      "Purchase conversion value",
      "Conversion value",
    ],
    delivery: [
      "Ad delivery",
      "Ad set delivery",
      "Campaign delivery",
      "Delivery",
    ],
    adId: [
      "Ad ID",
      "Ad id",
    ],
    campaignId: [
      "Campaign ID",
      "Campaign id",
    ],
    adSetId: [
      "Ad set ID",
      "Ad set id",
    ],
    // Ecom funnel
    addToCart: [
      "Adds to cart",
      "Add to cart",
      "Website adds to cart",
    ],
    initiateCheckout: [
      "Checkouts initiated",
      "Initiate checkout",
      "Website checkouts initiated",
    ],
    costPerAddToCart: [
      "Cost per add to cart",
      "Cost per website add to cart",
    ],
    // Video
    videoViews3s: [
      "3-second video plays",
      "3-second video views",
      "Video plays at 3s",
    ],
    videoThruplay: [
      "ThruPlays",
      "ThruPlay",
      "Video ThruPlays",
    ],
    videoAvgWatchTime: [
      "Video average play time",
      "Average video play time",
      "Video avg watch time",
    ],
    // Breakdowns
    country: ["Country"],
    platform: [
      "Publisher platform",
      "Platform",
    ],
    placement: [
      "Platform and placement",
      "Placement",
    ],
    device: [
      "Device platform",
      "Device",
      "Impression device",
    ],
    age: ["Age"],
    gender: ["Gender"],
  },
};

function findHeader(headers: string[], suggestions: string[]): string | null {
  const lowerHeaders = headers.map((h) => h.toLowerCase().trim());

  for (const suggestion of suggestions) {
    const idx = lowerHeaders.indexOf(suggestion.toLowerCase());
    if (idx !== -1) return headers[idx];
  }

  for (const suggestion of suggestions) {
    const lower = suggestion.toLowerCase();
    const idx = lowerHeaders.findIndex(
      (h) => h.startsWith(lower) || h.includes(lower),
    );
    if (idx !== -1) return headers[idx];
  }

  return null;
}

export function suggestMapping(
  headers: string[],
  level: ImportLevel,
): ColumnMapping {
  const mapping: ColumnMapping = {
    name: null,
    parentName: null,
    campaignName: null,
    adSetName: null,
    roas: null,
    cpa: null,
    ctr: null,
    conversionRate: null,
    spend: null,
    conversions: null,
    impressions: null,
    reach: null,
    frequency: null,
    cpm: null,
    qualityRanking: null,
    engagementRateRanking: null,
    conversionRateRanking: null,
    dateStart: null,
    dateEnd: null,
    linkClicks: null,
    clicksAll: null,
    cpc: null,
    ctrLinkClick: null,
    landingPageViews: null,
    costPerLpv: null,
    purchaseValue: null,
    addToCart: null,
    initiateCheckout: null,
    costPerAddToCart: null,
    videoViews3s: null,
    videoThruplay: null,
    videoAvgWatchTime: null,
    country: null,
    platform: null,
    placement: null,
    device: null,
    age: null,
    gender: null,
    delivery: null,
    adId: null,
    campaignId: null,
    adSetId: null,
  };

  mapping.name = findHeader(headers, SUGGESTIONS.name[level]);
  mapping.parentName = findHeader(headers, SUGGESTIONS.parentName[level]);

  for (const [field, suggestions] of Object.entries(SUGGESTIONS.shared)) {
    mapping[field as keyof ColumnMapping] = findHeader(headers, suggestions);
  }

  return mapping;
}

/**
 * Detect if this is a Meta Ads Manager report that can be auto-imported
 * without manual column mapping.
 */
export function isMetaReport(headers: string[]): boolean {
  const lower = headers.map((h) => h.toLowerCase().trim());
  const required = ["reporting starts", "reporting ends"];
  const hasRequired = required.every((r) => lower.includes(r));
  const hasLevel = lower.includes("ad name") || lower.includes("ad set name") || lower.includes("campaign name");
  return hasRequired && hasLevel;
}

export interface MappedRow {
  name?: string;
  assetUrl?: string;
  videoUrl?: string;
  format?: "static" | "video" | "ugc" | "carousel";
  parentName?: string;
  campaignName?: string;
  adSetName?: string;
  roas?: string;
  cpa?: string;
  ctr?: string;
  conversionRate?: string;
  spend?: string;
  conversions?: number;
  impressions?: number;
  reach?: number;
  frequency?: string;
  cpm?: string;
  qualityRanking?: string;
  engagementRateRanking?: string;
  conversionRateRanking?: string;
  dateStart: string;
  dateEnd: string;
  // New fields
  linkClicks?: number;
  clicksAll?: number;
  cpc?: string;
  ctrLinkClick?: string;
  landingPageViews?: number;
  costPerLpv?: string;
  purchaseValue?: string;
  purchaseValue7dClick?: string | null;
  purchaseValue1dView?: string | null;
  attributionWindows?: string | null;
  addToCart?: number;
  initiateCheckout?: number;
  costPerAddToCart?: string;
  videoViews3s?: number;
  videoThruplay?: number;
  videoAvgWatchTime?: string;
  country?: string;
  platform?: string;
  placement?: string;
  device?: string;
  age?: string;
  gender?: string;
  delivery?: string;
  adId?: string;
  campaignId?: string;
  adSetId?: string;
  destinationUrl?: string;
}

export function applyMapping(
  rows: Record<string, string>[],
  mapping: ColumnMapping,
): MappedRow[] {
  return rows
    .map((row) => {
      const dateStart = mapping.dateStart
        ? row[mapping.dateStart]?.trim()
        : "";
      const dateEnd = mapping.dateEnd ? row[mapping.dateEnd]?.trim() : "";

      if (!dateStart || !dateEnd) return null;

      const mapped: MappedRow = {
        dateStart: normalizeDate(dateStart),
        dateEnd: normalizeDate(dateEnd),
      };

      if (mapping.name) {
        const v = row[mapping.name]?.trim();
        if (v) mapped.name = v;
      }
      if (mapping.parentName) {
        const v = row[mapping.parentName]?.trim();
        if (v) mapped.parentName = v;
      }
      if (mapping.campaignName) {
        const v = row[mapping.campaignName]?.trim();
        if (v) mapped.campaignName = v;
      }
      if (mapping.adSetName) {
        const v = row[mapping.adSetName]?.trim();
        if (v) mapped.adSetName = v;
      }

      // Numeric fields
      for (const key of [
        "roas", "cpa", "ctr", "conversionRate", "spend", "frequency", "cpm",
        "cpc", "ctrLinkClick", "costPerLpv", "purchaseValue",
        "costPerAddToCart", "videoAvgWatchTime",
      ] as const) {
        if (mapping[key]) {
          const val = parseNumeric(row[mapping[key]!]);
          if (val !== undefined) mapped[key] = val;
        }
      }

      // Integer fields
      for (const key of [
        "conversions", "impressions", "reach",
        "linkClicks", "clicksAll", "landingPageViews",
        "addToCart", "initiateCheckout", "videoViews3s", "videoThruplay",
      ] as const) {
        if (mapping[key]) {
          const raw = row[mapping[key]!]?.trim().replace(/[^0-9.-]/g, "");
          const n = parseInt(raw, 10);
          if (!isNaN(n)) mapped[key] = n;
        }
      }

      // ID fields
      for (const key of ["adId", "campaignId", "adSetId"] as const) {
        if (mapping[key]) {
          const v = row[mapping[key]!]?.trim();
          if (v && v !== "" && v !== "-") mapped[key] = v;
        }
      }

      // Delivery status
      if (mapping.delivery) {
        const v = row[mapping.delivery]?.trim().toLowerCase();
        if (v && v !== "-" && v !== "") mapped.delivery = v;
      }

      // Breakdown fields
      for (const key of ["country", "platform", "placement", "device", "age", "gender"] as const) {
        if (mapping[key]) {
          const v = row[mapping[key]!]?.trim();
          if (v && v !== "-" && v !== "") mapped[key] = v;
        }
      }

      // Text fields (rankings)
      for (const key of ["qualityRanking", "engagementRateRanking", "conversionRateRanking"] as const) {
        if (mapping[key]) {
          const v = row[mapping[key]!]?.trim();
          if (v && v !== "-" && v !== "") mapped[key] = v;
        }
      }

      return mapped;
    })
    .filter((r): r is MappedRow => r !== null);
}

function parseNumeric(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim().replace(/[$,%]/g, "").replace(/,/g, "");
  if (cleaned === "" || isNaN(Number(cleaned))) return undefined;
  return cleaned;
}

function normalizeDate(value: string): string {
  return normalizeDateOnly(value);
}
