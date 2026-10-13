import type { PayuCheckout } from "@pakka/types";

// Opens PayU's hosted checkout (docs/contracts.md, "PayU billing"). The API answers { url, fields }; the browser must POST `fields` to
// `url` as a form, because PayU's page takes a form post, not a link. `fields` carry PayU's signed hash, so this file builds the form
// in memory, submits it and never logs, stores or returns them. Whether the payer paid is not known from here: PayU sends them back to
// /dashboard/billing?payment=<id> and payment-poll.ts asks the API.

export class PayuFormError extends Error {
  constructor() {
    // No detail on purpose: the URL and fields are signed payment data.
    super("PayU's checkout details were not usable.");
    this.name = "PayuFormError";
  }
}

/** The parts of `document` the form needs, so a test can stand in for it. */
export interface FormHost {
  createElement(tag: "form" | "input"): HTMLFormElement | HTMLInputElement;
  body: { appendChild(node: Node): unknown };
}

/** Only an https address is a checkout page; anything else (javascript:, http:, a bad URL) is refused before a form is built. */
function checkoutUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return parsed.toString();
  } catch {
    // fall through
  }
  throw new PayuFormError();
}

/** Builds a POST form to PayU with a hidden input per field and submits it. The browser leaves the page. */
export function submitPayuForm(payu: PayuCheckout["payu"], host: FormHost = document): void {
  const action = checkoutUrl(payu.url);
  const entries = Object.entries(payu.fields);
  if (entries.length === 0) throw new PayuFormError();

  const form = host.createElement("form") as HTMLFormElement;
  form.method = "POST";
  form.action = action;
  form.style.display = "none";
  for (const [name, value] of entries) {
    const input = host.createElement("input") as HTMLInputElement;
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  host.body.appendChild(form);
  form.submit();
}
