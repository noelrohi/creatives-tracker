import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runKlaviyoBootstrapWizard,
  type BootstrapContext,
  type BootstrapProgress,
  type BootstrapSnapshot,
  type BootstrapWizardAdapters,
} from "./klaviyo-bootstrap-wizard-core";

const INTERNAL_FLAG = "--internal-production-run";
const POLL_MS = 10_000;
const REVIEW_POLL_MS = 15_000;
const TASK_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const REVIEW_TIMEOUT_MS = 48 * 60 * 60 * 1000;
const TRIGGER_PROJECT_REF = "proj_dshqpvnbrtxbwidqfqjw";
const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");

type Row = Record<string, unknown>;

function safeMessage(error: unknown) {
  return error instanceof Error ? error.message : "unknown failure";
}

function rows(value: unknown): Row[] {
  if (Array.isArray(value)) return value as Row[];
  if (
    typeof value === "object" &&
    value !== null &&
    "rows" in value &&
    Array.isArray((value as { rows: unknown }).rows)
  ) {
    return (value as { rows: Row[] }).rows;
  }
  return [];
}

function requiredEnvironment(names: readonly string[]) {
  const missing = names.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing production environment variables: ${missing.join(", ")}`);
  }
}

function progress(update: BootstrapProgress) {
  const icon =
    update.state === "completed" ? "✓" : update.state === "waiting" ? "…" : "→";
  const detail = update.detail ? ` — ${update.detail}` : "";
  process.stdout.write(`${icon} ${update.stage}${detail}\n`);
}

async function delay(milliseconds: number) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function spawnAndWait(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit",
  });
  return new Promise<number>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => {
      if (signal) {
        rejectExit(new Error(`${command} exited on signal ${signal}`));
        return;
      }
      resolveExit(code ?? 1);
    });
  });
}

async function poll<T>(input: {
  label: string;
  timeoutMs?: number;
  intervalMs?: number;
  read: () => Promise<T | null>;
}): Promise<T> {
  const deadline = Date.now() + (input.timeoutMs ?? TASK_TIMEOUT_MS);
  for (;;) {
    const value = await input.read();
    if (value !== null) return value;
    if (Date.now() >= deadline) {
      throw new Error(`${input.label} did not reach a terminal state before timeout`);
    }
    await delay(input.intervalMs ?? POLL_MS);
  }
}

function subtractStoreDays(day: string, amount: number) {
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, dayOfMonth - amount))
    .toISOString()
    .slice(0, 10);
}

async function pullTriggerEnvironment(outputPath: string) {
  const args = [
    "trigger.dev@4.5.6",
    "env",
    "pull",
    "--env",
    "prod",
    "--output",
    outputPath,
    "--force",
    "--log-level",
    "error",
  ];
  const exitCode = await spawnAndWait("bunx", args, { cwd: repositoryRoot });
  if (exitCode !== 0) {
    throw new Error("Trigger production environment pull failed");
  }
}

async function createServerOnlyStub(root: string) {
  const packageDirectory = join(root, "node_modules", "server-only");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({ name: "server-only", version: "0.0.0", main: "index.js" }),
    { mode: 0o600 },
  );
  await writeFile(join(packageDirectory, "index.js"), "module.exports = {};\n", {
    mode: 0o600,
  });
  return join(root, "node_modules");
}

async function environmentWithoutPulledKeys(environmentPath: string) {
  const inherited = { ...process.env };
  const contents = await readFile(environmentPath, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (match) delete inherited[match[1]];
  }
  return inherited;
}

async function readProductionTriggerKey() {
  const [apiClientModule, configModule] = await Promise.all([
    import(join(repositoryRoot, "node_modules/trigger.dev/dist/esm/apiClient.js")),
    import(
      join(
        repositoryRoot,
        "node_modules/trigger.dev/dist/esm/utilities/configFiles.js",
      )
    ),
  ]);
  const profile = configModule.readAuthConfigCurrentProfileName();
  const auth = configModule.readAuthConfigProfile(profile);
  if (!auth?.apiUrl || !auth?.accessToken) {
    throw new Error("Trigger CLI is not logged in");
  }
  const client = new apiClientModule.CliApiClient(auth.apiUrl, auth.accessToken);
  const environment = await client.getProjectEnv({
    projectRef: TRIGGER_PROJECT_REF,
    env: "prod",
  });
  if (!environment.success) {
    throw new Error(`Trigger production credential lookup failed: ${environment.error}`);
  }
  if (!environment.data.apiKey.startsWith("tr_prod")) {
    throw new Error("Trigger CLI returned a non-production project key");
  }
  return environment.data.apiKey as string;
}

async function outerMain() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "adsolute-klaviyo-bootstrap-"));
  try {
    const environmentPath = join(temporaryRoot, "trigger-production.env");
    const stubNodePath = await createServerOnlyStub(temporaryRoot);
    process.stdout.write("Pulling Trigger production environment into temporary storage…\n");
    await pullTriggerEnvironment(environmentPath);
    process.stdout.write("Reading the production task credential from the Trigger CLI session…\n");
    const triggerSecretKey = await readProductionTriggerKey();
    const inheritedEnvironment = await environmentWithoutPulledKeys(environmentPath);
    delete inheritedEnvironment.TRIGGER_SECRET_KEY;
    const exitCode = await spawnAndWait(
      process.execPath,
      [
        `--env-file=${environmentPath}`,
        scriptPath,
        INTERNAL_FLAG,
        ...(process.argv.includes("--yes") ? ["--yes"] : []),
      ],
      {
        // Avoid Bun's automatic loading of the repository's local `.env`,
        // which would otherwise shadow the explicit production env file.
        cwd: temporaryRoot,
        env: {
          ...inheritedEnvironment,
          TRIGGER_SECRET_KEY: triggerSecretKey,
          NODE_PATH: [stubNodePath, process.env.NODE_PATH].filter(Boolean).join(":"),
        },
      },
    );
    if (exitCode !== 0) process.exitCode = exitCode;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function confirmProduction() {
  if (process.argv.includes("--yes")) return;
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(
      "This writes evidence to the production database. Type production to continue: ",
    );
    if (answer.trim() !== "production") {
      throw new Error("Production confirmation was not supplied");
    }
  } finally {
    terminal.close();
  }
}

async function buildProductionAdapters(): Promise<BootstrapWizardAdapters> {
  requiredEnvironment([
    "DATABASE_URL",
    "TRIGGER_SECRET_KEY",
    "SHOPIFY_SHOP_DOMAIN",
    "SHOPIFY_ACCESS_TOKEN",
    "KLAVIYO_PRIVATE_API_KEY",
    "KLAVIYO_REVIV_ACCOUNT_ID",
    "KLAVIYO_REVIV_SHOP_DOMAIN",
    "KLAVIYO_REVIV_ALLOWED_URL_HOSTS",
    "IDENTITY_HMAC_SECRET",
    "IDENTITY_HMAC_KEY_VERSION",
    "IDENTITY_ERASURE_HMAC_SECRET",
    "IDENTITY_ERASURE_HMAC_KEY_VERSION",
  ]);
  if (!process.env.TRIGGER_SECRET_KEY!.startsWith("tr_prod")) {
    throw new Error("TRIGGER_SECRET_KEY is not a production key");
  }

  const [
    triggerSdk,
    databaseModule,
    drizzle,
    evidenceStore,
    sourceStore,
    discovery,
    probe,
    sourceRunner,
    matchService,
    claimRepository,
    dimensionRepository,
    reportRepository,
    evidenceSchema,
    klaviyoSchema,
    matchSchema,
    claimSchema,
    shopifyIngest,
    klaviyoTypes,
  ] = await Promise.all([
    import("@trigger.dev/sdk"),
    import("../src/db/index"),
    import("drizzle-orm"),
    import("../src/lib/shopify-evidence-store"),
    import("../src/lib/klaviyo/source-store"),
    import("../src/lib/klaviyo/discovery"),
    import("../src/lib/klaviyo/probe"),
    import("../src/lib/klaviyo/source-runner"),
    import("../src/lib/klaviyo/match-service"),
    import("../src/lib/klaviyo/claim-repository"),
    import("../src/lib/klaviyo/dimension-repository"),
    import("../src/lib/klaviyo/report-repository"),
    import("../src/schema/shopify-evidence"),
    import("../src/schema/klaviyo"),
    import("../src/schema/klaviyo-match"),
    import("../src/schema/klaviyo-claim"),
    import("../src/lib/shopify-ingest"),
    import("../src/lib/klaviyo/types"),
  ]);

  const { db } = databaseModule;
  const { and, desc, eq, isNull, sql } = drizzle;
  let evidenceRunId: string | null = null;
  let sourceRunId: string | null = null;
  let matchRunId: string | null = null;
  let initialWindow: { from: Date; to: Date } | null = null;

  async function triggerTask(
    taskId: string,
    payload: Record<string, unknown>,
    idempotencyKey: string,
  ) {
    const handle = await triggerSdk.tasks.trigger(taskId, payload, {
      idempotencyKey,
      idempotencyKeyTTL: "7d",
    });
    process.stdout.write(`  Trigger run ${handle.id}\n`);
    return handle.id;
  }

  async function readSyncRun(id: string) {
    const [run] = await db
      .select({
        id: klaviyoSchema.klaviyoSyncRuns.id,
        operation: klaviyoSchema.klaviyoSyncRuns.operation,
        status: klaviyoSchema.klaviyoSyncRuns.status,
        checkpoint: klaviyoSchema.klaviyoSyncRuns.checkpoint,
        requestParameters: klaviyoSchema.klaviyoSyncRuns.requestParameters,
      })
      .from(klaviyoSchema.klaviyoSyncRuns)
      .where(eq(klaviyoSchema.klaviyoSyncRuns.id, id))
      .limit(1);
    return run ?? null;
  }

  async function waitForSync(id: string, operation: string) {
    return poll({
      label: `${operation} sync ${id}`,
      read: async () => {
        const run = await readSyncRun(id);
        if (!run || run.status === "running") return null;
        if (run.operation !== operation || run.status !== "success") {
          throw new Error(`${operation} sync ended ${run.status}`);
        }
        return run;
      },
    });
  }

  async function findSuccessfulSourceRun(
    context: BootstrapContext,
    sourceMode: "order_core" | "journey" | "consent",
  ) {
    if (!initialWindow) throw new Error("Initial window is unavailable");
    const [run] = await db
      .select({ id: klaviyoSchema.klaviyoSyncRuns.id })
      .from(klaviyoSchema.klaviyoSyncRuns)
      .where(
        and(
          eq(klaviyoSchema.klaviyoSyncRuns.connectionId, context.connectionId!),
          eq(klaviyoSchema.klaviyoSyncRuns.operation, "events"),
          eq(klaviyoSchema.klaviyoSyncRuns.status, "success"),
          eq(klaviyoSchema.klaviyoSyncRuns.requestedFrom, initialWindow.from),
          eq(klaviyoSchema.klaviyoSyncRuns.requestedTo, initialWindow.to),
          sql`${klaviyoSchema.klaviyoSyncRuns.requestParameters}->>'sourceMode' = ${sourceMode}`,
        ),
      )
      .orderBy(desc(klaviyoSchema.klaviyoSyncRuns.finishedAt))
      .limit(1);
    return run?.id ?? null;
  }

  async function startAndWaitEventRun(
    context: BootstrapContext,
    sourceMode: "order_core" | "journey" | "consent",
  ) {
    const existing = await findSuccessfulSourceRun(context, sourceMode);
    if (existing) return existing;
    if (!initialWindow) throw new Error("Initial window is unavailable");
    const prepared =
      sourceMode === "order_core"
        ? await sourceRunner.startOrResumeOrderCoreSync({
            scope: context as BootstrapContext & { connectionId: string },
            window: initialWindow,
            triggerType: "manual_backfill",
          })
        : sourceMode === "journey"
          ? await sourceRunner.startOrResumeJourneySync({
              scope: context as BootstrapContext & { connectionId: string },
              window: initialWindow,
              triggerType: "manual_backfill",
            })
          : await sourceRunner.startOrResumeConsentSync({
              scope: context as BootstrapContext & { connectionId: string },
              window: initialWindow,
              triggerType: "manual_backfill",
            });
    await triggerTask(
      "klaviyo-order-core-batch",
      { syncRunId: prepared.syncRunId },
      `wizard:${sourceMode}:first:${prepared.syncRunId}`,
    );
    const terminal = await waitForSync(prepared.syncRunId, "events");
    if (terminal.checkpoint !== null) {
      throw new Error(`${sourceMode} completed with a nonterminal checkpoint`);
    }
    return prepared.syncRunId;
  }

  async function snapshot(context: BootstrapContext): Promise<BootstrapSnapshot> {
    const result = await db.execute(sql`
      select
        count(*)::int as order_count,
        coalesce(sum(net_sales), 0)::text as net_sales,
        coalesce((select sum(amount) from shopify_refund where store_id = ${context.storeId}), 0)::text as refunds,
        md5(coalesce(string_agg(
          concat_ws('|', id, coalesce(bucket::text, ''), coalesce(bucket_rule_version::text, ''),
            meta_verified::text, coalesce(meta_campaign_id, ''), coalesce(meta_ad_set_id, ''),
            coalesce(meta_ad_id, ''), coalesce(meta_ad_match_method::text, ''), updated_at::text),
          '||' order by id), '')) as production_fingerprint
      from shopify_order
      where store_id = ${context.storeId}
    `);
    const row = rows(result)[0];
    if (!row) throw new Error("Could not capture Shopify reconciliation snapshot");
    return {
      orderCount: Number(row.order_count),
      netSales: String(row.net_sales),
      refunds: String(row.refunds),
      productionFingerprint: String(row.production_fingerprint),
    };
  }

  return {
    progress,

    async preflight() {
      const migrationResult = await db.execute(sql`
        select coalesce(max(created_at), 0)::text as latest
        from drizzle.__drizzle_migrations
      `);
      // 1786501076739 is 0058_klaviyo_claims_reporting, the last migration
      // the Klaviyo pilot schema needs; later migrations are fine.
      const latest = Number(rows(migrationResult)[0]?.latest ?? "0");
      if (!Number.isFinite(latest) || latest < 1786501076739) {
        throw new Error("Production migrations through 0058 are not applied");
      }
      const store = await evidenceStore.resolveConfiguredEvidenceStore(
        process.env.SHOPIFY_SHOP_DOMAIN!,
      );
      if (
        store.shopDomain.toLowerCase() !==
        process.env.KLAVIYO_REVIV_SHOP_DOMAIN!.trim().toLowerCase()
      ) {
        throw new Error("Shopify and Klaviyo configured shop domains differ");
      }
      const today = shopifyIngest.deriveDayInTimezone(new Date(), store.ianaTimezone);
      initialWindow = klaviyoTypes.inclusiveStoreDaysToHalfOpenUtc({
        dateFrom: subtractStoreDays(today, 89),
        dateTo: today,
        timeZone: store.ianaTimezone,
      });
      const connection = await sourceStore.getPilotConnectionForOrganization(
        store.organizationId,
      );
      process.stdout.write(
        `Production target: ${store.shopDomain} · ${store.ianaTimezone} · ${today}\n`,
      );
      return {
        organizationId: store.organizationId,
        storeId: store.id,
        shopDomain: store.shopDomain,
        storeTimezone: store.ianaTimezone,
        connectionId: connection?.connectionId ?? null,
      };
    },

    captureSnapshot: snapshot,

    async runShopifyEvidence(context) {
      const [existing] = await db
        .select({
          id: evidenceSchema.shopifyEvidenceSyncRuns.id,
          status: evidenceSchema.shopifyEvidenceSyncRuns.status,
          lineCompleteness: evidenceSchema.shopifyEvidenceSyncRuns.lineCompleteness,
        })
        .from(evidenceSchema.shopifyEvidenceSyncRuns)
        .where(
          and(
            eq(evidenceSchema.shopifyEvidenceSyncRuns.organizationId, context.organizationId),
            eq(evidenceSchema.shopifyEvidenceSyncRuns.storeId, context.storeId),
            eq(evidenceSchema.shopifyEvidenceSyncRuns.mode, "initial_90d"),
          ),
        )
        .orderBy(desc(evidenceSchema.shopifyEvidenceSyncRuns.startedAt))
        .limit(1);
      if (
        existing &&
        ((existing.status === "success" && existing.lineCompleteness === "complete") ||
          (existing.status === "partial" && existing.lineCompleteness === "partial"))
      ) {
        evidenceRunId = existing.id;
        return;
      }
      // The key must vary per invocation: a fixed key dedupes a retry to the
      // previous failed run for the whole 7-day TTL and bricks the stage.
      // Reuse of good runs happens above via the database check, and the
      // one-running-per-store unique index blocks concurrent evidence runs.
      const triggerRunId = await triggerTask(
        "shopify-evidence-start",
        { mode: "initial_90d" },
        `wizard:shopify-evidence:${context.storeId}:initial_90d:${crypto.randomUUID()}`,
      );
      const run = await poll({
        label: "Shopify evidence",
        read: async () => {
          const started = await evidenceStore.loadEvidenceRunByStartTriggerId(triggerRunId);
          if (!started) return null;
          const current = await evidenceStore.loadShopifyEvidenceRun(started.id);
          if (!current || current.status === "running") return null;
          return current;
        },
      });
      if (
        !(
          (run.status === "success" && run.lineCompleteness === "complete") ||
          (run.status === "partial" && run.lineCompleteness === "partial")
        )
      ) {
        throw new Error(`Shopify evidence ended ${run.status}:${run.lineCompleteness}`);
      }
      evidenceRunId = run.id;
    },

    async runDiscovery(context) {
      let connection = context.connectionId
        ? await sourceStore.getConnectionRecord(
            context as BootstrapContext & { connectionId: string },
          )
        : null;
      if (!connection) {
        connection = await sourceStore.ensurePilotConnection(context.organizationId);
      }
      const nextContext = { ...context, connectionId: connection.connectionId };
      if (connection.klaviyoAccountId === null) {
        const prepared = await discovery.prepareKlaviyoDiscoveryRun({
          scope: nextContext,
          triggerType: "wizard",
          now: new Date(),
        });
        await triggerTask(
          "klaviyo-discovery",
          { syncRunId: prepared.syncRunId },
          `wizard:discovery:${prepared.syncRunId}`,
        );
        await waitForSync(prepared.syncRunId, "discovery");
      }
      return nextContext;
    },

    async runProbe(context) {
      const review = await sourceStore.listKlaviyoProbeReview({
        scope: context as BootstrapContext & { connectionId: string },
      });
      if (review.reports.length > 0) return;
      const prepared = await probe.prepareKlaviyoProbeRun({
        scope: context as BootstrapContext & { connectionId: string },
        sampleSize: 30,
        triggerType: "wizard",
      });
      await triggerTask(
        "klaviyo-probe",
        { syncRunId: prepared.syncRunId },
        `wizard:probe:${prepared.syncRunId}`,
      );
      await waitForSync(prepared.syncRunId, "probe");
    },

    async waitForReview(context) {
      const appUrl = process.env.ADSOLUTE_API_URL?.replace(/\/$/, "");
      process.stdout.write(
        `  Review: ${appUrl ? `${appUrl}/attribution/klaviyo?view=probe` : "/attribution/klaviyo?view=probe"}\n`,
      );
      await poll({
        label: "Probe review",
        timeoutMs: REVIEW_TIMEOUT_MS,
        intervalMs: REVIEW_POLL_MS,
        read: async () => {
          const review = await sourceStore.listKlaviyoProbeReview({
            scope: context as BootstrapContext & { connectionId: string },
          });
          const report = review.reports[0];
          if (!report || report.status === "pending") return null;
          if (report.status !== "passed") throw new Error("Probe was rejected");
          const rules = review.rules.filter((rule) => rule.probeReportId === report.id);
          if (rules.some((rule) => rule.state === "candidate")) return null;
          const approved = rules.filter((rule) => rule.state === "approved");
          if (approved.length === 0) {
            throw new Error("Probe has no approved deterministic join rule");
          }
          if (approved.some((rule) => rule.observedCollisions !== 0)) {
            throw new Error("An approved join rule has observed collisions");
          }
          return true;
        },
      });
    },

    async runOrderCore(context) {
      sourceRunId = await startAndWaitEventRun(context, "order_core");
      const run = await readSyncRun(sourceRunId);
      const parameters = run?.requestParameters as
        | { sourceMode?: string; metricKinds?: string[] }
        | undefined;
      if (
        parameters?.sourceMode !== "order_core" ||
        JSON.stringify(parameters.metricKinds) !==
          JSON.stringify(["placed_order", "ordered_product"])
      ) {
        throw new Error("Order-core run parameters are not canonical");
      }
    },

    async runMatching(context) {
      if (!sourceRunId || !evidenceRunId) throw new Error("Match inputs are unavailable");
      const inputs = await matchService.selectLatestMatchInputs(
        context as BootstrapContext & { connectionId: string },
      );
      if (
        inputs.sourceRunId !== sourceRunId ||
        inputs.shopifyEvidenceRunId !== evidenceRunId
      ) {
        throw new Error("Latest match inputs differ from the bootstrap source pair");
      }
      const [published] = await db
        .select({ id: matchSchema.klaviyoMatchRuns.id })
        .from(matchSchema.klaviyoMatchRuns)
        .where(
          and(
            eq(matchSchema.klaviyoMatchRuns.connectionId, context.connectionId!),
            eq(matchSchema.klaviyoMatchRuns.invocationFingerprint, inputs.invocationFingerprint),
            eq(matchSchema.klaviyoMatchRuns.status, "published"),
            isNull(matchSchema.klaviyoMatchRuns.supersededAt),
          ),
        )
        .limit(1);
      if (published) {
        matchRunId = published.id;
        return;
      }
      const triggerRunId = await triggerTask(
        "klaviyo-match",
        {
          invocationFingerprint: inputs.invocationFingerprint,
          connectionId: context.connectionId!,
          sourceRunId,
          shopifyEvidenceRunId: evidenceRunId,
          from: inputs.window.from.toISOString(),
          to: inputs.window.to.toISOString(),
          reason: "manual",
        },
        `wizard:match:${inputs.invocationFingerprint}`,
      );
      const terminal = await poll({
        label: `Match run ${triggerRunId}`,
        read: async () => {
          const [run] = await db
            .select({ id: matchSchema.klaviyoMatchRuns.id, status: matchSchema.klaviyoMatchRuns.status })
            .from(matchSchema.klaviyoMatchRuns)
            .where(
              and(
                eq(matchSchema.klaviyoMatchRuns.connectionId, context.connectionId!),
                eq(matchSchema.klaviyoMatchRuns.invocationFingerprint, inputs.invocationFingerprint),
              ),
            )
            .orderBy(desc(matchSchema.klaviyoMatchRuns.startedAt))
            .limit(1);
          if (!run) return null;
          if (run.status !== "published") throw new Error(`Match ended ${run.status}`);
          return run;
        },
      });
      matchRunId = terminal.id;
    },

    async runClaims(context) {
      if (!sourceRunId || !matchRunId) throw new Error("Claim inputs are unavailable");
      const [existing] = await db
        .select({ id: claimSchema.klaviyoClaimReplayRuns.id })
        .from(claimSchema.klaviyoClaimReplayRuns)
        .where(
          and(
            eq(claimSchema.klaviyoClaimReplayRuns.connectionId, context.connectionId!),
            eq(claimSchema.klaviyoClaimReplayRuns.sourceRunId, sourceRunId),
            eq(claimSchema.klaviyoClaimReplayRuns.matchRunId, matchRunId),
            eq(claimSchema.klaviyoClaimReplayRuns.status, "success"),
          ),
        )
        .limit(1);
      if (existing) return;
      const prepared = await claimRepository.startOrResumeClaimReplay({
        scope: context as BootstrapContext & { connectionId: string },
        sourceRunId,
        matchRunId,
        now: new Date(),
      });
      if (prepared.kind === "no_work") return;
      if (prepared.kind !== "started" && prepared.kind !== "pending") {
        throw new Error(`Claim replay could not start: ${prepared.kind}`);
      }
      await triggerTask(
        "klaviyo-claims",
        { claimReplayId: prepared.claimReplayId },
        `wizard:claims:first:${prepared.claimReplayId}`,
      );
      await poll({
        label: `Claim replay ${prepared.claimReplayId}`,
        read: async () => {
          const [run] = await db
            .select({ status: claimSchema.klaviyoClaimReplayRuns.status })
            .from(claimSchema.klaviyoClaimReplayRuns)
            .where(eq(claimSchema.klaviyoClaimReplayRuns.id, prepared.claimReplayId))
            .limit(1);
          if (!run || run.status === "running") return null;
          if (run.status !== "success" && run.status !== "partial") {
            throw new Error(`Claim replay ended ${run.status}`);
          }
          return run;
        },
      });
    },

    async runJourney(context) {
      await startAndWaitEventRun(context, "journey");
    },

    async runConsent(context) {
      await startAndWaitEventRun(context, "consent");
    },

    async runDimensions(context) {
      const [existing] = await db
        .select({ id: klaviyoSchema.klaviyoSyncRuns.id })
        .from(klaviyoSchema.klaviyoSyncRuns)
        .where(
          and(
            eq(klaviyoSchema.klaviyoSyncRuns.connectionId, context.connectionId!),
            eq(klaviyoSchema.klaviyoSyncRuns.operation, "dimensions"),
            eq(klaviyoSchema.klaviyoSyncRuns.status, "success"),
          ),
        )
        .limit(1);
      if (existing) return;
      const prepared = await dimensionRepository.startOrResumeDimensionSync({
        scope: context as BootstrapContext & { connectionId: string },
        triggerType: "wizard",
        now: new Date(),
      });
      await triggerTask(
        "klaviyo-dimensions",
        { syncRunId: prepared.syncRunId },
        `wizard:dimensions:first:${prepared.syncRunId}`,
      );
      await waitForSync(prepared.syncRunId, "dimensions");
    },

    async runReports(context) {
      if (!initialWindow) throw new Error("Initial report window is unavailable");
      const existing = await db.execute(sql`
        select count(distinct kind)::int as count
        from klaviyo_report_generation
        where connection_id = ${context.connectionId}
          and requested_from = ${initialWindow.from}
          and requested_to = ${initialWindow.to}
          and status = 'current'
          and superseded_at is null
          and kind in ('campaign', 'flow')
      `);
      if (Number(rows(existing)[0]?.count ?? 0) === 2) return;
      const prepared = await reportRepository.startOrResumeReportSync({
        scope: context as BootstrapContext & { connectionId: string },
        window: initialWindow,
        kinds: ["campaign", "flow"],
        reason: "manual",
        now: new Date(),
      });
      if (prepared.kind === "fresh") return;
      await triggerTask(
        "klaviyo-reports",
        { syncRunId: prepared.syncRunId },
        `wizard:reports:first:${prepared.syncRunId}`,
      );
      await waitForSync(prepared.syncRunId, "reports");
    },

    async verify(context, before) {
      const after = await snapshot(context);
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        throw new Error("Shopify monetary/attribution reconciliation changed");
      }
      const summaryResult = await db.execute(sql`
        select
          (select count(*)::int from shopify_order_line where store_id = ${context.storeId}) as order_lines,
          (select count(*)::int from klaviyo_event where connection_id = ${context.connectionId}) as events,
          (select count(*)::int from klaviyo_order_match_result where connection_id = ${context.connectionId} and superseded_at is null) as current_orders,
          (select count(*)::int from klaviyo_attribution_claim where connection_id = ${context.connectionId}) as claims,
          (select count(*)::int from klaviyo_report_fact where connection_id = ${context.connectionId}) as report_facts,
          (select count(*)::int from klaviyo_event where connection_id = ${context.connectionId} and redacted_properties::text ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}') as email_leaks
      `);
      const summary = rows(summaryResult)[0];
      if (!summary) throw new Error("Final bootstrap summary is unavailable");
      if (Number(summary.email_leaks) !== 0) {
        throw new Error("Privacy sweep found an email-shaped event value");
      }
      process.stdout.write(
        `Complete: ${summary.order_lines} lines · ${summary.events} events · ${summary.current_orders} current order results · ${summary.claims} claims · ${summary.report_facts} report facts\n`,
      );
    },
  };
}

async function internalMain() {
  const adapters = await buildProductionAdapters();
  await confirmProduction();
  await runKlaviyoBootstrapWizard(adapters);
}

try {
  if (process.argv.includes(INTERNAL_FLAG)) {
    await internalMain();
  } else {
    await outerMain();
  }
} catch (error) {
  process.stderr.write(`Klaviyo bootstrap stopped: ${safeMessage(error)}\n`);
  process.exitCode = 1;
}
