import { z } from "zod";
import { getShopifyShopDomain, shopifyGraphql, ShopifyGraphqlError, SHOPIFY_API_VERSION } from "./shopify-admin";

const blockers = {
  configured_store_mismatch: "The server-configured Shopify installation does not match this organization's store.",
  access_denied: "Shopify denied the reporting capability check; reporting access remains unverified.",
  capability_check_timed_out: "Shopify reporting capability check exceeded its five-second deadline.",
  capability_check_failed: "Shopify reporting access could not be verified.",
  missing_read_reports: "The installed Shopify app lacks read_reports. Order access cannot supply sessions.",
  session_semantics_unvalidated: "read_reports is granted, but ShopifyQL access, session counts, population and store-calendar semantics are not validated.",
} as const;

export const conversionAvailabilitySchema = z.object({
  state: z.literal("blocked"),
  blocker: z.enum(Object.keys(blockers) as [keyof typeof blockers, ...(keyof typeof blockers)[]]),
  reason: z.string(),
  numerator: z.null(), denominator: z.null(), rate: z.null(),
  source: z.literal("shopifyql_sessions"),
  apiVersion: z.string(),
  population: z.literal("online_store_sessions_no_additional_bot_filter"),
  dateBasis: z.literal("session_start_day"),
  calendarValidated: z.literal(false),
  readReportsGranted: z.boolean().nullable(),
});

// Installation identity and scope probe only; no ShopifyQL ingestion or order-derived approximation.
// The shared transport reads credentials exclusively from server configuration.
export async function getShopifyConversionAvailability(store: { shopDomain: string }) {
  const blocked = (blocker: keyof typeof blockers, readReportsGranted: boolean | null = null): z.infer<typeof conversionAvailabilitySchema> => ({
    state: "blocked", blocker, reason: blockers[blocker],
    numerator: null, denominator: null, rate: null,
    source: "shopifyql_sessions", apiVersion: SHOPIFY_API_VERSION,
    population: "online_store_sessions_no_additional_bot_filter",
    dateBasis: "session_start_day", calendarValidated: false, readReportsGranted,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const domain = getShopifyShopDomain();
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(domain) || domain.toLowerCase() !== store.shopDomain.toLowerCase()) {
      return blocked("configured_store_mismatch");
    }
    const data = await shopifyGraphql<unknown>(`query ReportingCapability { shop { myshopifyDomain } currentAppInstallation { accessScopes { handle } } }`, undefined, { signal: controller.signal, retry: false });
    const parsed = z.object({
      shop: z.object({ myshopifyDomain: z.string() }),
      currentAppInstallation: z.object({ accessScopes: z.array(z.object({ handle: z.string() })) }),
    }).safeParse(data);
    if (!parsed.success) return blocked("capability_check_failed");
    if (parsed.data.shop.myshopifyDomain.toLowerCase() !== store.shopDomain.toLowerCase()) {
      return blocked("configured_store_mismatch");
    }
    const granted = parsed.data.currentAppInstallation.accessScopes.some(({ handle }) => handle === "read_reports");
    return granted ? blocked("session_semantics_unvalidated", true) : blocked("missing_read_reports", false);
  } catch (error) {
    // Never return/log transport messages, response bodies or credentials.
    if (controller.signal.aborted) return blocked("capability_check_timed_out");
    if (error instanceof ShopifyGraphqlError && error.errors.some(({ extensions }) => extensions?.code === "ACCESS_DENIED")) {
      return blocked("access_denied");
    }
    return blocked("capability_check_failed");
  } finally {
    clearTimeout(timeout);
  }
}
