import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { errorKind } from "./errors";
import { serverEnv } from "./env";
import { redactForLog } from "./redact";

// Problems sent to Sentry (SENTRY_DSN on the API; off without it), for the Day 8 alert rules on failed jobs, webhook and
// API errors, and connection-health failures (docs/environments.md, "Sentry"). Posted straight to Sentry's envelope
// endpoint, not through its SDK, so nothing is captured automatically: only what a log line may hold is sent (the
// error's kind, its message through redactForLog, code locations, the route pattern, ids). Never a request body, a
// header, a user or a customer's words. Never throws, and gives up after 3 seconds.

export type ReportKind = "api_error" | "job_failed" | "connection_health" | "test";

export interface ReportContext {
  kind: ReportKind;
  level?: "error" | "warning" | "info";
  /** Ids and names only (a function id, a run id, a business id): searchable in Sentry and safe to show. */
  tags?: Record<string, string>;
  /** How Sentry groups the events, e.g. ["job_failed", "process-message"]: one issue per function. */
  fingerprint?: string[];
  /** Makes the event id fixed: the same key reported twice is one event to Sentry (a replayed job, a retried step). */
  eventKey?: string;
}

export interface ReportDeps {
  dsn: string | undefined;
  fetch: typeof fetch;
  now: () => Date;
}

function configuredDsn(): string | undefined {
  try {
    return serverEnv().SENTRY_DSN;
  } catch {
    return undefined;
  }
}

const reportDeps = (): ReportDeps => ({ dsn: configuredDsn(), fetch: globalThis.fetch, now: () => new Date() });

/** The route a request is being answered on, so an error reported anywhere inside it names the route. */
export interface RequestScope {
  route: string;
  method: string;
  /** Set once something inside the request reported an error, so the app does not report the same 500 again. */
  reported: boolean;
}
const requestScope = new AsyncLocalStorage<RequestScope>();
export const inRequestScope = <T>(scope: RequestScope, fn: () => T): T => requestScope.run(scope, fn);

/** https://<key>@<host>[/<prefix>]/<project> → the envelope URL and the key; null when it is not a Sentry DSN. */
export function sentryTarget(dsn: string): { url: string; key: string } | null {
  try {
    const u = new URL(dsn);
    const parts = u.pathname.split("/").filter(Boolean);
    const project = parts.pop();
    if (u.protocol !== "https:" || !u.username || !project || !/^\d+$/.test(project)) return null;
    const prefix = parts.length ? `/${parts.join("/")}` : "";
    return { url: `${u.origin}${prefix}/api/${project}/envelope/`, key: decodeURIComponent(u.username) };
  } catch {
    return null;
  }
}

const FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/;

/** V8's stack lines as Sentry frames (oldest first), code locations only: the message lines are dropped. */
export function stackFrames(stack: string | undefined): { function: string; filename: string; lineno: number; colno: number; in_app: boolean }[] {
  if (!stack) return [];
  const frames = stack
    .split("\n")
    .map((line) => FRAME.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .slice(0, 30)
    .map((m) => {
      const file = m[2].replace(/^file:\/\//, "").replace(/\\/g, "/");
      const short = file.replace(/^.*?((?:backend|packages)\/src\/|node_modules\/)/, "$1");
      return { function: m[1] ?? "?", filename: short, lineno: Number(m[3]), colno: Number(m[4]), in_app: !file.includes("node_modules/") };
    });
  return frames.reverse();
}

const eventIdFor = (key: string | undefined) =>
  key ? createHash("sha256").update(key).digest("hex").slice(0, 32) : randomUUID().replace(/-/g, "");

async function send(event: Record<string, unknown>, deps: ReportDeps): Promise<boolean> {
  const target = deps.dsn ? sentryTarget(deps.dsn) : null;
  if (!target) return false;
  try {
    const body = [JSON.stringify({ event_id: event.event_id, sent_at: deps.now().toISOString() }), JSON.stringify({ type: "event" }), JSON.stringify(event)].join("\n");
    const res = await deps.fetch(target.url, {
      method: "POST",
      headers: {
        "content-type": "application/x-sentry-envelope",
        "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${target.key}, sentry_client=pakka-agent/1.0`,
      },
      body,
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) console.error(`[report] Sentry did not take the event (${res.status})`);
    return res.ok;
  } catch (e) {
    console.error(`[report] the event was not sent to Sentry: ${errorKind(e)}`);
    return false;
  }
}

function baseEvent(context: ReportContext, deps: ReportDeps): Record<string, unknown> {
  const scope = requestScope.getStore();
  const commit = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7);
  return {
    event_id: eventIdFor(context.eventKey),
    timestamp: deps.now().getTime() / 1000,
    platform: "node",
    level: context.level ?? "error",
    logger: "pakka-agent",
    server_name: "api",
    environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? "local",
    ...(commit && { release: commit }),
    tags: { kind: context.kind, ...(scope && { route: scope.route, method: scope.method }), ...context.tags },
    ...(context.fingerprint && { fingerprint: context.fingerprint }),
  };
}

/** Sends an error to Sentry: its kind, its redacted message and where it was thrown. Resolves false when it was not sent. */
export function reportError(err: unknown, context: ReportContext, deps: ReportDeps = reportDeps()): Promise<boolean> {
  const scope = requestScope.getStore();
  if (scope) scope.reported = true;
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "a thrown value";
  const event = {
    ...baseEvent(context, deps),
    exception: {
      values: [
        {
          type: errorKind(err),
          value: redactForLog(message).slice(0, 500),
          ...(err instanceof Error && { stacktrace: { frames: stackFrames(err.stack) } }),
        },
      ],
    },
  };
  return send(event, deps);
}

/** Sends a problem that is not a thrown error (a check that failed, a 500 answered without one): `text` is redacted too. */
export function reportProblem(text: string, context: ReportContext, deps: ReportDeps = reportDeps()): Promise<boolean> {
  return send({ ...baseEvent(context, deps), message: { formatted: redactForLog(text).slice(0, 500) } }, deps);
}
