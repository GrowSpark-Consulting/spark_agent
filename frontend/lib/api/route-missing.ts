import { ApiError } from "@/lib/errors";

/**
 * The route itself isn't on the server the browser talks to (not deployed there yet): a 404 `not_found` or 501 `not_available`
 * on a route that has no "this record doesn't exist" meaning (a list or a summary). Screens say "not available yet" for it, not "error".
 */
export function isRouteMissing(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 501) && err.body.error.code !== "validation_failed";
}
