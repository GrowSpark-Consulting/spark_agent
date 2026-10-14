import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AUTO_DEBIT_LIMIT_PAISE,
  chargeMandate,
  commandHash,
  indiaDate,
  newTxnid,
  payuAmount,
  payuConfig,
  PayuError,
  paymentHash,
  paymentRequest,
  preDebit,
  revokeMandate,
  siDetails,
  verifyPayment,
  withGst,
  type FetchLike,
  type PayuConfig,
} from "./payu";

const config: PayuConfig = { key: "testkey", salt: "testsalt", mode: "test" };
const sha512 = (text: string) => createHash("sha512").update(text, "utf8").digest("hex");

/** A fetch that answers `answer` and records what was posted. */
function fakeFetch(answer: unknown, status = 200) {
  const posted: { url: string; body: URLSearchParams }[] = [];
  const impl = vi.fn<FetchLike>(async (url, init) => {
    posted.push({ url, body: new URLSearchParams(init.body) });
    return { ok: status < 400, status, json: async () => answer };
  });
  return { impl, posted };
}

describe("settings and amounts", () => {
  it("is off without both the key and the salt", () => {
    expect(payuConfig({ PAYU_MERCHANT_KEY: undefined, PAYU_MERCHANT_SALT: undefined, PAYU_MODE: "test" })).toBeNull();
    expect(payuConfig({ PAYU_MERCHANT_KEY: "k", PAYU_MERCHANT_SALT: "s", PAYU_MODE: "live" })).toEqual({ key: "k", salt: "s", mode: "live" });
  });

  it("adds 18% GST in paise and writes amounts as PayU expects", () => {
    expect(withGst(5999_00)).toEqual({ basePaise: 5999_00, gstPaise: 1079_82, amountPaise: 7078_82 });
    expect(payuAmount(7078_82)).toBe("7078.82");
    expect(payuAmount(5)).toBe("0.05");
    expect(payuAmount(100)).toBe("1.00");
    expect(() => withGst(1.5)).toThrow();
  });

  it("puts Pro with GST over RBI's auto-debit limit, and Growth under it", () => {
    expect(withGst(12999_00).amountPaise).toBeGreaterThan(AUTO_DEBIT_LIMIT_PAISE);
    expect(withGst(5999_00).amountPaise).toBeLessThan(AUTO_DEBIT_LIMIT_PAISE);
  });

  it("makes txnids PayU accepts (25 letters and digits at most), one letter per kind", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newTxnid("renewal")));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^R[a-z0-9]{1,24}$/);
    expect(newTxnid("topup")).toMatch(/^T/);
  });

  it("dates mandates and debits by the calendar day in India", () => {
    expect(indiaDate(new Date("2026-10-13T20:00:00Z"))).toBe("2026-10-14");
    expect(indiaDate(new Date("2026-10-13T18:00:00Z"))).toBe("2026-10-13");
  });
});

describe("hashes, as PayU documents them", () => {
  const f = { txnid: "S1abc", amount: "2948.82", productinfo: "Spark Agent Starter plan (monthly)", firstname: "Asha", email: "asha@example.com" };

  it("signs a one-time payment: key|txnid|amount|productinfo|firstname|email|udf1..udf5||||||SALT", () => {
    const documented = ["testkey", f.txnid, f.amount, f.productinfo, f.firstname, f.email, "", "", "", "", "", "", "", "", "", "", "testsalt"].join("|");
    expect(paymentHash(config, f)).toBe(sha512(documented));
  });

  it("signs a mandate payment with si_details just before the salt", () => {
    const details = '{"billingAmount":"2948.82"}';
    const documented = ["testkey", f.txnid, f.amount, f.productinfo, f.firstname, f.email, "", "", "", "", "", "", "", "", "", "", details, "testsalt"].join("|");
    expect(paymentHash(config, f, details)).toBe(sha512(documented));
  });

  it("signs an API call as key|command|var1|salt", () => {
    expect(commandHash(config, "verify_payment", "S1abc")).toBe(sha512("testkey|verify_payment|S1abc|testsalt"));
  });
});

describe("paymentRequest", () => {
  const base = {
    txnid: "S1abc",
    amountPaise: 2948_82,
    productinfo: "Spark Agent Starter plan (monthly)",
    firstname: "Asha",
    email: "asha@example.com",
    phone: "+919800000001",
    surl: "https://api.example.com/api/billing/payu/return",
    furl: "https://api.example.com/api/billing/payu/return",
  };
  const mandate = { amountPaise: 2948_82, cycle: "monthly" as const, startDate: "2026-10-13", endDate: "2036-10-13" };

  it("builds a one-time payment for PayU's test checkout", () => {
    const { url, fields } = paymentRequest(config, base);
    expect(url).toBe("https://test.payu.in/_payment");
    expect(fields).toMatchObject({ key: "testkey", txnid: "S1abc", amount: "2948.82", phone: "+919800000001" });
    expect(fields.si).toBeUndefined();
    expect(fields.hash).toBe(paymentHash(config, { txnid: "S1abc", amount: "2948.82", productinfo: base.productinfo, firstname: "Asha", email: base.email }));
  });

  it("approves the auto-debit with the first payment (Pay and Subscribe), hashing the exact si_details it posts", () => {
    const { fields } = paymentRequest(config, { ...base, mandate });
    expect(fields).toMatchObject({ api_version: "7", si: "4" });
    expect(JSON.parse(fields.si_details)).toEqual({
      billingAmount: "2948.82",
      billingCurrency: "INR",
      billingCycle: "MONTHLY",
      billingInterval: 1,
      paymentStartDate: "2026-10-13",
      paymentEndDate: "2036-10-13",
    });
    expect(fields.si_details).toBe(siDetails(mandate));
    expect(fields.hash).toBe(paymentHash(config, { txnid: "S1abc", amount: "2948.82", productinfo: base.productinfo, firstname: "Asha", email: base.email }, fields.si_details));
    expect(fields.enforce_paymethod).toBeUndefined();
  });

  it("offers only cards and net banking for a mandate over the UPI limit (Pro, annual plans)", () => {
    const pro = withGst(12999_00).amountPaise;
    const { fields } = paymentRequest(config, { ...base, amountPaise: pro, mandate: { ...mandate, amountPaise: pro } });
    expect(fields.enforce_paymethod).toBe("creditcard|debitcard|netbanking");
    expect(JSON.parse(paymentRequest(config, { ...base, mandate: { ...mandate, cycle: "yearly" } }).fields.si_details).billingCycle).toBe("YEARLY");
  });

  it("uses PayU's live checkout only in live mode, and refuses a txnid PayU would", () => {
    expect(paymentRequest({ ...config, mode: "live" }, base).url).toBe("https://secure.payu.in/_payment");
    expect(() => paymentRequest(config, { ...base, txnid: "has-dash" })).toThrow();
    expect(() => paymentRequest(config, { ...base, mandate: { ...mandate, endDate: "2026-10-12" } })).toThrow();
  });
});

describe("verifyPayment", () => {
  const success = {
    status: 1,
    msg: "1 out of 1 Transactions Fetched Successfully",
    transaction_details: {
      S1abc: { mihpayid: "25599222315", status: "success", unmappedstatus: "captured", mode: "UPI", amt: "2948.82", transaction_amount: "2948.82", error_Message: "NO ERROR" },
    },
  };

  it("asks PayU, signed with our salt, and reads a paid payment", async () => {
    const { impl, posted } = fakeFetch(success);
    expect(await verifyPayment(config, "S1abc", impl)).toEqual({ state: "success", providerPaymentId: "25599222315", method: "UPI", amountPaise: 2948_82, reason: null });
    expect(posted[0].url).toBe("https://test.payu.in/merchant/postservice.php?form=2");
    expect(Object.fromEntries(posted[0].body)).toEqual({ key: "testkey", command: "verify_payment", var1: "S1abc", hash: sha512("testkey|verify_payment|S1abc|testsalt") });
  });

  it("reads a failure with PayU's reason, a pending payment, and one PayU never saw", async () => {
    const failure = { status: 1, transaction_details: { S1abc: { mihpayid: "1", status: "failure", unmappedstatus: "failed", error_Message: "Bank was unable to authenticate." } } };
    expect(await verifyPayment(config, "S1abc", fakeFetch(failure).impl)).toMatchObject({ state: "failed", reason: "Bank was unable to authenticate." });
    const pending = { status: 1, transaction_details: { S1abc: { mihpayid: "2", status: "pending", unmappedstatus: "pending" } } };
    expect((await verifyPayment(config, "S1abc", fakeFetch(pending).impl)).state).toBe("pending");
    const unknown = { status: 0, msg: "0 out of 1 Transactions Fetched Successfully", transaction_details: { S1abc: { mihpayid: "Not Found", status: "Not Found" } } };
    expect(await verifyPayment(config, "S1abc", fakeFetch(unknown).impl)).toEqual({ state: "not_found", providerPaymentId: null, method: null, amountPaise: null, reason: null });
  });

  it("never reads a refused call as a payment PayU never saw (seen from PayU's test host, 14 Oct)", async () => {
    // A key and salt PayU doesn't accept: no transaction list at all.
    await expect(verifyPayment(config, "S1abc", fakeFetch({ status: 0, msg: "Invalid Hash." }).impl)).rejects.toMatchObject({
      code: "rejected",
      retryable: true,
      message: "PayU verify_payment: Invalid Hash. (check PAYU_MERCHANT_KEY, PAYU_MERCHANT_SALT and PAYU_MODE)",
    });
    await expect(verifyPayment(config, "S1abc", fakeFetch({ status: 0 }).impl)).rejects.toMatchObject({ code: "rejected", message: "PayU verify_payment: refused" });
  });

  it("says when PayU could not be reached, so the caller retries", async () => {
    await expect(verifyPayment(config, "S1abc", fakeFetch({}, 503).impl)).rejects.toMatchObject({ code: "unreachable", retryable: true });
    const down = vi.fn<FetchLike>(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(verifyPayment(config, "S1abc", down)).rejects.toBeInstanceOf(PayuError);
  });
});

describe("renewals: pre-debit notice and charge", () => {
  const notice = { mandateId: "25599222315", requestId: "N1abc", debitDate: "2026-11-13", amountPaise: 2948_82, invoiceDisplayNumber: "R1abc" };

  it("sends the pre-debit notice with PayU's field names", async () => {
    const { impl, posted } = fakeFetch({ status: 1, action: "MANDATE_PRE_DEBIT", message: "Pre-debit notification triggered" });
    await preDebit(config, notice, impl);
    const body = Object.fromEntries(posted[0].body);
    expect(body.command).toBe("pre_debit_SI");
    expect(JSON.parse(body.var1)).toEqual({ authpayuid: "25599222315", requestId: "N1abc", debitDate: "2026-11-13", amount: "2948.82", invoiceDisplayNumber: "R1abc" });
    expect(body.hash).toBe(sha512(`testkey|pre_debit_SI|${body.var1}|testsalt`));
  });

  it("says whether a refused notice is worth retrying", async () => {
    await expect(preDebit(config, notice, fakeFetch({ status: 0, message: "Mandate is not active" }).impl)).rejects.toMatchObject({ code: "rejected", retryable: false });
    await expect(preDebit(config, notice, fakeFetch({ status: 0, message: "Please try again" }).impl)).rejects.toMatchObject({ code: "rejected", retryable: true });
  });

  it("charges the mandate and reads the result for our txnid", async () => {
    const { impl, posted } = fakeFetch({
      status: 1,
      msg: "Transaction Processed successfully",
      details: { R1abc: { transactionid: "R1abc", authpayuid: "25599222315", amount: "2948.82", payuid: "999", mihpayid: "999", status: "captured", field9: "SUCCESS" } },
    });
    const charge = { mandateId: "25599222315", txnid: "R1abc", amountPaise: 2948_82, invoiceDisplayNumber: "R1abc" };
    expect(await chargeMandate(config, charge, impl)).toMatchObject({ state: "success", providerPaymentId: "999" });
    expect(JSON.parse(Object.fromEntries(posted[0].body).var1)).toEqual({ authpayuid: "25599222315", amount: "2948.82", txnid: "R1abc", invoiceDisplayNumber: "R1abc" });

    const pending = { status: 1, details: { R1abc: { status: "pending" } } };
    expect((await chargeMandate(config, charge, fakeFetch(pending).impl)).state).toBe("pending");
    const failed = { status: 1, details: { R1abc: { status: "failed", field9: "Basic authentication check failed" } } };
    expect(await chargeMandate(config, charge, fakeFetch(failed).impl)).toMatchObject({ state: "failed", reason: "Basic authentication check failed" });
    await expect(chargeMandate(config, charge, fakeFetch({ status: 0, msg: "Invalid Hash." }).impl)).rejects.toMatchObject({ code: "rejected" });
  });
});

describe("revokeMandate", () => {
  it("uses UPI's own command, and the shared one for cards and e-NACH", async () => {
    const upi = fakeFetch({ status: 1, action: "MANDATE_REVOKE", message: "Mandate Revoke request processed successfully" });
    expect(await revokeMandate(config, { mandateId: "m-1", method: "upi", requestId: "X1" }, upi.impl)).toBe("revoked");
    expect(Object.fromEntries(upi.posted[0].body)).toMatchObject({ command: "upi_mandate_revoke", var1: JSON.stringify({ authpayuid: "m-1", requestId: "X1" }) });
    const card = fakeFetch({ status: 1, message: "Mandate Revoked Successfully" });
    await revokeMandate(config, { mandateId: "m-2", method: "card", requestId: "X2" }, card.impl);
    expect(card.posted[0].body.get("command")).toBe("mandate_revoke");
  });

  it("counts a mandate that is no longer active as done, and throws anything else", async () => {
    expect(await revokeMandate(config, { mandateId: "m-1", method: "enach", requestId: "X3" }, fakeFetch({ status: 0, message: "Mandate is not active" }).impl)).toBe("already");
    await expect(revokeMandate(config, { mandateId: "m-1", method: "card", requestId: "X4" }, fakeFetch({ status: 0, message: "Try later" }).impl)).rejects.toMatchObject({ code: "rejected" });
  });
});
