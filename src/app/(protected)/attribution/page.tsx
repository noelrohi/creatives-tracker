import { redirect } from "next/navigation";

/**
 * The attribution view graduated to the dashboard at `/`; old links land
 * there. Query params ride along so bookmarked deep-links (`?range=…&bucket=…`)
 * still open the right range and drawer.
 */
export default async function AttributionRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const values = Array.isArray(value) ? value : value != null ? [value] : [];
    for (const entry of values) query.append(key, entry);
  }
  const suffix = query.toString();
  redirect(suffix ? `/?${suffix}` : "/");
}
