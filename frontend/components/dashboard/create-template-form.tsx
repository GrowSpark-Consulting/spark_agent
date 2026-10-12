"use client";

import {
  CreateTemplateInput,
  TEMPLATE_BODY_MAX,
  TEMPLATE_BUTTONS_MAX,
  TEMPLATE_FOOTER_MAX,
  TEMPLATE_HEADER_MAX,
  TemplateButton,
  templateVariables,
  type CreateTemplateResult,
} from "@pakka/types";
import { useRef, useState, type FormEvent } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/shared/states";
import { postJson } from "@/lib/api/client";
import { formatError, type FormattedError } from "@/lib/errors";
import { readTemplateResult, ResultDataError, unconfirmedFailure } from "@/lib/whatsapp/results";
import { useTenant } from "./tenant-context";

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "submitted"; result: CreateTemplateResult }
  | { kind: "failed"; error: FormattedError };

type Category = CreateTemplateInput["category"];
type Language = CreateTemplateInput["language"];
type ButtonType = TemplateButton["type"];

/** A button as it is being edited: every field kept, so switching type doesn't lose what was typed. */
interface ButtonDraft {
  key: number;
  type: ButtonType;
  text: string;
  url: string;
  phoneNumber: string;
}

// Labels for the values CreateTemplateInput accepts (TEMPLATE_CATEGORIES, TEMPLATE_LANGUAGES,
// TEMPLATE_BUTTON_TYPES).
const CATEGORIES = [
  { value: "utility", label: "Utility", hint: "Booking confirmations, reminders, updates the customer asked for." },
  { value: "marketing", label: "Marketing", hint: "Offers, follow-ups and anything promotional." },
] as const satisfies readonly { value: Category; label: string; hint: string }[];
const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "ta", label: "Tamil" },
] as const satisfies readonly { value: Language; label: string }[];
const BUTTON_TYPES = [
  { value: "quick_reply", label: "Quick reply" },
  { value: "url", label: "Website" },
  { value: "phone_number", label: "Phone number" },
] as const satisfies readonly { value: ButtonType; label: string }[];

/** The exact shape the contract takes for each button type. */
function toButton(b: ButtonDraft): unknown {
  if (b.type === "url") return { type: "url", text: b.text, url: b.url.trim() };
  if (b.type === "phone_number") return { type: "phone_number", text: b.text, phoneNumber: b.phoneNumber };
  return { type: "quick_reply", text: b.text };
}

/** First error per field of one button ("text", "url", "phoneNumber"). */
function buttonErrors(b: ButtonDraft): Record<string, string> {
  const result = TemplateButton.safeParse(toButton(b));
  const errors: Record<string, string> = {};
  for (const issue of result.error?.issues ?? []) errors[String(issue.path[0])] ??= issue.message;
  return errors;
}

export function CreateTemplateForm() {
  const { role, tenant } = useTenant();
  const canCreate = role === "owner" || role === "admin";
  const [name, setName] = useState("");
  const [category, setCategory] = useState<Category>("utility");
  const [language, setLanguage] = useState<Language>("en");
  const [header, setHeader] = useState("");
  const [body, setBody] = useState("");
  // Keyed by variable number, so a sample stays with its {{n}} when the body is edited.
  const [examples, setExamples] = useState<Record<number, string>>({});
  const [footer, setFooter] = useState("");
  const [buttons, setButtons] = useState<ButtonDraft[]>([]);
  const nextButtonKey = useRef(0);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const vars = templateVariables(body);
  const exampleFor = (n: number) => examples[n] ?? "";
  // Per-input button errors, shown once a submit has found a problem with the buttons.
  const buttonIssues = fields.buttons ? buttons.map(buttonErrors) : [];

  function addVariable() {
    const next = (vars.at(-1) ?? 0) + 1;
    setBody((b) => `${b}${b && !b.endsWith(" ") ? " " : ""}{{${next}}}`);
  }

  function addButton() {
    setButtons((prev) =>
      prev.length >= TEMPLATE_BUTTONS_MAX
        ? prev
        : [...prev, { key: nextButtonKey.current++, type: "quick_reply", text: "", url: "", phoneNumber: "" }],
    );
  }

  function updateButton(key: number, patch: Partial<ButtonDraft>) {
    setButtons((prev) => prev.map((b) => (b.key === key ? { ...b, ...patch } : b)));
  }

  /** Moves keyboard focus to the first field with an error, in form order. */
  function focusFirstInvalid(invalid: Record<string, string>) {
    let id: string | null = null;
    if (invalid.name) id = "name";
    else if (invalid.header) id = "header";
    else if (invalid.body) id = "body";
    else if (invalid.examples) id = `example-${vars.find((n) => !exampleFor(n).trim()) ?? vars[0]}`;
    else if (invalid.footer) id = "footer";
    else if (invalid.buttons) {
      const i = buttons.findIndex((b) => Object.keys(buttonErrors(b)).length > 0);
      if (i >= 0) {
        const errors = buttonErrors(buttons[i]);
        id = errors.text ? `button-${i}-text` : errors.url ? `button-${i}-url` : `button-${i}-phone`;
      }
    }
    if (id) document.getElementById(id)?.focus();
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const input = {
      name,
      category,
      language,
      body,
      examples: vars.map((n) => exampleFor(n)),
      ...(header.trim() ? { header } : {}),
      ...(footer.trim() ? { footer } : {}),
      ...(buttons.length ? { buttons: buttons.map(toButton) } : {}),
    };
    const parsed = CreateTemplateInput.safeParse(input);
    if (!parsed.success) {
      const invalid = formatError(parsed.error).fields ?? {};
      setFields(invalid);
      setStatus({ kind: "idle" });
      focusFirstInvalid(invalid);
      return;
    }
    setFields({});
    setStatus({ kind: "submitting" });
    try {
      // Checked, not just cast: a 2xx with another body must not read as "was submitted to Meta".
      const result = readTemplateResult(await postJson<unknown>("/api/templates", parsed.data, { tenantId: tenant.id }));
      setStatus({ kind: "submitted", result });
    } catch (err) {
      const error = err instanceof ResultDataError ? unconfirmedFailure(err) : formatError(err);
      setFields(error.fields ?? {});
      setStatus({ kind: "failed", error });
      focusFirstInvalid(error.fields ?? {});
    }
  }

  // Preview with sample values filled in.
  const preview = body.replace(/\{\{(\d+)\}\}/g, (m, n: string) => examples[Number(n)]?.trim() || m);
  const submitting = status.kind === "submitting";
  const languageLabel = (value: string) => LANGUAGES.find((l) => l.value === value)?.label ?? value;

  return (
    <form className="app-form" onSubmit={submit} noValidate>
      {!canCreate ? (
        <p className="app-notice" role="note">
          Only an owner or admin can create templates.
        </p>
      ) : null}

      <div className="field">
        <label htmlFor="name">Template name</label>
        <input
          id="name"
          className="input"
          placeholder="booking_confirmed_v1"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={fields.name ? true : undefined}
          aria-describedby={fields.name ? "name-error" : "name-hint"}
          autoComplete="off"
          spellCheck={false}
        />
        {fields.name ? (
          <p id="name-error" className="app-field-error">{fields.name}</p>
        ) : (
          <p id="name-hint" className="app-hint">
            Lowercase with underscores, ending in a version. To change an approved template, create the next version.
          </p>
        )}
      </div>

      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Category</legend>
        <div className="app-seg">
          {CATEGORIES.map((c) => (
            <label key={c.value}>
              <input type="radio" name="category" value={c.value} checked={category === c.value} onChange={() => setCategory(c.value)} />
              {c.label}
            </label>
          ))}
        </div>
        <p className="app-hint">{CATEGORIES.find((c) => c.value === category)?.hint}</p>
      </fieldset>

      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Language</legend>
        <div className="app-seg">
          {LANGUAGES.map((l) => (
            <label key={l.value}>
              <input type="radio" name="language" value={l.value} checked={language === l.value} onChange={() => setLanguage(l.value)} />
              {l.label}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="field">
        <label htmlFor="header">Header (optional)</label>
        <input
          id="header"
          className="input"
          value={header}
          onChange={(e) => setHeader(e.target.value)}
          aria-invalid={fields.header ? true : undefined}
          aria-describedby={fields.header ? "header-error" : "header-count"}
          autoComplete="off"
        />
        <div className="app-row">
          {fields.header ? <p id="header-error" className="app-field-error">{fields.header}</p> : null}
          <span id="header-count" className="app-counter">
            {header.length} / {TEMPLATE_HEADER_MAX}
          </span>
        </div>
      </div>

      <div className="field">
        <label htmlFor="body">Message</label>
        <textarea
          id="body"
          className="input"
          rows={5}
          placeholder="Hi {{1}}, your visit is booked for {{2}}."
          value={body}
          onChange={(e) => setBody(e.target.value)}
          aria-invalid={fields.body ? true : undefined}
          aria-describedby={fields.body ? "tbody-error" : "tbody-count"}
        />
        <div className="app-row">
          <button type="button" className="btn btn-ghost" onClick={addVariable}>
            + Add variable
          </button>
          {fields.body ? <p id="tbody-error" className="app-field-error">{fields.body}</p> : null}
          <span id="tbody-count" className="app-counter">
            {body.length} / {TEMPLATE_BODY_MAX}
          </span>
        </div>
      </div>

      <section className="field" aria-labelledby="samples-heading">
        <h2 id="samples-heading" style={{ fontSize: 13, fontWeight: 600, margin: "0 0 6px" }}>
          Sample values
        </h2>
        {vars.length === 0 ? (
          <EmptyState
            compact
            title="No variables yet"
            description="Add {{1}}, {{2}} … for details that change per message, like a name or a date. Meta reviews the template with your sample values."
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {vars.map((n) => {
              const invalid = Boolean(fields.examples) && !exampleFor(n).trim();
              return (
                <div key={n} className="field">
                  <label htmlFor={`example-${n}`}>Sample for {`{{${n}}}`}</label>
                  <input
                    id={`example-${n}`}
                    className="input"
                    aria-invalid={invalid ? true : undefined}
                    aria-describedby={invalid ? "examples-error" : undefined}
                    value={exampleFor(n)}
                    onChange={(e) => setExamples((prev) => ({ ...prev, [n]: e.target.value }))}
                  />
                </div>
              );
            })}
          </div>
        )}
        {fields.examples ? <p id="examples-error" className="app-field-error">{fields.examples}</p> : null}
      </section>

      <div className="field">
        <label htmlFor="footer">Footer (optional)</label>
        <input
          id="footer"
          className="input"
          value={footer}
          onChange={(e) => setFooter(e.target.value)}
          aria-invalid={fields.footer ? true : undefined}
          aria-describedby={fields.footer ? "footer-error" : "footer-count"}
          autoComplete="off"
        />
        <div className="app-row">
          {fields.footer ? <p id="footer-error" className="app-field-error">{fields.footer}</p> : null}
          <span id="footer-count" className="app-counter">
            {footer.length} / {TEMPLATE_FOOTER_MAX}
          </span>
        </div>
      </div>

      <section className="field" aria-labelledby="buttons-heading">
        <h2 id="buttons-heading" style={{ fontSize: 13, fontWeight: 600, margin: "0 0 6px" }}>
          Buttons (optional)
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {buttons.map((b, i) => {
            const errors = buttonIssues[i] ?? {};
            const valueField =
              b.type === "url"
                ? { id: `button-${i}-url`, label: "Web address", key: "url" as const, type: "url", placeholder: "https://" }
                : b.type === "phone_number"
                  ? { id: `button-${i}-phone`, label: "Phone number to call", key: "phoneNumber" as const, type: "tel", placeholder: "+919840012345" }
                  : null;
            return (
              <div key={b.key} className="app-card" role="group" aria-labelledby={`button-${i}-heading`}>
                <div className="app-row">
                  <span id={`button-${i}-heading`} style={{ fontSize: 13, fontWeight: 600 }}>
                    Button {i + 1}
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ marginLeft: "auto" }}
                    onClick={() => setButtons((prev) => prev.filter((x) => x.key !== b.key))}
                    aria-label={`Remove button ${i + 1}`}
                  >
                    Remove
                  </button>
                </div>
                <div className="app-seg" role="radiogroup" aria-label={`Button ${i + 1} type`}>
                  {BUTTON_TYPES.map((t) => (
                    <label key={t.value}>
                      <input
                        type="radio"
                        name={`button-${b.key}-type`}
                        value={t.value}
                        checked={b.type === t.value}
                        onChange={() => updateButton(b.key, { type: t.value })}
                      />
                      {t.label}
                    </label>
                  ))}
                </div>
                <div className="field">
                  <label htmlFor={`button-${i}-text`}>Button text</label>
                  <input
                    id={`button-${i}-text`}
                    className="input"
                    value={b.text}
                    onChange={(e) => updateButton(b.key, { text: e.target.value })}
                    aria-invalid={errors.text ? true : undefined}
                    aria-describedby={errors.text ? `button-${i}-text-error` : undefined}
                    autoComplete="off"
                  />
                  {errors.text ? <p id={`button-${i}-text-error`} className="app-field-error">{errors.text}</p> : null}
                </div>
                {valueField ? (
                  <div className="field">
                    <label htmlFor={valueField.id}>{valueField.label}</label>
                    <input
                      id={valueField.id}
                      className="input"
                      type={valueField.type}
                      inputMode={valueField.type === "tel" ? "tel" : "url"}
                      placeholder={valueField.placeholder}
                      value={b[valueField.key]}
                      onChange={(e) => updateButton(b.key, { [valueField.key]: e.target.value })}
                      aria-invalid={errors[valueField.key] ? true : undefined}
                      aria-describedby={errors[valueField.key] ? `${valueField.id}-error` : undefined}
                      autoComplete="off"
                    />
                    {errors[valueField.key] ? (
                      <p id={`${valueField.id}-error`} className="app-field-error">{errors[valueField.key]}</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="app-row">
          <button type="button" className="btn btn-ghost" onClick={addButton} disabled={buttons.length >= TEMPLATE_BUTTONS_MAX}>
            + Add button
          </button>
          <span className="app-counter">
            {buttons.length} / {TEMPLATE_BUTTONS_MAX}
          </span>
        </div>
        {fields.buttons && buttonIssues.every((e) => Object.keys(e).length === 0) ? (
          <p className="app-field-error">{fields.buttons}</p>
        ) : null}
      </section>

      <section aria-labelledby="preview-heading">
        <h2 id="preview-heading" style={{ fontSize: 13, fontWeight: 600, margin: "0 0 6px" }}>
          Preview
        </h2>
        <div className="app-preview">
          <div className="app-bubble" data-testid="template-preview">
            {header.trim() ? <span className="app-bubble-header">{header.trim()}</span> : null}
            {preview || "Your message appears here."}
            {footer.trim() ? <span className="app-bubble-footer">{footer.trim()}</span> : null}
            <span className="app-bubble-meta">
              {CATEGORIES.find((c) => c.value === category)?.label} · {languageLabel(language)}
            </span>
          </div>
          {buttons.length ? (
            <ul className="app-bubble-buttons" aria-label="Preview buttons">
              {buttons.map((b) => (
                <li key={b.key} className="app-bubble-button">
                  {b.text.trim() || BUTTON_TYPES.find((t) => t.value === b.type)?.label}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>

      <div className="app-actions">
        <button type="submit" className="btn btn-primary" disabled={submitting || !canCreate}>
          {submitting ? "Submitting…" : "Submit for review"}
        </button>
      </div>

      <div>
        {status.kind === "submitting" ? <LoadingState compact title="Submitting your template" description="Sending it to Meta for review." /> : null}
        {status.kind === "submitted" ? (
          <div className="app-success" role="status">
            <strong>{status.result.name}</strong> ({languageLabel(status.result.language)}){" "}
            {status.result.status === "pending"
              ? "was submitted to Meta and is waiting for review."
              : "was saved as a draft. It hasn't been submitted to Meta."}
          </div>
        ) : null}
        {status.kind === "failed" ? (
          <ErrorState
            compact
            title={status.error.title}
            description={status.error.message}
            onRetry={status.error.retryable ? () => void submit() : undefined}
          />
        ) : null}
      </div>
    </form>
  );
}
