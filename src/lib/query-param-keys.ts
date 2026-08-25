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

export function getQueryParamKeys(
  url: string | null,
  urlTags: string | null = null,
): string | null {
  const keys = new Set<string>();
  for (const params of [getUrlSearchParams(url), getUrlTagParams(urlTags)]) {
    for (const key of params?.keys() ?? []) {
      if (key) keys.add(key);
    }
  }

  const sortedKeys = [...keys].sort((a, b) => a.localeCompare(b));
  return sortedKeys.length > 0 ? sortedKeys.join(", ") : null;
}

export function getQueryParamValue(
  url: string | null,
  urlTags: string | null,
  key: string,
): string | null {
  const tagValue = getUrlTagParams(urlTags)?.get(key);
  if (tagValue) return tagValue;

  return getUrlSearchParams(url)?.get(key) || null;
}
