import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: "proj_jwhrvgevdobisolqcicg",
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
  // sharp is a native module: the bundler must not inline it.
  build: { external: ["sharp"] },
});
