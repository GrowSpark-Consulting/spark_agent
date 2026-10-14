import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { errorKind } from "../lib/errors";

// Node's http server on the outside, Web Request/Response on the inside: every route (and Inngest's
// edge adapter) takes a Request and returns a Response, so routes are tested without a socket.

/**
 * The default body limit: larger bodies are refused before any route runs (413). JSON forms and
 * webhooks are far smaller; a route that takes uploads sets its own `maxBodyBytes`.
 */
export const MAX_BODY_BYTES = 1024 * 1024;

/** A body limit in bytes, fixed or chosen by request path (the API passes its routes' limits). */
export type BodyLimit = number | ((pathname: string) => number);

export type FetchHandler = (request: Request) => Promise<Response>;

export class BodyTooLargeError extends Error {
  /** `request`: the refused request without its body, so its 413 can still get CORS headers. */
  constructor(readonly request?: Request) {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  if (Number(req.headers["content-length"] ?? 0) > limit) throw new BodyTooLargeError();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new BodyTooLargeError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * The request as a Web Request. Behind Railway's proxy the scheme comes from x-forwarded-proto. The
 * path is appended to the origin as text, so a request line like `//evil.example` stays a path. A
 * per-path limit is chosen from the parsed path, the same one the app routes on.
 */
export async function toWebRequest(req: IncomingMessage, maxBodyBytes: BodyLimit = MAX_BODY_BYTES): Promise<Request> {
  const forwarded = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const proto = forwarded === "https" || forwarded === "http" ? forwarded : "http";
  const url = new URL(`${proto}://${req.headers.host ?? "localhost"}${req.url ?? "/"}`);

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = req.method ?? "GET";
  const limit = typeof maxBodyBytes === "function" ? maxBodyBytes(url.pathname) : maxBodyBytes;
  let body: Buffer | undefined;
  try {
    body = method === "GET" || method === "HEAD" ? undefined : await readBody(req, limit);
  } catch (err) {
    throw err instanceof BodyTooLargeError ? new BodyTooLargeError(new Request(url, { method, headers })) : err;
  }
  return new Request(url, { method, headers, body });
}

export async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") res.setHeader(name, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  if (!response.body) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream), res);
}

const errorBody = (code: "validation_failed" | "internal", message: string) => ({ error: { code, message } });

interface ServerOptions {
  maxBodyBytes?: BodyLimit;
  /** Finishes a 413 sent before the app ran (the API adds its CORS headers, so browsers can read it). */
  onRejected?: (request: Request, response: Response) => Response;
  /** How the request log shows a path (the API masks secret path params). The query string is never logged. */
  logPath?: (pathname: string) => string;
  log?: (line: string) => void;
}

// The path the app routes on, parsed the same way as in toWebRequest, so logPath sees what the routes see.
function pathnameOf(req: IncomingMessage): string {
  try {
    return new URL(`http://localhost${req.url ?? "/"}`).pathname;
  } catch {
    return (req.url ?? "/").split("?")[0];
  }
}

async function respond(req: IncomingMessage, handle: FetchHandler, options: Required<ServerOptions>): Promise<Response> {
  let request: Request;
  try {
    request = await toWebRequest(req, options.maxBodyBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      const tooLarge = Response.json(errorBody("validation_failed", "That request is too large."), { status: 413, headers: { connection: "close" } });
      return err.request ? options.onRejected(err.request, tooLarge) : tooLarge;
    }
    // An unparseable Host header or URL.
    return Response.json(errorBody("validation_failed", "Bad request."), { status: 400 });
  }
  try {
    return await handle(request);
  } catch (err) {
    options.log(`[server] unexpected error: ${errorKind(err)}`);
    return Response.json(errorBody("internal", "Something went wrong on our side. Try again in a moment."), { status: 500 });
  }
}

/**
 * An http.Server that runs `handle` for every request and logs one line per request: method, path
 * (never the query string: Meta's verify token travels in it; secret path segments masked by
 * `logPath`), status and time.
 */
export function createHttpServer(handle: FetchHandler, options: ServerOptions = {}): Server {
  const resolved = {
    maxBodyBytes: options.maxBodyBytes ?? MAX_BODY_BYTES,
    onRejected: options.onRejected ?? ((_request: Request, response: Response) => response),
    logPath: options.logPath ?? ((pathname: string) => pathname),
    log: options.log ?? console.log,
  };
  return createServer((req, res) => {
    const started = Date.now();
    const path = resolved.logPath(pathnameOf(req));
    void (async () => {
      const response = await respond(req, handle, resolved);
      await sendWebResponse(res, response);
      resolved.log(`${req.method} ${path} ${response.status} ${Date.now() - started}ms`);
    })().catch(() => {
      // The client went away mid-response; nothing left to answer.
      res.destroy();
    });
  });
}

/**
 * Stops accepting connections, lets requests in flight finish, and after `timeoutMs` closes whatever
 * is still open. Railway sends SIGTERM before replacing a deployment.
 */
export function closeGracefully(server: Server, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve) => {
    const force = setTimeout(() => server.closeAllConnections(), timeoutMs);
    force.unref();
    server.close(() => {
      clearTimeout(force);
      resolve();
    });
    server.closeIdleConnections();
  });
}
