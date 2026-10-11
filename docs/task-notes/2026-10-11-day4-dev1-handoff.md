# Day 4 (Dev 1): handing a chat to a person. What was built, and what Dev 2 and Dev 3 need to do or know

Audience: Dev 2 (Shaaz) and Dev 3 (Dhatri). The next person to touch the agent can read it too.

Nothing here changes a file, a table, a migration or an endpoint of yours. Everything of Dev 1's is in `backend/src/agent/` and `backend/src/channels/whatsapp/`
(plus tests, conversation tests and this note). The only shared files touched are `server/routes.ts` (one added route), `inngest/functions.ts` and
`inngest/process-message.ts` (one added function and one added branch). The sections that start "Dev 2:" and "Dev 3:" are things to do or check.

## 1. What it does, in plain words

1. **Triggers.** The assistant hands a chat to a person when the customer is angry (a short sorry first), asks for a discount, or turns a hot lead. A hot lead is **not** a handoff row; it is an event (see section 4).
2. **Lead card.** Staff, a team member, an admin or the owner can read a card instead of the whole chat: who, what they want, how promising, why a person is needed, a 2 to 5 line summary, the next step, a reply ready to send, and for a discount request what was asked.
3. **Staff alert links.** The alert has two URL buttons. Each is a signed link, for one staff member and one handoff, good for 24 hours and **once**. "Take over in inbox" opens the dashboard on the chat. "Reply from my number" (Growth, Pro, Trial) moves the chat to the staff member's own WhatsApp, tells the customer who will message them and from which number, and opens WhatsApp with a greeting ready.
4. **Owner replies from the phone app.** The chat goes to human mode, and 24 hours later, if nobody on the team replied, the AI takes it back with a note.
5. **Customer writes again during an own-number chat.** The AI says that the team member is looking after the chat, at most once every 30 minutes, and staff are pinged by an event.
6. **Voice note.** Answered once with a request to type (1 credit), and staff are told.
7. **Fixed behaviours.** Off-topic, opt-out acknowledgement and "are you a bot" are covered by scripted chats (03, 04, 06, and 20 to 45).

## 2. What was merged

| PR | What |
|---|---|
| #101 | Handoff triggers for an angry customer, a discount request and a hot lead. |
| #102 | Lead card (`agent/leadcard/`) and `GET /api/conversations/:id/lead-card`. |
| #103 | The owner's replies from the phone app (coexistence echoes) and the AI's return after 24 hours. |
| #104 | A voice note is answered once with a request to type, and staff are told. |
| #105 | The signed 24-hour links, `GET /h/:token`. |
| #106 | The 30-minute notice during an own-number chat, and the `handoff.own_number` event. |

## 3. Dev 2: what to do or check

1. **Handoff alert buttons.** Build the two URL buttons with `createHandoffLinks(claims, env, now, { ownNumber })` from `agent/handoff/token`. Claims are `{ tenantId, handoffId, userId }`, one token per staff member. `ownNumber` is whether the business has `handoff_own_number`; when false there is no second link. It needs `API_PUBLIC_URL` set on Railway (the links are `${API_PUBLIC_URL}/h/<token>?mode=inbox|own`). Both links carry the same token, so using one ends the other.
2. **`handoff.own_number`** is now sent by the link (id `handoff_own_number:<handoffId>`, data `{ tenantId, handoffId }`). Your `own-number-outcome` job already waits for it.
3. **Events that nothing listens to yet.** Ids only, in each case:

| Event | Sent when | Data | Suggested use |
|---|---|---|---|
| `lead.hot` | a lead turns hot (id `lead_hot:<leadId>`, audit `lead.hot_alerted`, once per lead) | `{ tenantId, leadId, conversationId }` | "Hot lead" alert with the card's summary |
| `voice_note.received` | a voice note got the request to type (id `voice_note:<lastMessageId>`) | ids | tell staff there is a voice note to listen to |
| `chat.external_waiting` | a customer wrote during an own-number chat, at most every 30 minutes per chat (id `external_waiting:<messageId>`) | `{ tenantId, conversationId, messageId }` | ping the staff member who has the chat |
| `chat.phone_reply` | the owner replied from the phone app | `{ tenantId, conversationId }` | **handled by Dev 1's job** (24-hour return), nothing to do |

4. **Alert wording.** A discount alert goes at once with priority, the summary and the range asked for. A hot-lead alert says "hot lead" and carries the 2 to 5 line summary. Staff alerts, lead cards and staff replies cost no credits.
5. **The lead card endpoint** is `GET /api/conversations/:id/lead-card` (any member, the business from `X-Pakka-Tenant`). It can be used to fill an alert's text too (`buildLeadCard` in `agent/leadcard/build.ts`).

## 4. Dev 3: what to do or check

1. **Lead card on the inbox.** `GET /api/conversations/:id/lead-card` returns `contact`, `need`, `languageNote`, `source`, `answers`, `score`, `temperature`, `isHot`, `booking`, `trigger`, `priority`, `sentiment`, `summary`, plus next step, suggested reply and discount (the shape is `LeadCard` in `agent/leadcard/card.ts`). `owner` is null today; it is for you to fill if the lead has an owner.
2. **A hot lead is not a handoff row.** Your inbox marks any chat with an open handoff as "Needs human", even in AI mode, so a hot lead is only an event plus an audit row. If you want a "hot" marker in the list, read `leads.temperature`.
3. **The inbox opens on the chat** from the link: `/dashboard/inbox?chat=<conversationId>`, which is the parameter your inbox reads (`inbox-screen.tsx`). Dev 2's staff alerts use `?conversation=<id>` (`notify/staff-alerts.ts`), which the inbox does not read, so those links open the inbox without selecting the chat. One of the two should change; this is for Dev 2 and Dev 3 to agree, not Dev 1.
4. **The Team screen and consent.** The product owner wants a one-time "I agree" before a staff member's name and number are shown to customers. Not built. For now the link reads `memberships.takeover_pref`: `inbox` blocks the own-number link, `own_number` or `ask` allow it. Treat choosing "own number" in the Team screen as the agreement, with the number saved in `whatsapp_phone`, until a real consent field exists.
5. **System notes in the chat.** The link adds a `sender: system` message with `meta.event` `takeover` or `own_number_takeover`; the owner's phone-reply note and the 24-hour return note do the same. They should show as small notes, not as bubbles.
6. **The 24-hour return** closes the chat's open handoffs, like "Return to AI" does.
7. **Own-number chat.** The conversation mode is `external` and `assigned_user_id` is the staff member. The AI stays out. Staff press "Return to AI" to hand it back; nothing returns it by itself.

## 5. Still open (Dev 1 follows these up)

1. **Wording in four languages is a draft** and needs a native speaker: the handover sorry, the voice-note request, the own-number notice and greeting, and the "your team member is looking after your chat" line (English, Tamil, Tanglish and Hindi).
2. **Consent** is not a real "I agree" yet (see Dev 3, point 4).
3. **The echo payload from Meta (phone-app replies)** was built from Meta's documentation and has not been seen on a real number. It needs a test on staging with a real coexistence number.
4. **Not run on staging or with the real models.** All of this was tested with fakes and mocked models. Before launch run `pnpm test:conversations -- --live --only <chat>` for the handoff chats.
5. **The rename from Pakka to Spark** still needs its own planned change: the code, the `X-Pakka-Tenant` header, the `@pakka/*` packages, the token context `"pakka:handoff-link"` (changing it would invalidate links already sent) and the docs.

## 6. Limits worth knowing

- The link is a credential for 24 hours. It names one person and works once, but anyone holding the alert message can use it before that person does. Staff should not forward alerts.
- The own-number notice to the customer is best effort: outside the 24-hour window or at zero credits the customer is not told, and the staff member is still sent to them.
- The link pages are served by the API (Railway), not the frontend. `frontend/app/h/[token]/` is an empty placeholder and is not used.
