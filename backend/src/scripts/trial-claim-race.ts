import { createHash, randomInt, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { claimTrialPhone } from "../billing/trial-phone";
import { demoDb } from "../channels/whatsapp/demo/db";
import { routeDemoMessage, type DemoDecision } from "../channels/whatsapp/demo/route";

// A concurrency check of the trial-phone claim (Day 6): messages from one phone that carry TRIAL codes at the same moment. It runs the REAL calls in
// parallel (Dev 2's claim_trial_phone from migration 0033, and Dev 1's routing on top of it) against the LOCAL Supabase stack, many rounds, and checks that
// the claim never records two phones for one trial or two trials for one phone, that exactly the right answers come back, and that every message is counted
// once. pgTAP cannot show this: it runs one session in one transaction.
//
//   pnpm db:start && pnpm db:reset
//   RACE_SUPABASE_URL=http://127.0.0.1:54321 RACE_SERVICE_ROLE_KEY=<the local stack's service_role key> pnpm --filter @pakka/backend exec tsx src/scripts/trial-claim-race.ts
//
// Local only: it refuses any address that is not 127.0.0.1 or localhost, it does not read .env.local, and it deletes everything it creates.

const ROUNDS = Number(process.env.RACE_ROUNDS ?? 25);
const url = process.env.RACE_SUPABASE_URL ?? "";
const key = process.env.RACE_SERVICE_ROLE_KEY ?? "";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(url) || key === "") {
  console.error("Refusing to run: RACE_SUPABASE_URL must be the local stack (http://127.0.0.1:<port>) and RACE_SERVICE_ROLE_KEY its service_role key.");
  process.exit(2);
}
const db: SupabaseClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const randomCode = () => `TRIAL-${Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("")}`;
const randomPhone = () => `+9199${String(randomInt(0, 100_000_000)).padStart(8, "0")}`;
const phoneHash = (phone: string) => createHash("sha256").update(phone.replace(/\D/g, ""), "utf8").digest("hex");

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) failures.push(what);
};
const must = <T>(result: { data: T; error: { message: string } | null }, what: string): T => {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  return result.data;
};

type Trial = { id: string; code: string };
async function newTrial(): Promise<Trial> {
  const id = randomUUID();
  must(await db.from("tenants").insert({ id, name: `Race trial ${id.slice(0, 8)}`, vertical: "race-pack", status: "trial" }), "tenant");
  // A code is four characters from 31: retry the rare collision.
  for (let i = 0; i < 20; i++) {
    const code = randomCode();
    const { error } = await db.from("route_codes").insert({ code, kind: "trial", tenant_id: id });
    if (!error) return { id, code };
  }
  throw new Error("no free trial code");
}

const created: { tenants: string[]; phones: string[] } = { tenants: [], phones: [] };
async function trial(): Promise<Trial> {
  const t = await newTrial();
  created.tenants.push(t.id);
  return t;
}
const phone = () => {
  const p = randomPhone();
  created.phones.push(p);
  return p;
};

const deps = demoDb(db);
const route = (from: string, text: string, wamid = `wamid.race.${randomUUID()}`): Promise<DemoDecision> =>
  routeDemoMessage({ from, providerMsgId: wamid, channelId: randomUUID(), deskTenantId: randomUUID(), text }, deps);

const claimedRows = async (hash: string) => (must(await db.from("trial_phones").select("tenant_id").eq("phone_hash", hash), "trial_phones") ?? []).length;
const claimedRowsOfTrial = async (tenantId: string) => (must(await db.from("trial_phones").select("phone_hash").eq("tenant_id", tenantId), "trial_phones") ?? []).length;
const visitor = async (p: string) => must(await db.from("demo_visitors").select("msg_count, recent_ids, tenant_id").eq("phone", p).maybeSingle(), "demo_visitors");
const sorted = (values: string[]) => [...values].sort();

const tally: Record<string, Record<string, number>> = {};
const seen = (scenario: string, outcome: string) => {
  tally[scenario] = tally[scenario] ?? {};
  tally[scenario][outcome] = (tally[scenario][outcome] ?? 0) + 1;
};

async function round(): Promise<void> {
  // 1. The raw function, two different trials, one phone, at the same moment: exactly one claims it, the other is refused.
  {
    const [a, b, p] = [await trial(), await trial(), phone()];
    const answers = await Promise.all([claimTrialPhone(a.id, p, db), claimTrialPhone(b.id, p, db)]);
    seen("raw: two trials, one phone", sorted(answers).join("+"));
    check(sorted(answers).join("+") === "claimed+taken", `raw two trials: expected claimed+taken, got ${answers.join("+")}`);
    check((await claimedRows(phoneHash(p))) === 1, "raw two trials: not exactly one claim for the phone");
    check((await claimedRowsOfTrial(a.id)) + (await claimedRowsOfTrial(b.id)) === 1, "raw two trials: not exactly one trial holds a phone");
  }
  // 2. The same trial twice from one phone: the claim is idempotent, so both are 'claimed' and there is one row.
  {
    const [a, p] = [await trial(), phone()];
    const answers = await Promise.all([claimTrialPhone(a.id, p, db), claimTrialPhone(a.id, p, db)]);
    seen("raw: one trial, one phone twice", sorted(answers).join("+"));
    check(sorted(answers).join("+") === "claimed+claimed", `raw same trial: expected claimed+claimed, got ${answers.join("+")}`);
    check((await claimedRows(phoneHash(p))) === 1, "raw same trial: not exactly one row");
  }
  // 3. One trial, two phones: the first phone is the trial's, the other is someone else trying it.
  {
    const [a, p, q] = [await trial(), phone(), phone()];
    const answers = await Promise.all([claimTrialPhone(a.id, p, db), claimTrialPhone(a.id, q, db)]);
    seen("raw: one trial, two phones", sorted(answers).join("+"));
    check(sorted(answers).join("+") === "claimed+other_sender", `raw two phones: expected claimed+other_sender, got ${answers.join("+")}`);
    check((await claimedRowsOfTrial(a.id)) === 1, "raw two phones: the trial holds more than one phone");
  }

  // 4. Routing, two different trials from one phone at the same moment: one is routed, the other is refused with the trial_taken answer; both counted once.
  {
    const [a, b, p] = [await trial(), await trial(), phone()];
    const decisions = await Promise.all([route(p, `Hi ${a.code}`), route(p, `Hi ${b.code}`)]);
    const stored = decisions.filter((d) => d.action === "store");
    const refused = decisions.filter((d) => d.action === "drop");
    seen("routing: two trials, one phone", `${stored.length} routed, ${refused.length} refused (${refused.map((d) => (d.action === "drop" ? d.reason : "")).join(",")})`);
    check(stored.length === 1 && refused.length === 1, `routing two trials: expected one routed and one refused, got ${stored.length}/${refused.length}`);
    check(refused.every((d) => d.action === "drop" && d.reason === "trial_taken" && d.reply?.kind === "trial_taken"), "routing two trials: the refusal is not trial_taken with its answer");
    check(stored.every((d) => d.action === "store" && (d.tenantId === a.id || d.tenantId === b.id) && d.body === "Hi"), "routing two trials: the routed message is not for one of the two trials with its code taken out");
    check((await claimedRows(phoneHash(p))) === 1, "routing two trials: not exactly one claim for the phone");
    const v = await visitor(p);
    check(v?.msg_count === 2 && v.recent_ids.length === 2, `routing two trials: expected each of the two messages counted once, got ${v?.msg_count}`);
    const winner = stored[0];
    check(winner?.action === "store" && v?.tenant_id === winner.tenantId, "routing two trials: the visitor's route is not the trial that was claimed");
  }
  // 5. Routing, the same trial twice from one phone: both routed, one claim, each counted once.
  {
    const [a, p] = [await trial(), phone()];
    const decisions = await Promise.all([route(p, `Hi ${a.code}`), route(p, `hello again ${a.code}`)]);
    seen("routing: one trial, one phone twice", decisions.map((d) => d.action).sort().join("+"));
    check(decisions.every((d) => d.action === "store" && d.tenantId === a.id), "routing same trial: both messages should be routed to the trial");
    check((await claimedRows(phoneHash(p))) === 1, "routing same trial: not exactly one claim");
    check((await visitor(p))?.msg_count === 2, "routing same trial: each message should be counted once");
  }
  // 6. Routing, one message delivered twice at the same moment (Meta's redelivery): counted once, routed both times (storing is idempotent).
  {
    const [a, p, wamid] = [await trial(), phone(), `wamid.race.${randomUUID()}`];
    const decisions = await Promise.all([route(p, `Hi ${a.code}`, wamid), route(p, `Hi ${a.code}`, wamid)]);
    seen("routing: one message twice", decisions.map((d) => d.action).sort().join("+"));
    check(decisions.every((d) => d.action === "store" && d.tenantId === a.id), "routing redelivery: both deliveries should be routed to the trial");
    check((await claimedRows(phoneHash(p))) === 1, "routing redelivery: not exactly one claim");
    check((await visitor(p))?.msg_count === 1, `routing redelivery: the message should be counted once, got ${(await visitor(p))?.msg_count}`);
  }
}

async function cleanup(): Promise<void> {
  for (const p of created.phones) {
    await db.from("demo_visitors").delete().eq("phone", p);
    await db.from("trial_phones").delete().eq("phone_hash", phoneHash(p));
  }
  if (created.tenants.length > 0) await db.from("tenants").delete().in("id", created.tenants); // route codes go with them
}

async function main(): Promise<void> {
  try {
    for (let i = 0; i < ROUNDS; i++) await round();
  } finally {
    await cleanup();
  }

  console.log(`${ROUNDS} rounds against ${url}`);
  for (const [scenario, outcomes] of Object.entries(tally)) console.log(`  ${scenario}: ${Object.entries(outcomes).map(([outcome, n]) => `${n} x ${outcome}`).join(", ")}`);
  if (failures.length > 0) {
    console.error(`FAILED: ${failures.length} check(s)`);
    for (const f of [...new Set(failures)].slice(0, 20)) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("OK: no double claim, the right answers, every message counted once.");
}

main().catch((error: unknown) => {
  console.error(`The check could not run: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
});
