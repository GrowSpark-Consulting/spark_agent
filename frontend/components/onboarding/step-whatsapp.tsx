"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { OwnAppConnect } from "@/components/onboarding/own-app-connect";
import { loadWebhookConfig, resolveWhatsAppTenant, type WebhookConfigResult } from "@/lib/whatsapp/manual-connect";
import {
  CHECKS,
  COEX_OPTIONS,
  MANUAL_MODES,
  PARTNER_COPY,
  WA_METHODS,
  type CheckKind,
  type CopyItem,
} from "@/features/onboarding/data";
import { bizLabel, type OnboardingState, type SetState } from "@/features/onboarding/state";
import {
  CheckRow,
  CopyRow,
  RuleHeading,
  SquareRadio,
  StepIntro,
  type CheckMark,
  type Tone,
} from "@/components/onboarding/primitives";

export function StepWhatsApp({
  s,
  set,
  onOpenPopup,
  onRunChecks,
}: {
  s: OnboardingState;
  set: SetState;
  onOpenPopup: () => void;
  onRunChecks: (kind: CheckKind) => void;
}) {
  const idle = s.wa === "idle";
  const meta = s.waMethod === "meta";
  const kind = s.chkKind;
  const list = CHECKS[kind];

  const copyValue = (label: string, value: string) => {
    try {
      navigator.clipboard?.writeText(value);
    } catch {
      /* clipboard unavailable */
    }
    set({ copied: label });
  };
  const copy = (item: CopyItem) => {
    if (item.value !== null) copyValue(item.label, item.value);
  };

  // The webhook details come from the API (this business's own verify token, the API's public address). Read
  // once the customer opens a manual path, and again on "Try again".
  const manualOpen = idle && !meta;
  const [config, setConfig] = React.useState<WebhookConfigResult | null>(null);
  const [configTry, setConfigTry] = React.useState(0);
  // The business the details above were read for. Both WhatsApp calls name it in X-Pakka-Tenant; it is worked
  // out again on every read (never remembered between reads) and again when the account details are sent.
  const [configTenant, setConfigTenant] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!manualOpen) return;
    const controller = new AbortController();
    (async () => {
      const tenant = await resolveWhatsAppTenant();
      if (controller.signal.aborted) return;
      if (tenant.state !== "ready") {
        // No business, several, signed out: nothing is sent, and the screen says why.
        setConfigTenant(null);
        setConfig(tenant);
        return;
      }
      setConfigTenant(tenant.tenantId);
      setConfig(await loadWebhookConfig(tenant.tenantId, controller.signal));
    })().catch(() => {});
    return () => controller.abort();
  }, [manualOpen, configTry]);
  // Spark Agent's portfolio id for partner access, only when the API has it configured.
  const partnerCopy: CopyItem[] = PARTNER_COPY.map((item) => ({
    ...item,
    value: config?.state === "ready" ? config.config.partnerBusinessId : null,
  }));

  const need2 =
    s.coex === "yes"
      ? "Your phone with the WhatsApp Business app, to scan a QR code"
      : "The business phone, to receive a code";

  const previewNote =
    kind === "meta"
      ? s.coex === "yes"
        ? "With Facebook, keeping the WhatsApp Business app working"
        : "With Facebook"
      : "Through partner access, so you keep ownership";

  // What Meta asks for once a number is really connected. No statuses: nothing has been checked.
  const metaList: { t: string; note: string }[] = [
    {
      t: "Display name “" + bizLabel(s) + "” approved",
      note: "Meta checks it matches your business.",
    },
    {
      t: "Payment method added in Meta",
      note: "Needed before reminders and follow-ups can go out. Add a card in WhatsApp Manager → Payment settings.",
    },
    {
      t: "Message templates approved",
      note: "Your assistant’s templates are sent to Meta for review after you connect.",
    },
  ];

  return (
    <>
      <StepIntro title="Connect your WhatsApp number">
        Keep the number customers already use. Your assistant replies from it
        once it’s connected.
      </StepIntro>

      {!(idle && !meta && s.mMode === "own") && (
      <div
        role="note"
        aria-label="Preview"
        className="border-2 border-dashed border-foreground px-4 py-3 text-sm flex flex-col gap-1"
      >
        <strong>Preview: connecting a number isn’t switched on yet.</strong>
        <span className="text-neutral-700">
          These steps show how it will work. Nothing is sent to Meta and no number is connected.
          You can skip this step and connect later from your dashboard.
        </span>
      </div>
      )}

      {/* ── choose a method ── */}
      {idle && (
        <div
          role="radiogroup"
          aria-label="Connection method"
          className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-2"
        >
          {WA_METHODS.map((wm) => {
            const on = s.waMethod === wm.key;
            const isMeta = wm.key === "meta";
            return (
              <button
                key={wm.key}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => set({ waMethod: wm.key, cancelStep: null })}
                className={cn(
                  "flex flex-col gap-1 text-left px-4 py-3.5 border-2 text-foreground cursor-pointer",
                  on ? "border-primary bg-brand-100" : "border-divider bg-transparent"
                )}
              >
                <span className="flex gap-2 items-center flex-wrap">
                  <SquareRadio checked={on} />
                  <strong className="text-base">{wm.name}</strong>
                  <span
                    className={cn(
                      "text-[10px] font-extrabold tracking-[.06em] uppercase px-1.5 py-0.5 border",
                      isMeta
                        ? "bg-primary text-white border-primary"
                        : "bg-transparent text-foreground border-foreground"
                    )}
                  >
                    {wm.tag}
                  </span>
                </span>
                <span className="text-[13px] text-neutral-700 pl-6">{wm.description}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* ── Connect with Facebook ── */}
      {idle && meta && (
        <>
          <div className="flex flex-col gap-2">
            <RuleHeading>Is +91 {s.phone} on the WhatsApp Business app today?</RuleHeading>
            <div role="radiogroup" aria-label="WhatsApp Business app" className="flex flex-col">
              {COEX_OPTIONS.map((co) => {
                const on = s.coex === co.key;
                return (
                  <button
                    key={co.key}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => set({ coex: co.key })}
                    className="grid grid-cols-[20px_minmax(0,1fr)] gap-2.5 text-left py-3 border-0 border-b border-solid border-divider bg-transparent text-foreground cursor-pointer"
                  >
                    <SquareRadio checked={on} className="mt-0.5" />
                    <span>
                      <strong className="block text-[15px]">{co.name}</strong>
                      <span className="text-[13px] text-neutral-700">{co.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-1.5 text-sm">
            <span>You’ll need:</span>
            <span className="flex gap-2">
              <span className="font-extrabold">1</span>Your Facebook login (personal is fine)
            </span>
            <span className="flex gap-2">
              <span className="font-extrabold">2</span>
              {need2}
            </span>
            <span className="flex gap-2">
              <span className="font-extrabold">3</span>About 3 minutes
            </span>
          </div>

          {s.cancelStep && (
            <div
              role="alert"
              className="border-2 border-primary bg-brand-100 text-brand-900 px-3.5 py-3 text-sm"
            >
              <strong>You closed the Meta window at “{s.cancelStep}”.</strong> Nothing
              was changed. Try again when you’re ready.
            </div>
          )}

          <Button
            variant="primary"
            onClick={onOpenPopup}
            className="self-start text-base px-[18px] py-3 min-w-[260px] justify-start"
          >
            Continue with Facebook
          </Button>
        </>
      )}

      {/* ── Manual connection ── */}
      {idle && !meta && (
        <>
          <div
            role="tablist"
            aria-label="Manual connection type"
            className="flex border-2 border-foreground w-max max-w-full overflow-x-auto"
          >
            {MANUAL_MODES.map((mm) => {
              const on = s.mMode === mm.key;
              return (
                <button
                  key={mm.key}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => set({ mMode: mm.key })}
                  className={cn(
                    "px-3.5 py-2 border-0 text-sm font-extrabold cursor-pointer whitespace-nowrap",
                    on ? "bg-foreground text-background" : "bg-transparent text-foreground"
                  )}
                >
                  {mm.label}
                </button>
              );
            })}
          </div>

          {s.mMode === "partner" && (
            <div className="flex flex-col gap-3">
              <p className="m-0 text-sm text-neutral-700">
                You keep ownership of your WhatsApp account and never share a password
                or token. You can remove our access any time.
              </p>
              <div className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-sm items-start">
                <span className="font-extrabold text-lg text-primary">1</span>
                <span>
                  Open <strong>Meta Business Settings → WhatsApp accounts</strong>, pick
                  your account, then <strong>Partners → Assign partner</strong>.
                </span>
                <span className="font-extrabold text-lg text-primary">2</span>
                <div className="flex flex-col gap-2">
                  <span>
                    Enter our Business Portfolio ID and choose <strong>Full control</strong>.
                  </span>
                  <div className="bg-surface px-3.5 py-3">
                    {partnerCopy.map((item) => (
                      <CopyRow
                        key={item.label}
                        item={item}
                        copied={s.copied === item.label}
                        onCopy={() => copy(item)}
                      />
                    ))}
                  </div>
                </div>
                <span className="font-extrabold text-lg text-primary">3</span>
                <span>
                  Paste your account details below. Find them in WhatsApp Manager → Phone
                  numbers.
                </span>
              </div>
            </div>
          )}

          {s.mMode === "own" && (
            <OwnAppConnect
              config={config}
              tenantId={configTenant}
              onRetryConfig={() => {
                setConfig(null);
                setConfigTry((n) => n + 1);
              }}
              copied={s.copied}
              onCopy={copyValue}
            />
          )}

          {s.mMode === "partner" && (
            <>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-3.5">
                <div>
                  <Label htmlFor="pk-waba">WhatsApp Business Account ID</Label>
                  <Input
                    id="pk-waba"
                    value={s.mWaba}
                    onChange={(e) => set({ mWaba: e.target.value })}
                    placeholder="234567890123456"
                    className="font-mono"
                  />
                </div>
                <div>
                  <Label htmlFor="pk-phone-id">Phone number ID</Label>
                  <Input
                    id="pk-phone-id"
                    value={s.mPhoneId}
                    onChange={(e) => set({ mPhoneId: e.target.value })}
                    placeholder="109876543210987"
                    className="font-mono"
                  />
                </div>
              </div>

              <Button
                variant="primary"
                onClick={() => onRunChecks(s.mMode)}
                className="self-start text-base px-[18px] py-3 min-w-[240px] justify-start"
              >
                Check connection
              </Button>
            </>
          )}
        </>
      )}

      {/* ── Running checks ── */}
      {s.wa === "checking" && (
        <>
          <RuleHeading>
            {kind === "meta" ? "Preview: finishing setup" : "Preview: checking your connection"}
          </RuleHeading>
          <div role="status" aria-live="polite" className="flex flex-col">
            {list.map((c, i) => {
              const done = i < s.chkStep;
              const fail = i === s.chkFail;
              const wait = s.waitHi && i === s.chkStep;
              const cur = !done && !fail && !wait && i === s.chkStep && s.chkFail < 0;
              const mark: CheckMark = done
                ? "done"
                : fail
                  ? "fail"
                  : cur || wait
                    ? "active"
                    : "idle";
              const tone: Tone = fail ? "alert" : "muted";
              return (
                <CheckRow
                  key={c.title}
                  mark={mark}
                  title={c.title}
                  note={fail ? c.error : wait ? "Send “hi” from another phone" : undefined}
                  noteTone={tone}
                  status={
                    done ? "Done" : fail ? "Failed" : wait ? "Waiting" : cur ? "Checking…" : ""
                  }
                  statusTone={tone}
                />
              );
            })}
          </div>

          {s.waitHi && (
            <div className="border-2 border-dashed border-primary px-4 py-3.5 flex gap-3 items-center flex-wrap">
              <span className="flex-1 min-w-[220px] text-sm">
                <strong>Last step:</strong> send “hi” to +91 {s.phone} from any other
                phone. We’ll tick this the moment it arrives.
              </span>
              <Button
                variant="ghost"
                onClick={() =>
                  set({ waitHi: false, chkStep: list.length, wa: "live" })
                }
              >
                Prototype: “hi” received
              </Button>
            </div>
          )}

          {s.chkFail >= 0 && (
            <div className="flex gap-2.5 flex-wrap">
              <Button
                variant="primary"
                onClick={() => set({ wa: "idle", chkFail: -1 })}
              >
                Fix details
              </Button>
              <Button variant="secondary" onClick={() => onRunChecks(s.mMode)}>
                Check again
              </Button>
            </div>
          )}
        </>
      )}

      {/* ── End of the preview: nothing is connected ── */}
      {s.wa === "live" && (
        <>
          <div
            role="status"
            className="border-2 border-foreground px-[18px] py-4 flex gap-3 items-center flex-wrap"
          >
            <span
              aria-hidden
              className="size-8 border-2 border-foreground grid place-items-center font-extrabold flex-none"
            >
              i
            </span>
            <span className="flex-1 min-w-[200px]">
              <strong className="block text-[17px]">
                Preview finished: +91 {s.phone} isn’t connected yet
              </strong>
              <span className="text-sm text-neutral-700">
                {previewNote}. When connecting is switched on, you’ll do this for real and
                your dashboard’s WhatsApp page will show the number’s status.
              </span>
            </span>
          </div>

          <RuleHeading>After you connect, Meta will ask for</RuleHeading>
          <div className="flex flex-col">
            {metaList.map((c) => (
              <CheckRow key={c.t} mark="idle" title={c.t} note={c.note} noteTone="muted" status="" statusTone="muted" />
            ))}
          </div>
        </>
      )}
    </>
  );
}
