#!/usr/bin/env node
/**
 * Ad Library vendor trial harness — wayfinder ticket #149 (map #146).
 *
 * Runs the trial protocol from docs/research/ad-library-vendors.md §8 against
 * whichever vendor keys are present in the environment:
 *
 *   SCRAPECREATORS_API_KEY  https://scrapecreators.com          (100 free credits)
 *   SEARCHAPI_API_KEY       https://www.searchapi.io            (100 free requests)
 *   APIFY_TOKEN             https://apify.com                   ($5/mo free credit)
 *
 * For each configured vendor and each target page: resolve the Facebook page id,
 * paginate active US ads up to LIMIT, and save every raw response verbatim under
 * docs/research/ad-library-trial/<vendor>/. Raw payloads are the deliverable —
 * they become the ground truth for the NormalizedAd contract (ticket #150).
 *
 * Usage:
 *   node --env-file=.env scripts/ad-library-trial.mjs            # default pages
 *   node --env-file=.env scripts/ad-library-trial.mjs "Some Brand=facebookslug"
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const LIMIT = 100;
const MAX_PAGES = 8; // pagination safety stop (~25-50 ads/page expected)
const OUT_ROOT = path.join(process.cwd(), "docs", "research", "ad-library-trial");

// name = search query for page-id resolution; slug = facebook.com/<slug> for Apify
const DEFAULT_TARGETS = [
  { name: "AIRWAAV", slug: "airwaav" },
  { name: "Shock Doctor", slug: "shockdoctor" },
];
const targets = process.argv.slice(2).length
  ? process.argv.slice(2).map((arg) => {
      const [name, slug] = arg.split("=");
      return { name, slug: slug ?? name.toLowerCase().replace(/\s+/g, "") };
    })
  : DEFAULT_TARGETS;

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

async function save(vendor, file, data) {
  const dir = path.join(OUT_ROOT, vendor);
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, file);
  await writeFile(p, typeof data === "string" ? data : JSON.stringify(data, null, 2));
  console.log(`    saved ${path.relative(process.cwd(), p)}`);
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _nonJsonBody: text.slice(0, 2000) };
  }
  if (!res.ok) console.warn(`    HTTP ${res.status} from ${url.split("?")[0]}`);
  return { status: res.status, json };
}

// Vendors disagree on envelope names, so find ad arrays structurally: any array
// of objects carrying an ad_archive_id (or adArchiveID) is an ad list.
function findAds(node, found = []) {
  if (Array.isArray(node)) {
    if (node.some((x) => x && typeof x === "object" && (x.ad_archive_id ?? x.adArchiveID))) {
      found.push(...node);
    } else {
      for (const x of node) findAds(x, found);
    }
  } else if (node && typeof node === "object") {
    for (const v of Object.values(node)) findAds(v, found);
  }
  return found;
}

function findFirst(node, keyRe) {
  if (Array.isArray(node)) {
    for (const x of node) {
      const hit = findFirst(x, keyRe);
      if (hit !== undefined) return hit;
    }
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (keyRe.test(k) && (typeof v === "string" || typeof v === "number") && v !== "") return v;
    }
    for (const v of Object.values(node)) {
      const hit = findFirst(v, keyRe);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

function summarize(vendor, target, pagesFetched, ads) {
  const ids = new Set(ads.map((a) => a.ad_archive_id ?? a.adArchiveID));
  const titles = ads.map((a) => a.snapshot?.title ?? a.title);
  const nullTitles = titles.filter((t) => t == null || t === "").length;
  const mediaUrl = findFirst(ads, /(original_image_url|video_sd_url|image_url|resized_image_url)/);
  const summary = {
    vendor,
    target: target.name,
    requests: pagesFetched,
    adsReturned: ads.length,
    uniqueArchiveIds: ids.size,
    adsPerResponse: pagesFetched ? Math.round(ads.length / pagesFetched) : 0,
    nullTitleRate: ads.length ? `${nullTitles}/${ads.length}`  : "n/a",
    sampleMediaUrl: mediaUrl ?? null,
    archiveIds: [...ids].sort(),
  };
  console.log(
    `    ${ads.length} ads in ${pagesFetched} request(s) (~${summary.adsPerResponse}/page), ` +
      `${summary.nullTitleRate} null titles`,
  );
  return summary;
}

async function runScrapeCreators(target) {
  const key = process.env.SCRAPECREATORS_API_KEY;
  const headers = { "x-api-key": key };
  const base = "https://api.scrapecreators.com/v1/facebook/adLibrary";
  const tslug = slugify(target.name);

  const search = await getJson(`${base}/search/companies?query=${encodeURIComponent(target.name)}`, headers);
  await save("scrapecreators", `${tslug}-company-search.json`, search.json);
  const pageId = findFirst(search.json, /^page_?id$/i);
  if (!pageId) {
    console.warn(`    could not extract a page_id — inspect the saved search response`);
    return null;
  }
  console.log(`    resolved page_id=${pageId}`);

  const ads = [];
  let cursor;
  let pages = 0;
  while (ads.length < LIMIT && pages < MAX_PAGES) {
    const qs = new URLSearchParams({ pageId: String(pageId), country: "US", status: "ACTIVE", trim: "false" });
    if (cursor) qs.set("cursor", String(cursor));
    const res = await getJson(`${base}/company/ads?${qs}`, headers);
    pages += 1;
    await save("scrapecreators", `${tslug}-ads-page${pages}.json`, res.json);
    if (res.status !== 200) break;
    const batch = findAds(res.json);
    ads.push(...batch);
    cursor = res.json.cursor ?? findFirst(res.json, /^cursor$/i);
    if (!batch.length || !cursor) break;
  }
  return summarize("scrapecreators", target, pages, ads.slice(0, LIMIT));
}

async function runSearchApi(target) {
  const key = process.env.SEARCHAPI_API_KEY;
  const base = "https://www.searchapi.io/api/v1/search";
  const tslug = slugify(target.name);

  const search = await getJson(
    `${base}?${new URLSearchParams({ engine: "meta_ad_library_page_search", q: target.name, api_key: key })}`,
  );
  await save("searchapi", `${tslug}-page-search.json`, search.json);
  const pageId = findFirst(search.json, /^(page_)?id$/i);
  if (!pageId) {
    console.warn(`    could not extract a page_id — inspect the saved search response`);
    return null;
  }
  console.log(`    resolved page_id=${pageId}`);

  const ads = [];
  let token;
  let pages = 0;
  while (ads.length < LIMIT && pages < MAX_PAGES) {
    const qs = new URLSearchParams({
      engine: "meta_ad_library",
      page_id: String(pageId),
      country: "US",
      active_status: "active",
      api_key: key,
    });
    if (token) qs.set("next_page_token", String(token));
    const res = await getJson(`${base}?${qs}`);
    pages += 1;
    await save("searchapi", `${tslug}-ads-page${pages}.json`, res.json);
    if (res.status !== 200) break;
    const batch = findAds(res.json);
    ads.push(...batch);
    token = findFirst(res.json, /next_page_token/);
    if (!batch.length || !token) break;
  }
  return summarize("searchapi", target, pages, ads.slice(0, LIMIT));
}

async function runApify(target) {
  const token = process.env.APIFY_TOKEN;
  const tslug = slugify(target.name);
  const url = `https://api.apify.com/v2/acts/apify~facebook-ads-scraper/run-sync-get-dataset-items?token=${token}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      startUrls: [{ url: `https://www.facebook.com/${target.slug}` }],
      resultsLimit: LIMIT,
      activeStatus: "active",
    }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _nonJsonBody: text.slice(0, 2000) };
  }
  if (!res.ok) console.warn(`    HTTP ${res.status} from Apify (sync cap is 300s — rerun if 408)`);
  await save("apify", `${tslug}-items.json`, json);
  const ads = findAds(json);
  return summarize("apify", target, 1, ads.slice(0, LIMIT));
}

const vendors = [
  ["scrapecreators", process.env.SCRAPECREATORS_API_KEY, runScrapeCreators],
  ["searchapi", process.env.SEARCHAPI_API_KEY, runSearchApi],
  ["apify", process.env.APIFY_TOKEN, runApify],
];

const configured = vendors.filter(([, key]) => key);
if (!configured.length) {
  console.error(
    "No vendor keys found. Set SCRAPECREATORS_API_KEY / SEARCHAPI_API_KEY / APIFY_TOKEN " +
      "(see docs/research/ad-library-vendors.md §8) and rerun with:\n" +
      "  node --env-file=.env scripts/ad-library-trial.mjs",
  );
  process.exit(1);
}

const summaries = [];
for (const [name, , run] of configured) {
  for (const target of targets) {
    console.log(`\n${name} × ${target.name}`);
    try {
      const s = await run(target);
      if (s) summaries.push(s);
    } catch (err) {
      console.error(`    failed: ${err.message}`);
    }
  }
}

// Cross-vendor archive-id diff per target — the coverage check from §8 step 5.
for (const target of targets) {
  const perVendor = summaries.filter((s) => s.target === target.name);
  if (perVendor.length < 2) continue;
  console.log(`\narchive-id overlap for ${target.name}:`);
  for (const a of perVendor) {
    for (const b of perVendor) {
      if (a.vendor >= b.vendor) continue;
      const setB = new Set(b.archiveIds);
      const shared = a.archiveIds.filter((id) => setB.has(id)).length;
      console.log(
        `  ${a.vendor} (${a.uniqueArchiveIds}) ∩ ${b.vendor} (${b.uniqueArchiveIds}) = ${shared}`,
      );
    }
  }
}

await save("", "summary.json", summaries.map(({ archiveIds, ...rest }) => ({ ...rest })));
console.log("\nDone. Raw responses under docs/research/ad-library-trial/");
