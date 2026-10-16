import { reportProblem, sentryTarget } from "../lib/report";
import { serverEnv } from "../lib/env";

// Verification CLI for Sentry error reporting (P2 operational readiness).
// Dispatches one benign test event to Sentry and checks if Sentry returns HTTP 200.
async function main() {
  const env = serverEnv();
  const dsn = env.SENTRY_DSN || process.env.SENTRY_DSN;

  if (!dsn) {
    console.error("[sentry-test] SENTRY_DSN is not set in environment.");
    console.log("Usage: SENTRY_DSN=https://<key>@<host>/<project> pnpm exec tsx src/scripts/sentry-test.ts");
    process.exit(1);
  }

  const target = sentryTarget(dsn);
  if (!target) {
    console.error("[sentry-test] SENTRY_DSN has invalid format. Must be https://<key>@<host>/<project>");
    process.exit(1);
  }

  console.log(`[sentry-test] Target URL: ${target.url}`);
  console.log("[sentry-test] Sending benign test envelope to Sentry...");

  const success = await reportProblem("Pakka Agent operational readiness drill — test event", {
    kind: "test",
    level: "info",
    tags: { drill: "p2_readiness", env: env.RAILWAY_ENVIRONMENT_NAME ?? "test" },
    eventKey: `drill:${Date.now()}`,
  });

  if (success) {
    console.log("[sentry-test] SUCCESS: Sentry received and accepted the test envelope (HTTP 200).");
    process.exit(0);
  } else {
    console.error("[sentry-test] FAILED: Sentry envelope dispatch failed or timed out.");
    process.exit(1);
  }
}

void main();
