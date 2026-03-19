import Papa from "papaparse";

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
    roas: [
      "Purchase ROAS (return on ad spend)",
      "Purchase ROAS",
      "ROAS",
    ],
    cpa: [
      "Cost per results",
      "Cost per purchase",
      "CPA",
      "Cost per result",
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
    dateStart: ["Reporting starts", "Start date", "Date start"],
    dateEnd: ["Reporting ends", "End date", "Date end"],
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
  };

  mapping.name = findHeader(headers, SUGGESTIONS.name[level]);
  mapping.parentName = findHeader(headers, SUGGESTIONS.parentName[level]);

  for (const [field, suggestions] of Object.entries(SUGGESTIONS.shared)) {
    mapping[field as keyof ColumnMapping] = findHeader(headers, suggestions);
  }

  return mapping;
}

export interface MappedRow {
  name?: string;
  parentName?: string;
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

      // Numeric fields
      for (const key of ["roas", "cpa", "ctr", "conversionRate", "spend", "frequency", "cpm"] as const) {
        if (mapping[key]) {
          const val = parseNumeric(row[mapping[key]!]);
          if (val !== undefined) mapped[key] = val;
        }
      }

      // Integer fields
      for (const key of ["conversions", "impressions", "reach"] as const) {
        if (mapping[key]) {
          const raw = row[mapping[key]!]?.trim().replace(/[^0-9.-]/g, "");
          const n = parseInt(raw, 10);
          if (!isNaN(n)) mapped[key] = n;
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
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (!isNaN(date.getTime())) {
    return date.toISOString().split("T")[0];
  }
  return value;
}
