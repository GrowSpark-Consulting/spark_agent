"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckRow, CopyRow, RuleHeading, type CheckMark } from "@/components/onboarding/primitives";
import type { WhatsAppConnectionPublic, TokenType } from "@pakka/types";
import {
  checkLines,
  resolveWhatsAppTenant,
  submitManualConnect,
  type ManualConnectForm,
  type WebhookConfigResult,
} from "@/lib/whatsapp/manual-connect";

// "Use my own Meta app": the real values to paste into Meta's dashboard, then the account details. The screen
// says "Connected" only when the API returned a connection with status `active`.

const EMPTY: ManualConnectForm = { wabaId: "", phoneNumberId: "", tokenType: "system_user", token: "", appSecret: "" };

const MARK: Record<string, CheckMark> = { pass: "done", fail: "fail", warn: "active", not_verified: "idle", skipped: "idle" };
const STATUS_WORD: Record<string, string> = { pass: "Done", fail: "Failed", warn: "Check", not_verified: "Waiting", skipped: "Skipped" };

export function OwnAppConnect({
  config,
  tenantId,
  onRetryConfig,
  copied,
  onCopy,
}: {
  config: WebhookConfigResult | null;
  /** The business `config` was read for. The details are sent to this business only. */
  tenantId: string | null;
  onRetryConfig: () => void;
  copied: string | null;
  onCopy: (label: string, value: string) => void;
}) {
  const [form, setForm] = React.useState<ManualConnectForm>(EMPTY);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fields, setFields] = React.useState<Record<string, string>>({});
  const [connection, setConnection] = React.useState<WhatsAppConnectionPublic | null>(null);

  const update = (patch: Partial<ManualConnectForm>) => setForm((f) => ({ ...f, ...patch }));
  const ready = form.wabaId.trim() && form.phoneNumberId.trim() && form.token.trim() && form.appSecret.trim();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pending || !ready) return;
    setPending(true);
    setError(null);
    setFields({});
    // The business is worked out again now, not trusted from earlier: if it is gone, unclear or no longer the one
    // the webhook details above were made for, nothing is sent (the details would belong to another business).
    const tenant = await resolveWhatsAppTenant();
    if (tenant.state !== "ready") {
      setPending(false);
      setError(tenant.message);
      return;
    }
    if (tenant.tenantId !== tenantId) {
      setPending(false);
      setError("Your business changed since these webhook details were shown. We've reloaded them; check them in Meta, then connect again.");
      onRetryConfig();
      return;
    }
    const result = await submitManualConnect(form, tenant.tenantId);
    setPending(false);
    if (result.state === "rejected") {
      setError(result.message);
      setFields(result.fields);
      return;
    }
    setConnection(result.connection);
    // The secrets were sent once. They are not kept once the API has stored them.
    if (result.connection.status === "active") setForm((f) => ({ ...f, token: "", appSecret: "" }));
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-sm text-neutral-700">
        For businesses and agencies running their own Meta app. Point your app’s webhook at Spark Agent,
        then enter the account details from Meta. Your access token and app secret are encrypted on our
        server and never shown again.
      </p>

      {/* ── 1. what to enter in Meta ── */}
      <div className="bg-surface px-4 py-3.5 flex flex-col gap-2.5">
        <div className="text-[13px] font-extrabold">In your Meta app’s webhook settings, enter:</div>
        {config === null ? (
          <div role="status" className="text-sm text-neutral-700">
            Loading your webhook details…
          </div>
        ) : config.state === "ready" ? (
          <>
            <CopyRow
              item={{ label: "Callback URL", value: config.config.webhookUrl }}
              copied={copied === "Callback URL"}
              onCopy={() => onCopy("Callback URL", config.config.webhookUrl)}
            />
            <CopyRow
              item={{ label: "Verify token", value: config.config.verifyToken }}
              copied={copied === "Verify token"}
              onCopy={() => onCopy("Verify token", config.config.verifyToken)}
            />
            <ol className="m-0 pl-5 text-[13px] text-neutral-700 flex flex-col gap-1">
              <li>
                Open <strong>developers.facebook.com → your app → WhatsApp → Configuration</strong>.
              </li>
              <li>
                Under Webhook choose <strong>Edit</strong>, paste both values, then <strong>Verify and save</strong>.
              </li>
              <li>
                Subscribe to the <strong>messages</strong> field (and the account, template and quality fields
                if you want those updates).
              </li>
            </ol>
          </>
        ) : (
          <div role="alert" className="text-sm flex flex-col gap-2 items-start">
            <span>{config.message}</span>
            {config.state === "error" && config.retryable ? (
              <Button variant="secondary" onClick={onRetryConfig} className="py-[5px] px-2.5 text-[13px]">
                Try again
              </Button>
            ) : null}
          </div>
        )}
      </div>

      {/* ── 2. the account details ── */}
      {config?.state === "ready" && connection?.status !== "active" && (
        <form onSubmit={submit} className="flex flex-col gap-3.5" noValidate>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-3.5">
            <Field id="pk-own-waba" label="WhatsApp Business Account ID" error={fields.wabaId}>
              <Input
                id="pk-own-waba"
                value={form.wabaId}
                onChange={(e) => update({ wabaId: e.target.value })}
                placeholder="234567890123456"
                inputMode="numeric"
                autoComplete="off"
                aria-invalid={!!fields.wabaId}
                className="font-mono"
              />
            </Field>
            <Field id="pk-own-phone-id" label="Phone number ID" error={fields.phoneNumberId}>
              <Input
                id="pk-own-phone-id"
                value={form.phoneNumberId}
                onChange={(e) => update({ phoneNumberId: e.target.value })}
                placeholder="109876543210987"
                inputMode="numeric"
                autoComplete="off"
                aria-invalid={!!fields.phoneNumberId}
                className="font-mono"
              />
            </Field>
          </div>
          <Field id="pk-own-token-type" label="Token type" error={fields.tokenType}>
            <select
              id="pk-own-token-type"
              value={form.tokenType}
              onChange={(e) => update({ tokenType: e.target.value as TokenType })}
              className="w-full min-h-9 px-2.5 py-1.5 text-sm bg-surface border border-solid border-divider rounded-none"
            >
              <option value="system_user">System user token (recommended)</option>
              <option value="business">Business token</option>
            </select>
          </Field>
          <Field id="pk-own-token" label="Access token" error={fields.token}>
            <Input
              id="pk-own-token"
              type="password"
              value={form.token}
              onChange={(e) => update({ token: e.target.value })}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!fields.token}
              className="font-mono"
            />
          </Field>
          <Field id="pk-own-secret" label="App secret" error={fields.appSecret}>
            <Input
              id="pk-own-secret"
              type="password"
              value={form.appSecret}
              onChange={(e) => update({ appSecret: e.target.value })}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!fields.appSecret}
              className="font-mono"
            />
            <span className="text-xs text-neutral-700">
              Meta app dashboard → App settings → Basic. We use it to check that messages really come from Meta.
            </span>
          </Field>

          {error && (
            <div role="alert" className="border-2 border-primary bg-brand-100 text-brand-900 px-3.5 py-3 text-sm">
              {error}
            </div>
          )}

          <Button
            type="submit"
            variant="primary"
            disabled={pending || !ready}
            className="self-start text-base px-[18px] py-3 min-w-[240px] justify-start"
          >
            {pending ? "Checking with Meta…" : "Connect number"}
          </Button>
        </form>
      )}

      {/* ── 3. what the API says ── */}
      {connection && <ConnectionResult connection={connection} />}
    </div>
  );
}

function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <span role="alert" className="text-xs text-brand-700">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function ConnectionResult({ connection }: { connection: WhatsAppConnectionPublic }) {
  const active = connection.status === "active";
  const lines = checkLines(connection.last_check);
  return (
    <div className="flex flex-col gap-2">
      <div
        role={active ? "status" : "alert"}
        className={active ? "border-2 border-foreground px-[18px] py-4" : "border-2 border-primary bg-brand-100 text-brand-900 px-[18px] py-4"}
      >
        <strong className="block text-[17px]">
          {active ? "Connected" : "Meta didn’t accept these details"}
          {connection.display_phone ? ` · ${connection.display_phone}` : ""}
        </strong>
        <span className="text-sm">
          {active
            ? "Your number is saved. Send a message to it from another phone: it shows as connected in your dashboard once Meta delivers it to us."
            : "Nothing is connected. Fix the details below and try again."}
        </span>
      </div>
      {lines.length > 0 && (
        <>
          <RuleHeading>Checks</RuleHeading>
          <div className="flex flex-col">
            {lines.map((c) => (
              <CheckRow
                key={c.key}
                mark={MARK[c.status] ?? "idle"}
                title={c.key.replaceAll("_", " ")}
                note={c.message}
                noteTone={c.status === "fail" ? "alert" : "muted"}
                status={STATUS_WORD[c.status] ?? c.status}
                statusTone={c.status === "fail" ? "alert" : "muted"}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
