import { languageName, STATUS_TEXT, summarizeTemplates, summaryLine, type TemplateStatusRow } from "@/lib/whatsapp/templates";

// Message template approval for one WhatsApp number (lib/whatsapp/templates.ts). `templates` is null when they couldn't be read: that is
// said as it is, and no count is claimed. A template that Meta hasn't approved can't be sent; the list says which and, for a rejection,
// why in Meta's own words.

export function WhatsAppTemplateStatus({ templates }: { templates: readonly TemplateStatusRow[] | null }) {
  if (templates === null) {
    return (
      <p className="app-hint" data-testid="template-status-unavailable" style={{ margin: "8px 0 0" }}>
        Template approval status couldn’t be loaded. Reload the page to try again.
      </p>
    );
  }
  const summary = summarizeTemplates(templates);
  return (
    <div role="group" aria-label="Message templates" data-testid="template-status" style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
      <div>
        <div style={{ fontSize: 12, color: "var(--color-neutral-700)" }}>Message templates</div>
        <div style={{ fontWeight: 600 }}>{summaryLine(summary)}</div>
      </div>
      {templates.map((t) => {
        const s = STATUS_TEXT[t.status];
        return (
          <div key={t.id} data-testid="template-row" data-template={t.name} data-status={t.status} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{t.name}</span>
              <span className="app-hint" style={{ margin: 0 }}>
                {languageName(t.language)} · {t.category}
              </span>
              <span className={`app-status app-status-${s.tone}`}>{s.label}</span>
            </div>
            <p className="app-hint" style={{ margin: 0 }}>
              {s.detail}
              {t.status === "rejected" && t.rejectionReason ? ` Meta said: “${t.rejectionReason}”` : ""}
            </p>
          </div>
        );
      })}
    </div>
  );
}
