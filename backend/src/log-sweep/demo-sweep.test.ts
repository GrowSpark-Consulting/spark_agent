import { createHmac } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { routeDemoMessage, type DemoDeps, type DemoMessage } from "../channels/whatsapp/demo/route";
import { replyText, type Lang, type MenuEntry, type ReplyKind } from "../channels/whatsapp/demo/text";
import { handleDemoReply, type DemoReplyDeps } from "../inngest/demo-reply";
import type { SendOutcome } from "../notify/send";
import { captureLogs, describeLeaks, poison, type Fixtures, type LogCapture } from "./detect";

// Day 7, PR B: the log sweep over the shared demo number (Day 6): the routing of a visitor's message by its route code or menu pick, through the REAL webhook
// handler and the REAL routing rules, and the menu, bad-code, daily-limit and used-trial answers sent by the demo-reply job. Every dependency fails with the
// poison in turn. The visitor's number is in the webhook as the sender and, as visitors really do, typed in their message. NOT PROVED: the real demo database
// functions (demo/db.ts, demo_admit), Dev 2's claim_trial_phone, the real notify.send, staging.

const SECRET = "synthetic-meta-app-secret";
const VISITOR = "919812345621";
const DEMO_PNID = "200000000000001";
const WABA = "100000000000001";
const OWNER = "a0000000-0000-4000-8000-00000000000a";
const ROUTED = "b0000000-0000-4000-8000-00000000000b";
const CHANNEL = "ch-demo";
const CANARY = { text: "CANARY-VISITOR-TEXT-6RV", name: "Visitor Canary" };
const FX: Fixtures = { phones: [`+${VISITOR}`], secrets: [SECRET, "synthetic-route-token", "synthetic-service-key"], texts: [CANARY.text, CANARY.name] };
const POISON = poison(FX);
const MENU: MenuEntry[] = [{ code: "DEMO-SALON", label: "Beauty parlour" }, { code: "DEMO-HOMES", label: "Real estate" }];

let capture: LogCapture | undefined;
afterEach(() => {
  capture?.stop();
  capture = undefined;
});

let handle: typeof import("../channels/whatsapp/inbound")["handleWhatsAppWebhook"];
beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "synthetic-anon-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-service-key");
  vi.stubEnv("EMBEDDINGS_API_KEY", "synthetic-embeddings-key");
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-anthropic-key");
  vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "synthetic-route-token");
  vi.stubEnv("META_APP_SECRET", SECRET);
  handle = (await import("../channels/whatsapp/inbound")).handleWhatsAppWebhook;
});

/** `atLeast`: how many log lines the scenario must write (0 for a path that logs nothing: the poison is then shown not to have been printed anywhere). */
async function sweep(run: () => Promise<unknown>, atLeast = 0): Promise<LogCapture> {
  capture = captureLogs();
  try {
    await run();
  } catch {
    // a failure is answered by the route's error envelope or left to Inngest; what matters is what OUR code wrote to the console
  }
  const cap = capture;
  expect(cap.lines().length, "the scenario wrote fewer log lines than it should: the sweep proves nothing").toBeGreaterThanOrEqual(atLeast);
  expect(cap.leaks(FX), `\n${describeLeaks(cap.leaks(FX))}`).toEqual([]);
  return cap;
}

const boom = (): never => {
  throw new Error(POISON);
};

function demoDeps(over: Partial<DemoDeps> = {}): DemoDeps {
  return {
    findRoute: async (code) => (code === "DEMO-SALON" ? { tenantId: ROUTED, kind: "demo" } : code === "TRIAL-ABC" ? { tenantId: ROUTED, kind: "trial" } : null),
    isLive: async () => true,
    claimTrialPhone: async () => "claimed",
    hasRoute: async () => false,
    menu: async () => MENU,
    messageTenant: async () => null,
    admit: async () => ({ allowed: true, replay: false, notifyLimit: false, tenantId: ROUTED }),
    ...over,
  };
}

const message = (text: string | undefined, over: Partial<DemoMessage> = {}): DemoMessage => ({ from: `+${VISITOR}`, providerMsgId: "wamid.DEMO1", channelId: CHANNEL, deskTenantId: OWNER, ...(text === undefined ? {} : { text }), ...over });

const VISITS = [
  `DEMO-SALON ${CANARY.text}`,
  `hi, I want to see the demo, call me on +91 98123 45621 ${CANARY.text}`,
  `1`,
  `Beauty parlour`,
  `TRIAL-ABC ${CANARY.text}`,
  `NOT-A-CODE ${CANARY.text} ${VISITOR}`,
  `வணக்கம் ${CANARY.text}`,
  `vanakkam, demo venum ${CANARY.text}`,
  `STOP`,
  ``,
];

describe("the routing of a visitor's message (the real rules, fake dependencies)", () => {
  it.each(VISITS)("%j", async (text) => void (await sweep(async () => void (await routeDemoMessage(message(text), demoDeps())))));

  it("a message with no text (an image, a voice note)", async () => void (await sweep(async () => void (await routeDemoMessage(message(undefined), demoDeps())))));

  it("the daily limit, with and without the one notice", async () => {
    await sweep(async () => {
      await routeDemoMessage(message(`DEMO-SALON ${CANARY.text}`), demoDeps({ admit: async () => ({ allowed: false, replay: false, notifyLimit: true, tenantId: null }) }));
      await routeDemoMessage(message(`DEMO-SALON ${CANARY.text}`), demoDeps({ admit: async () => ({ allowed: false, replay: false, notifyLimit: false, tenantId: null }) }));
    });
  });

  it("a used trial, a redelivery of a message the front desk holds, a redelivery routed elsewhere", async () => {
    await sweep(async () => {
      await routeDemoMessage(message(`TRIAL-ABC ${CANARY.text}`), demoDeps({ claimTrialPhone: async () => "taken" }));
      await routeDemoMessage(message(`DEMO-SALON ${CANARY.text}`), demoDeps({ admit: async () => ({ allowed: true, replay: true, notifyLimit: false, tenantId: null }), messageTenant: async () => OWNER }));
      await routeDemoMessage(message(`DEMO-SALON ${CANARY.text}`), demoDeps({ admit: async () => ({ allowed: true, replay: true, notifyLimit: false, tenantId: ROUTED }), messageTenant: async () => ROUTED }));
    });
  });

  it.each(["findRoute", "isLive", "claimTrialPhone", "hasRoute", "menu", "messageTenant", "admit"] as const)("%s throws the poison", async (dependency) => {
    await sweep(async () => {
      for (const text of [`DEMO-SALON ${CANARY.text}`, `TRIAL-ABC ${CANARY.text}`, "1"]) {
        await routeDemoMessage(message(text), demoDeps({ [dependency]: boom, admit: dependency === "admit" ? boom : async () => ({ allowed: true, replay: dependency === "messageTenant", notifyLimit: false, tenantId: ROUTED }) })).catch(() => undefined);
      }
    });
  });
});

describe("the demo number in the webhook (the real handler)", () => {
  const sign = (raw: string) => `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
  const body = (text: string, wamid = "wamid.DEMO1") =>
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: WABA, changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "914412345678", phone_number_id: DEMO_PNID }, contacts: [{ profile: { name: CANARY.name }, wa_id: VISITOR }], messages: [{ from: VISITOR, id: wamid, timestamp: "1759743000", type: "text", text: { body: text } }] } }] }],
    });
  const request = (raw: string) => new Request("http://localhost:4000/api/webhooks/whatsapp", { method: "POST", body: raw, headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw) } });

  function deps(over: { route?: DemoDeps; store?: () => never; send?: () => never } = {}) {
    const connection = { id: "c1", tenantId: OWNER, channelId: CHANNEL, phoneNumberId: DEMO_PNID, wabaId: WABA, method: "platform", status: "active" };
    let n = 0;
    return {
      findConnections: async () => [connection],
      findConnectionsByWaba: async () => [connection],
      findByoSecrets: async () => [],
      storeInboundMessage: async () => (over.store ? over.store() : { conversationId: "c0000000-0000-4000-8000-00000000000c", messageId: `a0000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, inserted: true }),
      applyMessageStatus: async () => true,
      templateBelongsToTenant: async () => false,
      setTemplateStatus: async () => false,
      updateConnectionHealth: async () => undefined,
      sendEvent: async () => (over.send ? over.send() : undefined),
      demo: { phoneNumberId: DEMO_PNID, route: (m: DemoMessage) => routeDemoMessage(m, over.route ?? demoDeps()), messageTenant: async () => null },
    } as unknown as Parameters<typeof handle>[1];
  }

  it.each(VISITS)("a visitor writes %j", async (text) => {
    await sweep(async () => void (await handle(request(body(text)), deps())), 1); // the webhook always writes its count line
  });

  it("every routing dependency fails with the poison, in the webhook", async () => {
    await sweep(async () => {
      for (const dependency of ["findRoute", "isLive", "claimTrialPhone", "hasRoute", "menu", "messageTenant", "admit"] as const) {
        await handle(request(body(`DEMO-SALON ${CANARY.text}`)), deps({ route: demoDeps({ [dependency]: boom }) })).catch(() => undefined);
      }
    });
  });

  it("the store and the queue fail with the poison", async () => {
    await sweep(async () => {
      await handle(request(body(`DEMO-SALON ${CANARY.text}`)), deps({ store: boom })).catch(() => undefined);
      await handle(request(body("hello")), deps({ send: boom })).catch(() => undefined);
    });
  });
});

describe("the answers the demo-reply job sends", () => {
  const SENT: SendOutcome = { status: "sent", messageId: "m", providerMsgId: "w", creditsCharged: 0, usedTemplate: false };
  const step = { run: async <T>(_id: string, fn: () => Promise<T>) => JSON.parse(JSON.stringify((await fn()) ?? null)) as T };
  const data = (kind: ReplyKind, lang: Lang) => ({ tenantId: OWNER, conversationId: "c0000000-0000-4000-8000-0000000000c1", messageId: "a0000000-0000-4000-8000-0000000000a1", kind, lang });
  const replyDeps = (send: DemoReplyDeps["send"]): DemoReplyDeps => ({ menu: async () => MENU, appUrl: () => "https://app.example.test", send });

  it.each((["menu", "bad_code", "limit", "trial_taken"] as const).flatMap((kind) => (["en", "ta", "tanglish"] as const).map((lang) => [kind, lang] as const)))("%s in %s: sent", async (kind, lang) => {
    await sweep(async () => void (await handleDemoReply({ event: { data: data(kind, lang) }, step }, replyDeps(async () => SENT))));
  });

  it("the send is skipped, fails for good, fails in a way waiting can fix, or throws the poison", async () => {
    await sweep(async () => {
      const outcomes: SendOutcome[] = [
        { status: "skipped", reason: "outside_window" },
        { status: "failed", error: { code: "whatsapp_not_connected", message: POISON, retryable: false, outcomeUnknown: false } },
        { status: "failed", error: { code: "rate_limited", message: POISON, retryable: true, outcomeUnknown: false } },
        { status: "failed", error: { code: "timeout", message: POISON, retryable: false, outcomeUnknown: true } },
      ];
      for (const outcome of outcomes) await handleDemoReply({ event: { data: data("menu", "en") }, step }, replyDeps(async () => outcome)).catch(() => undefined);
      await handleDemoReply({ event: { data: data("menu", "en") }, step }, replyDeps(async () => boom())).catch(() => undefined);
    });
  });

  it("the menu cannot be read (the read throws the poison), and the event is not valid", async () => {
    await sweep(async () => {
      await handleDemoReply({ event: { data: data("menu", "en") }, step }, { ...replyDeps(async () => SENT), menu: async () => boom() }).catch(() => undefined);
      await handleDemoReply({ event: { data: { nonsense: POISON } }, step }, replyDeps(async () => SENT)).catch(() => undefined);
    });
  });

  it("the text a visitor is sent is built from the menu and the app's address only", () => {
    for (const kind of ["menu", "bad_code", "limit", "trial_taken"] as const) {
      const text = replyText(kind, "en", MENU, "https://app.example.test");
      expect(text).not.toContain(VISITOR);
      expect(text).not.toContain(CANARY.text);
    }
  });
});
