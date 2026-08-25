export type UtmParam = {
  key: string;
  value: string;
};

const UTM_ORDER = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
] as const;

function getUrlSearchParams(url: string | null): URLSearchParams | null {
  if (!url) return null;

  try {
    return new URL(url).searchParams;
  } catch {
    return null;
  }
}

function getUrlTagParams(urlTags: string | null): URLSearchParams | null {
  if (!urlTags) return null;
  return new URLSearchParams(urlTags.replace(/^\?/, ""));
}

export function getUtmParams(
  url: string | null,
  urlTags: string | null,
): UtmParam[] {
  const values = new Map<string, string>();

  // Meta URL tags are authoritative, so apply them after embedded URL values.
  for (const params of [getUrlSearchParams(url), getUrlTagParams(urlTags)]) {
    for (const [rawKey, value] of params?.entries() ?? []) {
      const key = rawKey.toLowerCase();
      if (key.startsWith("utm_") && value) values.set(key, value);
    }
  }

  return [...values.entries()]
    .sort(([left], [right]) => {
      const leftIndex = UTM_ORDER.indexOf(left as (typeof UTM_ORDER)[number]);
      const rightIndex = UTM_ORDER.indexOf(right as (typeof UTM_ORDER)[number]);
      const leftRank = leftIndex === -1 ? UTM_ORDER.length : leftIndex;
      const rightRank = rightIndex === -1 ? UTM_ORDER.length : rightIndex;
      return leftRank - rightRank || left.localeCompare(right);
    })
    .map(([key, value]) => ({ key, value }));
}
