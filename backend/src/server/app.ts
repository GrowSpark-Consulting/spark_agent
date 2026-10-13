import { handleInngest } from "../inngest/serve";
import { toErrorResponse } from "../lib/errors";
import { userClient } from "./auth";
import { allowedOrigins, originAllowed, preflight, withCors } from "./cors";
import { MAX_BODY_BYTES, type FetchHandler } from "./node";
import { ROUTES, type Method, type Route, type RouteDeps, type RouteParams } from "./routes";

export interface AppDeps extends RouteDeps {
  allowedOrigins: ReadonlySet<string>;
}

const notFound = () => Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });

const ANY_METHOD: readonly Method[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const isPattern = (path: string) => path.includes("/:");

function matchPattern(pattern: string, pathname: string): RouteParams | null {
  const want = pattern.split("/");
  const got = pathname.split("/");
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (const [i, segment] of want.entries()) {
    if (!segment.startsWith(":")) {
      if (segment !== got[i]) return null;
      continue;
    }
    if (got[i] === "") return null;
    try {
      params[segment.slice(1)] = decodeURIComponent(got[i]);
    } catch {
      return null; // malformed percent-encoding
    }
  }
  return params;
}

/** The route for a path and its `:name` values. Fixed paths win over patterns. */
export function matchRoute(pathname: string, routes: readonly Route[] = ROUTES): { route: Route; params: RouteParams } | undefined {
  const fixed = routes.find((r) => !isPattern(r.path) && r.path === pathname);
  if (fixed) return { route: fixed, params: {} };
  for (const route of routes) {
    const params = isPattern(route.path) ? matchPattern(route.path, pathname) : null;
    if (params) return { route, params };
  }
  return undefined;
}

/** The body limit for a path, which the HTTP server applies before reading the body. */
export function bodyLimitFor(pathname: string, routes: readonly Route[] = ROUTES): number {
  return matchRoute(pathname, routes)?.route.maxBodyBytes ?? MAX_BODY_BYTES;
}

/** The path as the request log shows it: the route's secret params (a connect-link token) become `***`. */
export function logPathFor(pathname: string, routes: readonly Route[] = ROUTES): string {
  const match = matchRoute(pathname, routes);
  if (!match) {
    // A mangled address (a trailing slash, an extra segment) matches no route and is answered 404, but it is still logged: the segment where a secret would sit is masked too.
    const prefix = routes.find((r) => r.secretParams?.length && r.path.includes("/:") && pathname.startsWith(r.path.slice(0, r.path.indexOf("/:") + 1)));
    if (!prefix) return pathname;
    const head = prefix.path.slice(0, prefix.path.indexOf("/:") + 1);
    const rest = pathname.slice(head.length);
    return rest === "" ? pathname : `${head}***${rest.includes("/") ? rest.slice(rest.indexOf("/")) : ""}`;
  }
  const secret = match.route.secretParams;
  if (!secret?.length) return pathname;
  const pattern = match.route.path.split("/");
  return pathname
    .split("/")
    .map((segment, i) => (pattern[i].startsWith(":") && secret.includes(pattern[i].slice(1)) ? "***" : segment))
    .join("/");
}

function methodNotAllowed(route: Route): Response {
  const allow = [...Object.keys(route.methods), ...(route.browser ? ["OPTIONS"] : [])].join(", ");
  return new Response(null, { status: 405, headers: { allow } });
}

/**
 * The whole API as one fetch-style function: finds the route, answers CORS preflights for browser
 * routes, refuses origins that aren't allowed, and turns anything a route throws into the
 * `{ error: { code, message } }` envelope. `deps` replaces Supabase, Inngest and the origin list in
 * tests; by default they come from serverEnv(). Tests can also pass their own `routes`.
 */
export function createApp(overrides: Partial<AppDeps> = {}, routes: readonly Route[] = ROUTES): FetchHandler {
  const deps: AppDeps = {
    userClient: overrides.userClient ?? userClient,
    inngest: overrides.inngest ?? handleInngest,
    allowedOrigins: overrides.allowedOrigins ?? allowedOrigins(),
  };

  return async function handle(request: Request): Promise<Response> {
    const match = matchRoute(new URL(request.url).pathname, routes);
    if (!match) {
      // The frontend's origins can read a missing route as not_found rather than as a network error: the
      // preflight passes, and the 404 carries CORS headers. Other origins still get neither.
      return request.method === "OPTIONS"
        ? preflight(request, deps.allowedOrigins, ANY_METHOD)
        : withCors(notFound(), request, deps.allowedOrigins);
    }
    const { route, params } = match;

    if (request.method === "OPTIONS" && route.browser) {
      return preflight(request, deps.allowedOrigins, Object.keys(route.methods));
    }
    const handler = route.methods[request.method as Method];
    if (!handler) {
      const notAllowed = methodNotAllowed(route);
      return route.browser ? withCors(notAllowed, request, deps.allowedOrigins) : notAllowed;
    }

    if (route.browser && !originAllowed(request, deps.allowedOrigins)) {
      // The browser would hide the answer anyway; refusing here means the route never runs.
      return Response.json({ error: { code: "forbidden", message: "This site isn't allowed to call the API." } }, { status: 403, headers: { vary: "Origin" } });
    }

    let response: Response;
    try {
      response = await handler(request, deps, params);
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      response = Response.json(body, { status });
    }
    return route.browser ? withCors(response, request, deps.allowedOrigins) : response;
  };
}
