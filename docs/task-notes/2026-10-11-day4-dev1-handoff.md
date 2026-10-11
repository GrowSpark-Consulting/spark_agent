# Day 4 (Dev 1): handing a chat to a person. What was built, and what Dev 2 and Dev 3 should know

Audience: Dev 2 (Shaaz) and Dev 3 (Dhatri). The next person to touch the agent can read it too.

Nothing here changes a file, a table, a migration or an endpoint of yours. Everything of Dev 1's is in `backend/src/agent/` and `backend/src/channels/whatsapp/`
(plus tests, conversation tests and this note). The only shared files touched are `server/routes.ts` (one added route), `inngest/functions.ts` and
`inngest/process-message.ts` (one added function and one added branch). Sections 3 and 4 are the parts about Dev 2's and Dev 3's areas.

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

## 3. For Dev 2: what Dev 1's work sends, links to and affects

1. **The two alert links.** Dev 1 built the links that a staff alert's buttons can point to. `createHandoffLinks(claims, env, now, { ownNumber })` is in `agent/handoff/token` and returns `{ inbox, own }` (`own` is null when `ownNumber` is false). Claims are `{ tenantId, handoffId, userId }`: a link is for one staff member, so there is one token per person. `ownNumber` should be whether the business has the `handoff_own_number` feature. The links are `${API_PUBLIC_URL}/h/<token>?mode=inbox|own`, so `API_PUBLIC_URL` has to be set on Railway. Both links carry the same token, so using one ends the other. Today nothing calls `createHandoffLinks`; `handoff-alert` is unchanged.
2. **`handoff.own_number`** is now sent when a staff member uses the own-number link (id `handoff_own_number:<handoffId>`, data `{ tenantId, handoffId }`). Your `own-number-outcome` job already listens for it.
3. **Events Dev 1 sends that nothing consumes yet** (ids only, so any alert text has to be built from the database):

| Event | Sent when | Data |
|---|---|---|
| `lead.hot` | a lead turns hot (id `lead_hot:<leadId>`, audit `lead.hot_alerted`, once per lead) | `{ tenantId, leadId, conversationId }` |
| `voice_note.received` | a voice note was answered with the request to type (id `voice_note:<lastMessageId>`) | ids |
| `chat.external_waiting` | a customer wrote during an own-number chat, at most every 30 minutes per chat (id `external_waiting:<messageId>`) | `{ tenantId, conversationId, messageId }` |
| `chat.phone_reply` | the owner replied from the phone app | `{ tenantId, conversationId }`; Dev 1's own job handles it (the AI's return after 24 hours), nothing for others |

4. **What the product owner decided about alerts** (for context; the alerts themselves are Dev 2's): a discount request is alerted at once with priority, the summary and the range asked for; a hot-lead alert says "hot lead" with the 2 to 5 line summary; staff alerts, lead cards and staff replies cost no credits.
5. **A lead card is available** at `GET /api/conversations/:id/lead-card` (any member, the business from `X-Pakka-Tenant`), built by `buildLeadCard` in `agent/leadcard/build.ts`, if an alert wants its text.
6. **A link mismatch that touches both Dev 2 and Dev 3.** Dev 1's takeover link opens `/dashboard/inbox?chat=<conversationId>`, which is the parameter the inbox reads (`inbox-screen.tsx`). The staff alerts in `notify/staff-alerts.ts` use `?conversation=<id>`, which the inbox does not read, so those links open the inbox without selecting the chat.

## 4. For Dev 3: what Dev 1's work adds in your area

1. **The lead card.** `GET /api/conversations/:id/lead-card` returns `contact`, `need`, `languageNote`, `source`, `answers`, `score`, `temperature`, `isHot`, `booking`, `trigger`, `priority`, `sentiment`, `summary`, plus next step, suggested reply and discount (the shape is `LeadCard` in `agent/leadcard/card.ts`). `owner` is always null: Dev 1 does not know a lead's owner.
2. **A hot lead is not a handoff row.** Your inbox marks any chat with an open handoff as "Needs human", even in AI mode, so Dev 1 made a hot lead an event plus an audit row. `leads.temperature` holds "hot" if the list wants to show it.
3. **The link into the inbox** is `/dashboard/inbox?chat=<conversationId>`, the parameter your inbox reads. See Dev 2's point 6 for the other alert links.
4. **The Team screen and consent.** The product owner wants a one-time "I agree" before a staff member's name and number are shown to customers. Nothing for it exists. Until it does, the own-number link reads `memberships.takeover_pref`: `inbox` blocks it; `own_number` or `ask` allow it. It also needs `memberships.whatsapp_phone`, otherwise the staff member gets an "add your number" page. So the Team screen's own-number choice and number are what the link depends on today.
5. **System notes in the chat.** The link adds a `sender: system` message with `meta.event` `takeover` or `own_number_takeover`; the owner's phone-reply note and the 24-hour return note are system messages too.
6. **The 24-hour return** closes the chat's open handoffs, as "Return to AI" does.
7. **Own-number chats.** The conversation mode is `external` and `assigned_user_id` is the staff member. The AI stays out and nothing returns it by itself; only "Return to AI" does.

## 5. Still open (Dev 1 follows these up)

1. **Wording in four languages is a draft** and needs a native speaker: the handover sorry, the voice-note request, the own-number notice and greeting, and the "your team member is looking after your chat" line (English, Tamil, Tanglish and Hindi).
2. **Consent** is not a real "I agree" yet (see section 4, point 4).
3. **The echo payload from Meta (phone-app replies)** was built from Meta's documentation and has not been seen on a real number. It needs a test on staging with a real coexistence number.
4. **Not run on staging or with the real models.** All of this was tested with fakes and mocked models. Before launch run `pnpm test:conversations -- --live --only <chat>` for the handoff chats.
5. **The rename from Pakka to Spark** still needs its own planned change: the code, the `X-Pakka-Tenant` header, the `@pakka/*` packages, the token context `"pakka:handoff-link"` (changing it would invalidate links already sent) and the docs.

## 6. Limits worth knowing

- The link is a credential for 24 hours. It names one person and works once, but anyone holding the alert message can use it before that person does.
- The own-number notice to the customer is best effort: outside the 24-hour window or at zero credits the customer is not told, and the staff member is still sent to them.
- The link pages are served by the API (Railway), not the frontend. `frontend/app/h/[token]/` is an empty placeholder and is not used.
