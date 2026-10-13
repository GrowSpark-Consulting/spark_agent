import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { serverEnv, type ServerEnv } from "../lib/env";

// PayU India (billing; migration 0035). Server-only: the salt signs every request and never leaves the server.
//
//   * Checkout is PayU's hosted page: the browser POSTs the fields paymentRequest() builds to PayU, and PayU sends the
//     payer back to surl or furl. With a mandate (si=4, "Pay and Subscribe"), that one payment also approves the
//     auto-debit for later cycles (card, UPI Autopay or net-banking e-NACH).
//   * What PayU posts back (to surl, furl or the webhook) is never trusted: the server asks verifyPayment(), which is
//     signed with our salt and goes to PayU directly.
//   * Each renewal: preDebit() at least 48 hours and at most 30 days before the charge (RBI; cards and UPI), then
//     chargeMandate() on the day. A pending charge is confirmed later with verifyPayment().
//
// Formats are PayU's documentation as checked on 13 Oct 2026 (docs.payu.in: payment-consent-transaction-payu-hosted,
// si-parameter-json-details, verify_payment_api, pre_debit_notification_api, recurring_payment_api). UNVERIFIED against
// a real PayU account until the test merchant key arrives.

export interface PayuConfig {
  key: string;
  salt: string;
  mode: "test" | "live";
}

const HOSTS = {
  test: { payment: "https://test.payu.in/_payment", api: "https://test.payu.in/merchant/postservice.php?form=2" },
  live: { payment: "https://secure.payu.in/_payment", api: "https://info.payu.in/merchant/postservice.php?form=2" },
} as const;

/** The PayU settings, or null when billing is not configured (then billing routes answer not_available). */
export function payuConfig(env: Pick<ServerEnv, "PAYU_MERCHANT_KEY" | "PAYU_MERCHANT_SALT" | "PAYU_MODE"> = serverEnv()): PayuConfig | null {
  if (!env.PAYU_MERCHANT_KEY || !env.PAYU_MERCHANT_SALT) return null;
  return { key: env.PAYU_MERCHANT_KEY, salt: env.PAYU_MERCHANT_SALT, mode: env.PAYU_MODE };
}

export class PayuError extends Error {
  constructor(
    public readonly code: "rejected" | "unreachable" | "unexpected",
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PayuError";
  }
}

// Amounts -------------------------------------------------------------------------------------------------------

/** GST on our prices (they are GST-extra), in percent. */
export const GST_PERCENT = 18;
/** RBI: above this, UPI Autopay is not allowed and a card needs the payer's approval for each debit (paise). */
export const AUTO_DEBIT_LIMIT_PAISE = 15_000_00;

export function withGst(basePaise: number): { basePaise: number; gstPaise: number; amountPaise: number } {
  if (!Number.isInteger(basePaise) || basePaise < 0) throw new Error(`withGst: ${basePaise} is not a whole number of paise`);
  const gstPaise = Math.round((basePaise * GST_PERCENT) / 100);
  return { basePaise, gstPaise, amountPaise: basePaise + gstPaise };
}

/** PayU's amount format: rupees with two decimals ("2948.82"). The same string goes into the hash and the form. */
export function payuAmount(paise: number): string {
  if (!Number.isInteger(paise) || paise < 0) throw new Error(`payuAmount: ${paise} is not a whole number of paise`);
  return `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, "0")}`;
}

function paiseOf(amount: unknown): number | null {
  const text = typeof amount === "number" ? amount.toFixed(2) : typeof amount === "string" ? amount.trim() : "";
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [rupees, fraction = ""] = text.split(".");
  return Number(rupees) * 100 + Number(fraction.padEnd(2, "0"));
}

/** A new txnid: PayU allows 25 letters and digits. One letter for the kind, then time and randomness. */
export function newTxnid(kind: "subscribe" | "renewal" | "plan_change" | "topup" | "setup_fee", now = Date.now()): string {
  const letter = { subscribe: "S", renewal: "R", plan_change: "C", topup: "T", setup_fee: "F" }[kind];
  const random = randomBytes(8).toString("hex").slice(0, 12);
  return `${letter}${now.toString(36)}${random}`.slice(0, 25);
}

/** The calendar date in India, "YYYY-MM-DD", as PayU's mandate and pre-debit dates expect. */
export function indiaDate(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

// Hashes --------------------------------------------------------------------------------------------------------

const sha512 = (text: string) => createHash("sha512").update(text, "utf8").digest("hex");

/** sha512(key|command|var1|salt): every postservice API call (verify_payment, pre_debit_SI, si_transaction). */
export function commandHash(config: PayuConfig, command: string, var1: string): string {
  return sha512(`${config.key}|${command}|${var1}|${config.salt}`);
}

interface HashedFields {
  txnid: string;
  amount: string;
  productinfo: string;
  firstname: string;
  email: string;
}

/**
 * The _payment hash: sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT), and with
 * a mandate sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||si_details|SALT). We send
 * no udf fields, so they are empty.
 */
export function paymentHash(config: PayuConfig, f: HashedFields, siDetails?: string): string {
  const head = [config.key, f.txnid, f.amount, f.productinfo, f.firstname, f.email, "", "", "", "", ""].join("|");
  return sha512(siDetails === undefined ? `${head}||||||${config.salt}` : `${head}||||||${siDetails}|${config.salt}`);
}

// Checkout ------------------------------------------------------------------------------------------------------

export interface Mandate {
  /** What each later cycle charges, GST included. */
  amountPaise: number;
  cycle: "monthly" | "yearly";
  /** Today in India: UPI takes no other start date. */
  startDate: string;
  /** The mandate's last date. */
  endDate: string;
}

/** si_details, as one exact JSON string: the hash covers these bytes, so the form must post the same string. */
export function siDetails(m: Mandate): string {
  const date = /^\d{4}-\d{2}-\d{2}$/;
  if (!date.test(m.startDate) || !date.test(m.endDate) || m.endDate <= m.startDate) throw new Error("siDetails: dates must be YYYY-MM-DD, end after start");
  return JSON.stringify({
    billingAmount: payuAmount(m.amountPaise),
    billingCurrency: "INR",
    billingCycle: m.cycle === "yearly" ? "YEARLY" : "MONTHLY",
    billingInterval: 1,
    paymentStartDate: m.startDate,
    paymentEndDate: m.endDate,
  });
}

export interface PaymentRequestInput {
  txnid: string;
  amountPaise: number;
  /** What the payer sees, e.g. "Spark Agent Growth plan (monthly)". */
  productinfo: string;
  firstname: string;
  email: string;
  phone: string;
  /** Where PayU sends the payer back; both reach our server, which then verifies with PayU. */
  surl: string;
  furl: string;
  /** Approve an auto-debit with this payment (Pay and Subscribe). */
  mandate?: Mandate;
}

/** The URL and form fields the browser POSTs to PayU's hosted checkout. */
export function paymentRequest(config: PayuConfig, input: PaymentRequestInput): { url: string; fields: Record<string, string> } {
  if (!/^[A-Za-z0-9]{1,25}$/.test(input.txnid)) throw new Error("paymentRequest: txnid must be 1 to 25 letters and digits");
  const hashed: HashedFields = {
    txnid: input.txnid,
    amount: payuAmount(input.amountPaise),
    productinfo: input.productinfo.slice(0, 100),
    firstname: input.firstname.slice(0, 60),
    email: input.email.slice(0, 50),
  };
  const fields: Record<string, string> = { key: config.key, ...hashed, phone: input.phone.slice(0, 50), surl: input.surl, furl: input.furl };
  if (input.mandate) {
    const details = siDetails(input.mandate);
    Object.assign(fields, { api_version: "7", si: "4", si_details: details, hash: paymentHash(config, hashed, details) });
    // UPI Autopay cannot carry a mandate above the limit, so only cards and net banking are offered then. A card
    // mandate above it asks the payer to approve each debit.
    if (input.mandate.amountPaise > AUTO_DEBIT_LIMIT_PAISE) fields.enforce_paymethod = "creditcard|debitcard|netbanking";
  } else {
    fields.hash = paymentHash(config, hashed);
  }
  return { url: HOSTS[config.mode].payment, fields };
}

// Server-to-server calls ----------------------------------------------------------------------------------------

export type FetchLike = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

async function postService(config: PayuConfig, command: string, var1: string, fetchImpl: FetchLike): Promise<unknown> {
  const body = new URLSearchParams({ key: config.key, command, var1, hash: commandHash(config, command, var1) }).toString();
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(HOSTS[config.mode].api, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new PayuError("unreachable", `PayU ${command}: no answer`, true);
  }
  if (!response.ok) throw new PayuError("unreachable", `PayU ${command}: HTTP ${response.status}`, response.status >= 500 || response.status === 429);
  try {
    return await response.json();
  } catch {
    throw new PayuError("unexpected", `PayU ${command}: the answer was not JSON`, true);
  }
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

export type PaymentState = "success" | "pending" | "failed" | "not_found";

export interface VerifiedPayment {
  state: PaymentState;
  /** PayU's id for the payment (mihpayid); for an approved mandate this is its authpayuid. */
  providerPaymentId: string | null;
  /** PayU's mode: CC, DC, UPI, NB, ... */
  method: string | null;
  amountPaise: number | null;
  /** PayU's reason, for a failure. */
  reason: string | null;
}

const Detail = z.object({
  mihpayid: z.union([z.string(), z.number()]).optional(),
  status: z.string().optional(),
  unmappedstatus: z.string().optional(),
  mode: z.string().nullable().optional(),
  amt: z.union([z.string(), z.number()]).optional(),
  transaction_amount: z.union([z.string(), z.number()]).optional(),
  error_Message: z.string().nullable().optional(),
  field9: z.string().nullable().optional(),
});

/** PayU's status words: success / captured is paid, pending / in progress is not final yet, the rest failed. */
function stateOf(status: string | undefined, unmapped: string | undefined): PaymentState {
  const s = (status ?? "").trim().toLowerCase();
  const u = (unmapped ?? "").trim().toLowerCase();
  if (s === "not found") return "not_found";
  if (s === "success" || s === "captured") return "success";
  if (s === "pending" || s === "in progress" || u === "pending" || u === "initiated" || u === "in progress") return "pending";
  return "failed";
}

function verified(detail: z.infer<typeof Detail>): VerifiedPayment {
  const state = stateOf(detail.status, detail.unmappedstatus);
  const id = detail.mihpayid === undefined ? null : String(detail.mihpayid);
  return {
    state,
    providerPaymentId: state === "not_found" || !id || id.toLowerCase() === "not found" ? null : id,
    method: detail.mode ? detail.mode : null,
    amountPaise: paiseOf(detail.transaction_amount ?? detail.amt),
    reason: state === "failed" ? (detail.error_Message || detail.field9 || "PayU did not say why").slice(0, 300) : null,
  };
}

/** What PayU says happened to one of our payments. The only answer the server acts on. */
export async function verifyPayment(config: PayuConfig, txnid: string, fetchImpl: FetchLike = defaultFetch): Promise<VerifiedPayment> {
  const answer = z
    .object({ status: z.union([z.number(), z.string()]).optional(), transaction_details: z.record(z.string(), Detail).optional() })
    .safeParse(await postService(config, "verify_payment", txnid, fetchImpl));
  if (!answer.success) throw new PayuError("unexpected", "PayU verify_payment: an answer we cannot read", true);
  const detail = answer.data.transaction_details?.[txnid];
  if (!detail) return { state: "not_found", providerPaymentId: null, method: null, amountPaise: null, reason: null };
  return verified(detail);
}

export interface PreDebitInput {
  /** The mandate's authpayuid (subscriptions.mandate_id). */
  mandateId: string;
  /** Ours, unique per notice. */
  requestId: string;
  /** The day the charge will run, in India. */
  debitDate: string;
  amountPaise: number;
  /** Cards: a number unique per invoice, sent again with the charge. */
  invoiceDisplayNumber: string;
}

/** Tells the payer about the next debit (PayU sends the SMS and email). Throws when PayU refuses it. */
export async function preDebit(config: PayuConfig, input: PreDebitInput, fetchImpl: FetchLike = defaultFetch): Promise<void> {
  const var1 = JSON.stringify({
    authpayuid: input.mandateId,
    requestId: input.requestId,
    debitDate: input.debitDate,
    amount: payuAmount(input.amountPaise),
    invoiceDisplayNumber: input.invoiceDisplayNumber,
  });
  const answer = z.object({ status: z.union([z.number(), z.string()]), message: z.string().optional(), msg: z.string().optional() }).safeParse(
    await postService(config, "pre_debit_SI", var1, fetchImpl),
  );
  if (!answer.success) throw new PayuError("unexpected", "PayU pre_debit_SI: an answer we cannot read", true);
  if (String(answer.data.status) !== "1") {
    const text = (answer.data.message ?? answer.data.msg ?? "refused").slice(0, 300);
    // A revoked or inactive mandate will not come back by retrying.
    const final = /revoked|not active|inactive/i.test(text);
    throw new PayuError("rejected", `PayU pre_debit_SI: ${text}`, !final);
  }
}

export interface RevokeInput {
  mandateId: string;
  /** subscriptions.mandate_method: UPI has its own command; cards and e-NACH share one. */
  method: string | null;
  /** Ours, unique per request. */
  requestId: string;
}

/**
 * Cancels a mandate at PayU (a plan replaced by an upgrade). "revoked", or "already" when PayU says it is not active any
 * more; a revoked mandate can never charge again. e-NACH revocations finish at the bank a day or two later.
 */
export async function revokeMandate(config: PayuConfig, input: RevokeInput, fetchImpl: FetchLike = defaultFetch): Promise<"revoked" | "already"> {
  const command = input.method === "upi" ? "upi_mandate_revoke" : "mandate_revoke";
  const var1 = JSON.stringify({ authpayuid: input.mandateId, requestId: input.requestId });
  const answer = z.object({ status: z.union([z.number(), z.string()]), message: z.string().optional(), msg: z.string().optional() }).safeParse(
    await postService(config, command, var1, fetchImpl),
  );
  if (!answer.success) throw new PayuError("unexpected", `PayU ${command}: an answer we cannot read`, true);
  if (String(answer.data.status) === "1") return "revoked";
  const text = (answer.data.message ?? answer.data.msg ?? "refused").slice(0, 300);
  if (/not active|not in appropriate state|already/i.test(text)) return "already";
  throw new PayuError("rejected", `PayU ${command}: ${text}`, true);
}

export interface ChargeInput {
  mandateId: string;
  /** The renewal payment's txnid (payments.txnid). */
  txnid: string;
  amountPaise: number;
  /** The same number the pre-debit notice carried. */
  invoiceDisplayNumber: string;
}

/** Charges a mandate. Pending is normal (UPI, e-NACH): confirm it later with verifyPayment(txnid). */
export async function chargeMandate(config: PayuConfig, input: ChargeInput, fetchImpl: FetchLike = defaultFetch): Promise<VerifiedPayment> {
  const var1 = JSON.stringify({
    authpayuid: input.mandateId,
    amount: payuAmount(input.amountPaise),
    txnid: input.txnid,
    invoiceDisplayNumber: input.invoiceDisplayNumber,
  });
  const answer = z
    .object({ status: z.union([z.number(), z.string()]), msg: z.string().optional(), details: z.record(z.string(), Detail).optional() })
    .safeParse(await postService(config, "si_transaction", var1, fetchImpl));
  if (!answer.success) throw new PayuError("unexpected", "PayU si_transaction: an answer we cannot read", true);
  if (String(answer.data.status) !== "1") throw new PayuError("rejected", `PayU si_transaction: ${(answer.data.msg ?? "refused").slice(0, 300)}`, false);
  const detail = answer.data.details?.[input.txnid];
  // Accepted, but no result for our txnid yet: ask verify_payment later rather than guess.
  if (!detail) return { state: "pending", providerPaymentId: null, method: null, amountPaise: null, reason: null };
  return verified(detail);
}
