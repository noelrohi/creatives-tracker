/**
 * Seed a Shopify DEVELOPMENT store with paid test orders so the Klaviyo
 * evidence probe has 20-50 evidence-complete orders to sample.
 *
 * Creates 3 products (priced variants), then N paid orders with real
 * variant line items, unique customer emails, and processed_at spread over
 * the past 60 days.
 *
 * Requires the custom app to have these Admin API scopes:
 *   read_orders, write_orders, read_products, write_products
 *
 * Usage:
 *   node scripts/seed-dev-shopify-orders.mjs --yes [count]
 *
 * Reads SHOPIFY_SHOP_DOMAIN and SHOPIFY_ACCESS_TOKEN from .env. Refuses to
 * run without --yes, and refuses any domain not ending in .myshopify.com.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const API_VERSION = "2026-07";

function envFromDotenv(name) {
  if (process.env[name]) return process.env[name];
  try {
    const envFile = readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
    const match = envFile.match(
      new RegExp(`^\\s*${name}\\s*=\\s*"?([^"\\n]+)"?`, "m"),
    );
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

const shopDomain = envFromDotenv("SHOPIFY_SHOP_DOMAIN");
const accessToken = envFromDotenv("SHOPIFY_ACCESS_TOKEN");
const confirmed = process.argv.includes("--yes");
const countArg = process.argv.find((value) => /^\d+$/.test(value));
const orderCount = Math.min(Math.max(Number(countArg ?? 50), 1), 100);

if (!shopDomain || !accessToken) {
  console.error("SHOPIFY_SHOP_DOMAIN and SHOPIFY_ACCESS_TOKEN are required (.env)");
  process.exit(1);
}
if (!shopDomain.endsWith(".myshopify.com")) {
  console.error(`Refusing: ${shopDomain} does not look like a dev store domain`);
  process.exit(1);
}
if (!confirmed) {
  console.error(
    `This will create ${orderCount} paid test orders on ${shopDomain}.\n` +
      "Re-run with --yes to proceed.",
  );
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const THROTTLE_PATTERN = /too many attempts|throttled|exceeded.*rate limit/i;

class ThrottledError extends Error {
  constructor(message) {
    super(message);
    this.name = "ThrottledError";
  }
}

async function graphql(query, variables) {
  const response = await fetch(
    `https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-access-token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    },
  );
  if (response.status === 429) {
    throw new ThrottledError("HTTP 429");
  }
  if (!response.ok) {
    throw new Error(`Shopify GraphQL HTTP ${response.status}`);
  }
  const body = await response.json();
  if (body.errors?.length) {
    const message = JSON.stringify(body.errors);
    if (
      THROTTLE_PATTERN.test(message) ||
      body.errors.some((error) => error.extensions?.code === "THROTTLED")
    ) {
      throw new ThrottledError(message);
    }
    throw new Error(`Shopify GraphQL errors: ${message}`);
  }
  return body.data;
}

function assertNoUserErrors(label, userErrors) {
  if (!userErrors.length) return;
  const message = JSON.stringify(userErrors);
  if (THROTTLE_PATTERN.test(message)) throw new ThrottledError(message);
  throw new Error(`${label}: ${message}`);
}

// Sequential + exponential backoff with jitter; only throttle errors retry.
async function withBackoff(label, work) {
  const maxAttempts = 8;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof ThrottledError) || attempt === maxAttempts - 1) {
        throw error;
      }
      const delay = Math.min(
        2000 * 2 ** attempt + Math.floor(Math.random() * 1000),
        60_000,
      );
      console.log(
        `  throttled on ${label}; waiting ${Math.round(delay / 1000)}s ` +
          `(attempt ${attempt + 1}/${maxAttempts})`,
      );
      await sleep(delay);
    }
  }
}

async function createProduct(title, price, sku) {
  const created = await graphql(
    `mutation ProductCreate($product: ProductCreateInput!) {
       productCreate(product: $product) {
         product {
           id
           variants(first: 1) { nodes { id } }
         }
         userErrors { field message }
       }
     }`,
    { product: { title } },
  );
  assertNoUserErrors("productCreate", created.productCreate.userErrors);
  const product = created.productCreate.product;
  const variantId = product.variants.nodes[0].id;

  const priced = await graphql(
    `mutation VariantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
       productVariantsBulkUpdate(productId: $productId, variants: $variants) {
         userErrors { field message }
       }
     }`,
    {
      productId: product.id,
      variants: [{ id: variantId, price, inventoryItem: { sku } }],
    },
  );
  assertNoUserErrors("variant price", priced.productVariantsBulkUpdate.userErrors);
  return { title, variantId };
}

async function createOrder(index, variants) {
  const lineCount = 1 + (index % 2);
  const lineItems = Array.from({ length: lineCount }, (_, line) => ({
    variantId: variants[(index + line) % variants.length].variantId,
    quantity: 1 + ((index + line) % 3),
  }));
  const daysAgo = index % 60;
  const processedAt = new Date(
    Date.now() - daysAgo * 24 * 60 * 60 * 1000 - (index % 24) * 3600 * 1000,
  ).toISOString();

  const result = await graphql(
    `mutation OrderCreate($order: OrderCreateOrderInput!) {
       orderCreate(order: $order) {
         order { id name }
         userErrors { field message }
       }
     }`,
    {
      order: {
        email: `seed-buyer-${index + 1}@example.com`,
        financialStatus: "PAID",
        processedAt,
        // Not test:true — the ingest pipeline deliberately skips test orders
        // (isTestOrder in shopify-ingest.ts), so seeds must be real orders.
        tags: ["seed-script"],
        lineItems,
      },
    },
  );
  assertNoUserErrors("orderCreate", result.orderCreate.userErrors);
  return result.orderCreate.order.name;
}

async function countExistingSeedOrders() {
  const data = await graphql(
    `query SeedCount($query: String!) {
       ordersCount(query: $query) { count }
     }`,
    // Earlier script versions created test:true seeds the pipeline ignores;
    // count only real seed orders so re-runs top up correctly.
    { query: "tag:seed-script AND -test:true" },
  );
  return data.ordersCount?.count ?? 0;
}

const productSpecs = [
  ["Seed Hoodie", "49.00", "SEED-HOODIE"],
  ["Seed Tee", "24.00", "SEED-TEE"],
  ["Seed Bottle", "18.50", "SEED-BOTTLE"],
];

console.log(`Seeding ${shopDomain}: 3 products + ${orderCount} paid orders`);
const variants = [];
for (const [title, price, sku] of productSpecs) {
  variants.push(
    await withBackoff(`product ${title}`, () => createProduct(title, price, sku)),
  );
  console.log(`  product: ${title}`);
  await sleep(1000);
}

// Resume from previous runs: seed orders carry the seed-script tag.
const existing = await withBackoff("order count", countExistingSeedOrders);
if (existing >= orderCount) {
  console.log(`Already have ${existing} seed orders; nothing to do.`);
  process.exit(0);
}
if (existing > 0) console.log(`  resuming: ${existing} seed orders already exist`);

let created = existing;
for (let index = existing; index < orderCount; index += 1) {
  const name = await withBackoff(`order ${index + 1}`, () =>
    createOrder(index, variants),
  );
  created += 1;
  if (created % 5 === 0 || created === orderCount) {
    console.log(`  orders: ${created}/${orderCount} (latest ${name})`);
  }
  await sleep(2000);
}
console.log("Done. Next: run shopify-backfill, then shopify-evidence-start.");
