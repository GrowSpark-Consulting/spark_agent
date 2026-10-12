import { ManualConnectInput, WhatsAppConnectionPublic, type TokenType } from "@pakka/types";
import { z } from "zod";
import { apiFetch } from "@/lib/api/client";
import { apiErrorFrom, formatError } from "@/lib/errors";

// The admin's side of connecting a client's number by hand: POST /api/admin/whatsapp/manual (backend/src/channels/whatsapp/connect,
// docs/whatsapp-connection-contract.md). Platform admins only: the server answers `forbidden` to anyone else, and that is the only
// check that counts; this page cannot tell who is one. The body is the contract's `ManualConnectInput`, with `tenantId` naming the
// business, and it is sent once. The system-user token and the app secret are held only in the form's inputs until that one
// request: this file never stores, logs or returns them, and the answer (which carries none) is the connection as the server saved it.
// The answer's `status` and `last_check` are the server's result of the six checks; nothing here decides that a number is active.

export interface AdminConnectForm {
  tenantId: string;
  wabaId: string;
  phoneNumberId: string;
  tokenType: TokenType;
  token: string;
  appSecret: string;
  displayPhone: string;
  clientBusinessId: string;
}

export const EMPTY_ADMIN_FORM: AdminConnectForm = {
  tenantId: "",
  wabaId: "",
  phoneNumberId: "",
  tokenType: "system_user",
  token: "",
  appSecret: "",
  displayPhone: "",
  clientBusinessId: "",
};

export type AdminFieldErrors = Partial<Record<keyof AdminConnectForm, string>>;

const REQUIRED: { key: "tenantId" | "wabaId" | "phoneNumberId" | "token" | "appSecret"; message: string }[] = [
  { key: "tenantId", message: "Enter the business's ID." },
  { key: "wabaId", message: "Enter the WhatsApp Business Account ID." },
  { key: "phoneNumberId", message: "Enter the phone number ID." },
  { key: "token", message: "Enter the system-user access token." },
  { key: "appSecret", message: "Enter the app secret." },
];

/** What can be checked before anything is sent. The server validates again and decides. */
export function validateAdminForm(form: AdminConnectForm): AdminFieldErrors {
  const errors: AdminFieldErrors = {};
  for (const { key, message } of REQUIRED) if (form[key].trim() === "") errors[key] = message;
  if (!errors.tenantId && !z.guid().safeParse(form.tenantId.trim()).success) errors.tenantId = "That isn't a business ID. It looks like 10000000-0000-0000-0000-000000000004.";
  if (!errors.wabaId && !/^\d+$/.test(form.wabaId.trim())) errors.wabaId = "A WhatsApp Business Account ID is digits only.";
  if (!errors.phoneNumberId && !/^\d+$/.test(form.phoneNumberId.trim())) errors.phoneNumberId = "A phone number ID is digits only.";
  return errors;
}

/** The request body: trimmed, with the two optional fields left out when empty. Parsed with the contract's own schema. */
export function buildAdminBody(form: AdminConnectForm): ManualConnectInput {
  const displayPhone = form.displayPhone.trim();
  const clientBusinessId = form.clientBusinessId.trim();
  return ManualConnectInput.parse({
    tenantId: form.tenantId.trim(),
    wabaId: form.wabaId.trim(),
    phoneNumberId: form.phoneNumberId.trim(),
    token: form.token.trim(),
    tokenType: form.tokenType,
    appSecret: form.appSecret.trim(),
    ...(displayPhone ? { displayPhone } : {}),
    ...(clientBusinessId ? { clientBusinessId } : {}),
  });
}

export type AdminConnectResult =
  | { state: "done"; connection: WhatsAppConnectionPublic }
  | {
      state: "rejected";
      message: string;
      /** The API's per-field messages (validation_failed), keyed by the contract's field names. */
      fields: Record<string, string>;
      code: string;
      /** The form's own secrets were not accepted or not sent: nothing reached Meta. */
      retryable: boolean;
    };

/** POST /api/admin/whatsapp/manual. No business header: the body names the business, and the server decides who may. */
export async function submitAdminConnect(form: AdminConnectForm, signal?: AbortSignal): Promise<AdminConnectResult> {
  let body: ManualConnectInput;
  try {
    body = buildAdminBody(form);
  } catch {
    return { state: "rejected", message: "Check the highlighted fields.", fields: {}, code: "validation_failed", retryable: false };
  }
  try {
    const res = await apiFetch("/api/admin/whatsapp/manual", { method: "POST", body, signal });
    if (!res.ok) {
      const shown = formatError(await apiErrorFrom(res));
      return { state: "rejected", message: shown.message, fields: shown.fields ?? {}, code: shown.code, retryable: shown.retryable };
    }
    const parsed = WhatsAppConnectionPublic.safeParse(await res.json().catch(() => null));
    // Without a valid connection from the API nothing is claimed about its state.
    if (!parsed.success) {
      return {
        state: "rejected",
        message: "The server answered, but not with a connection we can read. Check the business's WhatsApp page before connecting again.",
        fields: {},
        code: "internal",
        retryable: false,
      };
    }
    return { state: "done", connection: parsed.data };
  } catch (err) {
    const shown = formatError(err);
    return { state: "rejected", message: shown.message, fields: {}, code: shown.code, retryable: shown.retryable };
  }
}

/** The fields the API names, mapped onto this form's (the contract's names are the form's). */
export function fieldErrorsFrom(fields: Record<string, string>): AdminFieldErrors {
  const out: AdminFieldErrors = {};
  for (const key of Object.keys(EMPTY_ADMIN_FORM) as (keyof AdminConnectForm)[]) if (fields[key]) out[key] = fields[key];
  return out;
}
