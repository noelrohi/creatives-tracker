#!/usr/bin/env tsx
import { runLaunchpadDryRunSmoke } from "../src/lib/launchpad-dry-run-smoke";

try {
  const summary = runLaunchpadDryRunSmoke(process.argv.slice(2));
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
