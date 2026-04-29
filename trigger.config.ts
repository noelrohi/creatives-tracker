import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: "proj_dshqpvnbrtxbwidqfqjw",
  dirs: ["./trigger"],
  runtime: "node",
  logLevel: "info",
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 30000,
      factor: 2,
    },
  },
  maxDuration: 600,
});
