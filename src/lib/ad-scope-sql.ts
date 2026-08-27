import { sql, type SQL } from "drizzle-orm";

/**
 * Campaign / ad set scoping for any query already joined to the `ad` table.
 *
 * Both fragments reach the campaign through a subquery on `ad_set` rather than
 * a join, so a caller that never joins `ad_set` (the daily portfolio and
 * demographic rollups don't) can filter by campaign without restructuring its
 * FROM clause. Each returns an empty fragment when nothing is selected, so it
 * can be interpolated unconditionally.
 */
function idList(ids: string[]): SQL {
  return sql.join(ids.map((id) => sql`${id}`), sql`, `);
}

export function campaignScopeFilter(
  campaignIds: string[] | undefined,
  adAlias = "ad",
): SQL {
  if (!campaignIds?.length) return sql``;
  const adSetId = sql.raw(`${adAlias}.ad_set_id`);
  return sql`AND ${adSetId} IN (SELECT ast.id FROM ad_set ast WHERE ast.campaign_id IN (${idList(campaignIds)}))`;
}

export function adSetScopeFilter(
  adSetIds: string[] | undefined,
  adAlias = "ad",
): SQL {
  if (!adSetIds?.length) return sql``;
  const adSetId = sql.raw(`${adAlias}.ad_set_id`);
  return sql`AND ${adSetId} IN (${idList(adSetIds)})`;
}
