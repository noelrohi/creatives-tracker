import { redirect } from "next/navigation";

/**
 * The MER view lives in the Meta page's Charts tab now; old links land there.
 * Query params ride along (`from`/`to`/`account`/`team` mean the same thing
 * on both screens), and the account detail pages below this route stay put.
 */
export default async function MerRedirect({
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
  query.set("tab", "charts");
  redirect(`/meta?${query.toString()}`);
}
