// The pages a staff member sees when they tap a button in an alert and it cannot do what it says (Raja, 11 Oct, question 2): a friendly page that says
// why in plain words and points to the inbox, never an error screen. They hold no token, no number and no name: only fixed words and the dashboard's
// own address. Never cached, never leaked through a referrer.

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
} as const;

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export type Notice = { status: number; title: string; message: string };

export const NOTICES = {
  expired: { status: 410, title: "This link has expired", message: "Links to take over a chat work for 24 hours. The chat is not lost: open your inbox to continue." },
  used: { status: 409, title: "This link has already been used", message: "Someone has already taken over this chat, or it is no longer waiting for a person. Open your inbox to see it." },
  usedByYou: { status: 409, title: "You already took over this chat", message: "You opened this link before, and the chat is yours. Open your inbox to continue it." },
  unsure: { status: 503, title: "We could not confirm this takeover", message: "The chat may or may not have moved to you. Open your inbox to see who has it before you reply." },
  teammate: { status: 409, title: "A teammate already has this chat", message: "Another team member took it over a moment ago. Open your inbox to see who is replying." },
  external: { status: 409, title: "This chat is handled from a team member using their own WhatsApp number", message: "It is already being handled from their own WhatsApp number, so it cannot be taken over here." },
  notMember: { status: 403, title: "This link is not for your account", message: "It was made for a team member of the business. Sign in to your inbox instead." },
  plan: { status: 403, title: "Replying from your own number is not part of your plan", message: "Use the inbox button instead, or ask the owner about the plan." },
  inboxOnly: { status: 403, title: "Your account is set to reply in the inbox", message: "Use the inbox button, or change it under Team settings if you want to reply from your own number." },
  noPhone: { status: 403, title: "Add your WhatsApp number first", message: "Add your number under Team settings, then tap the button again. You can use the inbox button for now." },
  noCustomer: { status: 404, title: "We could not find this customer", message: "Open your inbox to see the chat." },
  badLink: { status: 404, title: "This link is not valid", message: "Open your inbox to continue." },
  trouble: { status: 503, title: "Something went wrong on our side", message: "Nothing was changed. Try the link again in a moment, or open your inbox." },
} as const satisfies Record<string, Notice>;

export function friendlyPage(notice: Notice, inboxUrl: string): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(notice.title)}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f7f7f5;color:#1b1b1b}main{max-width:26rem;margin:1.5rem;padding:1.75rem;background:#fff;border-radius:.75rem;box-shadow:0 1px 4px rgba(0,0,0,.12)}h1{font-size:1.2rem;margin:0 0 .6rem}p{margin:0 0 1.25rem;line-height:1.5}a{display:inline-block;padding:.65rem 1.1rem;border-radius:.5rem;background:#1b1b1b;color:#fff;text-decoration:none}</style></head>
<body><main><h1>${escapeHtml(notice.title)}</h1><p>${escapeHtml(notice.message)}</p><a href="${escapeHtml(inboxUrl)}">Open the inbox</a></main></body></html>`;
  return new Response(html, { status: notice.status, headers: HEADERS });
}

/** A redirect that is never cached. */
export function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}
