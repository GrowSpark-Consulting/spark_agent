import { StartTrialResult, type IndustryKey } from "@pakka/types";
import { apiFetch } from "@/lib/api/client";
import { apiErrorFromBody, formatError } from "@/lib/errors";

// The onboarding Business step: asks the API (POST /api/onboarding/trial) to create the signed-in
// account's trial business. The browser sends the name, the trade it picked and, when the person typed their own WhatsApp number, that
// number (`phone`, E.164): the API answers `phone_used` when that number already had a free trial, before anything is created. The number
// is an early warning only (it is not verified here); the API takes the user from the verified token and maps the trade to its pack.

/** The API's StartTrialResult; a sign-in or network problem becomes a "failed" result with a safe message. */
export async function startTrial(input: { name: string; industry: IndustryKey; phone?: string }): Promise<StartTrialResult> {
  let res: Response;
  try {
    res = await apiFetch("/api/onboarding/trial", { method: "POST", body: input });
  } catch (err) {
    return { status: "failed", message: formatError(err).message };
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // Not JSON (proxy error page): falls through to the generic message.
  }
  const result = StartTrialResult.safeParse(json);
  if (result.success) return result.data;
  // A 401 or another error envelope from the API: its message is written for users.
  return { status: "failed", message: formatError(apiErrorFromBody(res.status, json)).message };
}
