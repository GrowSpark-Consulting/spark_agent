import { z } from "zod";

// Which chat the Inbox opens first, from the URL. The app writes `?chat=<conversation id>`; staff alerts
// (backend/src/notify/staff-alerts.ts) link to `?conversation=<id>`, and the takeover link (backend/src/agent/handoff/takeover.ts)
// uses `?chat=`. Both are read. `chat` wins when both are valid; an id that isn't a GUID is ignored, never passed on. The id only
// picks which of the member's own conversations opens: the business comes from the session, so an id of another business just
// finds no chat in the list.

type Param = string | string[] | undefined;

const ChatId = z.guid();
const firstValue = (param: Param) => (Array.isArray(param) ? param[0] : param);

export function initialChatIdFrom(params: { chat?: Param; conversation?: Param }): string | null {
  for (const param of [params.chat, params.conversation]) {
    const parsed = ChatId.safeParse(firstValue(param));
    if (parsed.success) return parsed.data;
  }
  return null;
}
