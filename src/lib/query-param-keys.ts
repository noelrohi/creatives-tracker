export function getQueryParamKeys(url: string | null): string | null {
  if (!url) return null;

  try {
    const keys = [...new Set(new URL(url).searchParams.keys())].sort((a, b) =>
      a.localeCompare(b),
    );

    return keys.length > 0 ? keys.join(", ") : null;
  } catch {
    return null;
  }
}
