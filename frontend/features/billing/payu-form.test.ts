import { describe, expect, it, vi } from "vitest";
import { PayuFormError, submitPayuForm, type FormHost } from "./payu-form";

// A stand-in for the page's document: records the form that would be posted. (The unit tests run in node; billing.spec.ts posts a real
// form in a browser and checks what the "PayU" page receives.)
function fakeHost() {
  const submitted: { method: string; action: string; fields: Record<string, string> }[] = [];
  const appended: unknown[] = [];
  const host: FormHost = {
    createElement: (tag) => {
      if (tag === "input") return { type: "", name: "", value: "" } as unknown as HTMLInputElement;
      const children: { name: string; value: string }[] = [];
      const form = {
        method: "",
        action: "",
        style: {} as CSSStyleDeclaration,
        appendChild: (c: { name: string; value: string }) => children.push(c),
        submit: vi.fn(() => submitted.push({ method: form.method, action: form.action, fields: Object.fromEntries(children.map((c) => [c.name, c.value])) })),
      };
      return form as unknown as HTMLFormElement;
    },
    body: { appendChild: (n) => appended.push(n) },
  };
  return { host, submitted, appended };
}

const PAYU = { url: "https://test.payu.in/_payment", fields: { key: "merchant", txnid: "t1", hash: "abc", amount: "1414.82" } };

describe("submitPayuForm", () => {
  it("POSTs every field to PayU's url in a form added to the page, once", () => {
    const { host, submitted, appended } = fakeHost();
    submitPayuForm(PAYU, host);
    expect(appended).toHaveLength(1);
    expect(submitted).toEqual([{ method: "POST", action: "https://test.payu.in/_payment", fields: PAYU.fields }]);
  });

  it("refuses an address that is not https, before any form exists", () => {
    for (const url of ["http://test.payu.in/_payment", "javascript:alert(1)", "data:text/html,x", "/relative", "not a url", ""]) {
      const { host, submitted, appended } = fakeHost();
      expect(() => submitPayuForm({ url, fields: PAYU.fields }, host)).toThrow(PayuFormError);
      expect(appended).toHaveLength(0);
      expect(submitted).toHaveLength(0);
    }
  });

  it("refuses a form with no fields", () => {
    const { host, submitted } = fakeHost();
    expect(() => submitPayuForm({ url: PAYU.url, fields: {} }, host)).toThrow(PayuFormError);
    expect(submitted).toHaveLength(0);
  });

  it("keeps the signed fields and the address out of its error", () => {
    const { host } = fakeHost();
    const err = (() => {
      try {
        submitPayuForm({ url: "http://evil.example/x", fields: { hash: "SECRET-HASH" } }, host);
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).not.toContain("SECRET-HASH");
    expect(err?.message).not.toContain("evil.example");
  });
});
