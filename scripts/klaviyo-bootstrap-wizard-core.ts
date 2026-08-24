export const BOOTSTRAP_STAGES = [
  "preflight",
  "shopify_evidence",
  "discovery",
  "probe",
  "review",
  "order_core",
  "matching",
  "claims",
  "journey",
  "consent",
  "dimensions",
  "reports",
  "verification",
] as const;

export type BootstrapStage = (typeof BOOTSTRAP_STAGES)[number];

export type BootstrapContext = {
  organizationId: string;
  storeId: string;
  shopDomain: string;
  storeTimezone: string;
  connectionId: string | null;
};

export type BootstrapSnapshot = Record<string, string | number | boolean | null>;

export type BootstrapProgress = {
  stage: BootstrapStage;
  state: "started" | "completed" | "waiting";
  detail?: string;
};

export type BootstrapWizardAdapters = {
  preflight(): Promise<BootstrapContext>;
  captureSnapshot(context: BootstrapContext): Promise<BootstrapSnapshot>;
  runShopifyEvidence(context: BootstrapContext): Promise<void>;
  runDiscovery(context: BootstrapContext): Promise<BootstrapContext>;
  runProbe(context: BootstrapContext): Promise<void>;
  waitForReview(context: BootstrapContext): Promise<void>;
  runOrderCore(context: BootstrapContext): Promise<void>;
  runMatching(context: BootstrapContext): Promise<void>;
  runClaims(context: BootstrapContext): Promise<void>;
  runJourney(context: BootstrapContext): Promise<void>;
  runConsent(context: BootstrapContext): Promise<void>;
  runDimensions(context: BootstrapContext): Promise<void>;
  runReports(context: BootstrapContext): Promise<void>;
  verify(
    context: BootstrapContext,
    before: BootstrapSnapshot,
  ): Promise<void>;
  progress(update: BootstrapProgress): void;
};

async function stage(
  adapters: BootstrapWizardAdapters,
  name: BootstrapStage,
  action: () => Promise<void>,
) {
  adapters.progress({ stage: name, state: "started" });
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    throw new Error(`Bootstrap stage ${name} failed: ${message}`, {
      cause: error,
    });
  }
  adapters.progress({ stage: name, state: "completed" });
}

/**
 * One sequential, restart-safe production bootstrap. The adapters own durable
 * database/task state; this coordinator only enforces the approved order.
 */
export async function runKlaviyoBootstrapWizard(
  adapters: BootstrapWizardAdapters,
): Promise<BootstrapContext> {
  adapters.progress({ stage: "preflight", state: "started" });
  let context: BootstrapContext;
  try {
    context = await adapters.preflight();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    throw new Error(`Bootstrap stage preflight failed: ${message}`, {
      cause: error,
    });
  }
  adapters.progress({ stage: "preflight", state: "completed" });
  const before = await adapters.captureSnapshot(context);

  await stage(adapters, "shopify_evidence", () =>
    adapters.runShopifyEvidence(context),
  );
  await stage(adapters, "discovery", async () => {
    context = await adapters.runDiscovery(context);
  });
  await stage(adapters, "probe", () => adapters.runProbe(context));
  adapters.progress({
    stage: "review",
    state: "waiting",
    detail: "Approve or reject the probe and every candidate rule in Klaviyo Lab",
  });
  await stage(adapters, "review", () => adapters.waitForReview(context));
  await stage(adapters, "order_core", () => adapters.runOrderCore(context));
  await stage(adapters, "matching", () => adapters.runMatching(context));
  await stage(adapters, "claims", () => adapters.runClaims(context));
  await stage(adapters, "journey", () => adapters.runJourney(context));
  await stage(adapters, "consent", () => adapters.runConsent(context));
  await stage(adapters, "dimensions", () => adapters.runDimensions(context));
  await stage(adapters, "reports", () => adapters.runReports(context));
  await stage(adapters, "verification", () =>
    adapters.verify(context, before),
  );

  return context;
}
