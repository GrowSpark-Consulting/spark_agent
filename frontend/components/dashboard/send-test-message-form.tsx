"use client";

import { SendTestMessageInput, WHATSAPP_TEXT_MAX, type SendTestMessageResult } from "@pakka/types";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { ErrorState, LoadingState } from "@/components/shared/states";
import { postJson } from "@/lib/api/client";
import { formatError, type FormattedError } from "@/lib/errors";
import { readTestMessageResult, ResultDataError, unconfirmedFailure } from "@/lib/whatsapp/results";
import { useTenant } from "./tenant-context";

export type ConnectionHint = "connected" | "not_connected" | "unknown";

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; result: SendTestMessageResult; to: string }
  | { kind: "failed"; error: FormattedError };

/** Moves keyboard focus to the first field with an error, in form order. */
function focusFirstInvalid(fields: Record<string, string>) {
  const first = (["to", "body"] as const).find((k) => fields[k]);
  if (first) document.getElementById(first)?.focus();
}

export function SendTestMessageForm({ connection, businessName }: { connection: ConnectionHint; businessName: string }) {
  const { role, tenant } = useTenant();
  const [to, setTo] = useState("");
  const [body, setBody] = useState(`Hello from ${businessName}! This is a test message sent with Spark Agent.`);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const canSend = role === "owner" || role === "admin";

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const parsed = SendTestMessageInput.safeParse({ to, body });
    if (!parsed.success) {
      const invalid = formatError(parsed.error).fields ?? {};
      setFields(invalid);
      setStatus({ kind: "idle" });
      focusFirstInvalid(invalid);
      return;
    }
    setFields({});
    setStatus({ kind: "sending" });
    try {
      // Checked, not just cast: a 2xx with another body must not read as "WhatsApp accepted the message".
      const result = readTestMessageResult(await postJson<unknown>("/api/messages/test", parsed.data, { tenantId: tenant.id }));
      setStatus({ kind: "sent", result, to: parsed.data.to });
    } catch (err) {
      const error = err instanceof ResultDataError ? unconfirmedFailure(err) : formatError(err);
      setFields(error.fields ?? {});
      setStatus({ kind: "failed", error });
      focusFirstInvalid(error.fields ?? {});
    }
  }

  const sending = status.kind === "sending";

  return (
    <form className="app-form" onSubmit={submit} noValidate aria-describedby="send-status">
      {connection === "not_connected" ? (
        <p className="app-notice" role="note">
          No WhatsApp number is connected yet, so a test message can&apos;t be delivered.{" "}
          <Link href="/dashboard/whatsapp">See connection status</Link>
        </p>
      ) : null}
      {!canSend ? (
        <p className="app-notice" role="note">
          Only an owner or admin can send test messages.
        </p>
      ) : null}

      <div className="field">
        <label htmlFor="to">Recipient&apos;s WhatsApp number</label>
        <input
          id="to"
          name="to"
          className="input"
          type="tel"
          inputMode="tel"
          autoComplete="off"
          placeholder="+919840012345"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          aria-invalid={fields.to ? true : undefined}
          aria-describedby={fields.to ? "to-error" : "to-hint"}
        />
        {fields.to ? (
          <p id="to-error" className="app-field-error">{fields.to}</p>
        ) : (
          <p id="to-hint" className="app-hint">
            With country code, no spaces. The phone must have messaged your WhatsApp number in the last 24 hours.
          </p>
        )}
      </div>

      <div className="field">
        <label htmlFor="body">Message</label>
        <textarea
          id="body"
          name="body"
          className="input"
          rows={4}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          aria-invalid={fields.body ? true : undefined}
          aria-describedby={fields.body ? "body-error" : "body-count"}
        />
        <div className="app-row">
          {fields.body ? <p id="body-error" className="app-field-error">{fields.body}</p> : null}
          <span id="body-count" className="app-counter">
            {body.length} / {WHATSAPP_TEXT_MAX}
          </span>
        </div>
      </div>

      <div className="app-actions">
        <button type="submit" className="btn btn-primary" disabled={sending || !canSend}>
          {sending ? "Sending…" : "Send test message"}
        </button>
      </div>

      <div id="send-status">
        {status.kind === "sending" ? <LoadingState compact title="Sending your message" description="Waiting for WhatsApp to accept it." /> : null}
        {status.kind === "sent" ? (
          <div className="app-success" role="status">
            <strong>Sent to {status.to}.</strong> WhatsApp accepted the message (ID {status.result.providerMsgId}). It
            can take a moment to arrive on the phone.
          </div>
        ) : null}
        {status.kind === "failed" ? (
          <ErrorState
            compact
            title={status.error.title}
            description={status.error.message}
            onRetry={status.error.retryable ? () => void submit() : undefined}
            action={
              status.error.code === "whatsapp_not_connected" ? (
                <Link className="btn btn-secondary" href="/dashboard/whatsapp">
                  Check WhatsApp connection
                </Link>
              ) : undefined
            }
          />
        ) : null}
      </div>
    </form>
  );
}
