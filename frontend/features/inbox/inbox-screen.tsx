"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatError } from "@/lib/errors";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { ChatView, type ChatState } from "./chat-view";
import { ConversationList, type ListState } from "./conversation-list";
import {
  applyConversationChange,
  applyHandoffChange,
  applyMessageToList,
  fetchConversations,
  fetchMessages,
  matchesFilter,
  matchesSearch,
  ReadSequencer,
  upsertMessage,
  type ChatMessage,
  type ConversationSummary,
  type InboxFilter,
} from "./data";
import { fetchLeadCardAi, unavailableAi, type LeadCardAiState } from "./lead-card-api";
import { fetchLeadCard } from "./lead-card-data";
import { LeadCardPanel, LeadCardSheet, type LeadCardState } from "./lead-card-panel";
import { useInboxRealtime } from "./use-inbox-realtime";

// The real inbox: the /dashboard/preview Inbox layout backed by the member's own data. Reads go
// through the browser client as the signed-in member (RLS), scoped to the session's tenant; live
// changes come from one Realtime channel for the business. The open chat's lead card is read the
// same way, kept per conversation so one chat's lead never shows on another, and its failure stays
// inside the card.

const CLOCK_TICK_MS = 60_000;

function sequencerFor<K, T>(map: Map<K, ReadSequencer<T>>, key: K): ReadSequencer<T> {
  let reads = map.get(key);
  if (!reads) map.set(key, (reads = new ReadSequencer<T>()));
  return reads;
}

export function InboxScreen({
  tenantId,
  timeZone,
  initialChatId,
}: {
  tenantId: string;
  timeZone: string;
  initialChatId: string | null;
}) {
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [chats, setChats] = useState<Record<string, ChatState>>({});
  const [selectedId, setSelectedId] = useState<string | null>(initialChatId);
  const [view, setView] = useState<"list" | "chat">(initialChatId ? "chat" : "list");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => new Date());
  /** Lead cards by conversation id; a missing entry is still loading. */
  const [leadCards, setLeadCards] = useState<Record<string, LeadCardState>>({});
  /** The AI-written part of each lead card (the lead-card route), read apart from the stored lead so each fails on its own. */
  const [leadAi, setLeadAi] = useState<Record<string, LeadCardAiState>>({});
  const [leadSheetOpen, setLeadSheetOpen] = useState(false);
  /** The newest lead read per conversation: an older one finishing late is ignored. */
  const leadReads = useRef(new Map<string, number>());
  const leadAiReads = useRef(new Map<string, number>());

  // Times ("9:42 am", "Yesterday") and the 24-hour window move with the clock.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Overlapping reads are sequenced so the newest wins and live changes made meanwhile survive it.
  const listReads = useRef(new Map<"list", ReadSequencer<ConversationSummary[]>>());
  const chatReads = useRef(new Map<string, ReadSequencer<ChatMessage[]>>());

  const loadList = useCallback(async () => {
    const reads = sequencerFor(listReads.current, "list");
    const seq = reads.start();
    try {
      const fetched = await fetchConversations(getSupabaseBrowserClient(), tenantId);
      const items = reads.finish(seq, fetched);
      if (items) setList({ status: "ready", items });
    } catch (err) {
      // A failed refresh keeps what's on screen; only a failed first load shows the error.
      if (reads.fail(seq)) setList((prev) => (prev.status === "ready" ? prev : { status: "error", error: formatError(err) }));
    }
  }, [tenantId]);

  const loadChat = useCallback(
    async (conversationId: string) => {
      const reads = sequencerFor(chatReads.current, conversationId);
      const seq = reads.start();
      try {
        const fetched = await fetchMessages(getSupabaseBrowserClient(), tenantId, conversationId);
        const messages = reads.finish(seq, fetched);
        if (messages) setChats((prev) => ({ ...prev, [conversationId]: { status: "ready", messages } }));
      } catch (err) {
        if (!reads.fail(seq)) return;
        setChats((prev) =>
          prev[conversationId]?.status === "ready"
            ? prev
            : { ...prev, [conversationId]: { status: "error", error: formatError(err) } },
        );
      }
    },
    [tenantId],
  );

  /** A live change to the list: shown now, and replayed onto any list read still in flight. */
  function changeList(change: (items: ConversationSummary[]) => ConversationSummary[]) {
    sequencerFor(listReads.current, "list").record(change);
    setList((prev) => (prev.status === "ready" ? { ...prev, items: change(prev.items) } : prev));
  }

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const items = list.status === "ready" ? list.items : [];
  // The prototype opens the first chat on wide screens; a chat picked from the URL or the list wins.
  const selected = items.find((c) => c.id === selectedId) ?? (selectedId ? undefined : items[0]);
  const activeId = selected?.id ?? null;

  useEffect(() => {
    if (activeId) void loadChat(activeId);
  }, [activeId, loadChat]);

  const loadLeadAi = useCallback(
    async (conversationId: string) => {
      const seq = (leadAiReads.current.get(conversationId) ?? 0) + 1;
      leadAiReads.current.set(conversationId, seq);
      const settle = (state: LeadCardAiState) => {
        if (leadAiReads.current.get(conversationId) === seq) setLeadAi((prev) => ({ ...prev, [conversationId]: state }));
      };
      try {
        settle({ status: "ready", ai: await fetchLeadCardAi(tenantId, conversationId) });
      } catch (err) {
        settle(unavailableAi(err));
      }
    },
    [tenantId],
  );

  const loadLead = useCallback(
    async (conversationId: string, contactId: string) => {
      const seq = (leadReads.current.get(conversationId) ?? 0) + 1;
      leadReads.current.set(conversationId, seq);
      const settle = (state: LeadCardState) => {
        if (leadReads.current.get(conversationId) === seq) setLeadCards((prev) => ({ ...prev, [conversationId]: state }));
      };
      try {
        const card = await fetchLeadCard(getSupabaseBrowserClient(), tenantId, contactId, new Date(), timeZone);
        settle({ status: "ready", card });
        // The AI part is asked for only when there is a lead to write about; a customer who isn't a lead has no card.
        if (card && leadReads.current.get(conversationId) === seq) void loadLeadAi(conversationId);
      } catch (err) {
        settle({ status: "error", error: formatError(err) });
      }
    },
    [tenantId, timeZone, loadLeadAi],
  );

  // Read again whenever a chat is opened, so the card is never older than the chat on screen.
  const activeContactId = selected?.contactId ?? null;
  useEffect(() => {
    if (activeId && activeContactId) void loadLead(activeId, activeContactId);
  }, [activeId, activeContactId, loadLead]);

  const realtime = useInboxRealtime(tenantId, {
    onMessage: (message: ChatMessage) => {
      if (list.status === "ready" && !list.items.some((c) => c.id === message.conversationId)) {
        void loadList(); // a new chat: the list read brings its contact
      } else {
        changeList((items) => applyMessageToList(items, message) ?? items);
      }
      sequencerFor(chatReads.current, message.conversationId).record((messages) => upsertMessage(messages, message));
      setChats((prev) => {
        const chat = prev[message.conversationId];
        if (chat?.status !== "ready") return prev;
        return { ...prev, [message.conversationId]: { ...chat, messages: upsertMessage(chat.messages, message) } };
      });
    },
    onConversation: (row) => {
      if (list.status === "ready" && !list.items.some((c) => c.id === row.id)) {
        void loadList();
        return;
      }
      changeList((items) => applyConversationChange(items, row) ?? items);
    },
    onHandoff: (row) => {
      changeList((items) => applyHandoffChange(items, row) ?? items);
    },
    onResync: () => {
      void loadList();
      if (activeId) void loadChat(activeId);
    },
  });

  const visible = items.filter((c) => matchesFilter(c, filter) && matchesSearch(c, query));
  const chatState: ChatState = activeId ? (chats[activeId] ?? { status: "loading" }) : { status: "loading" };
  const showingChat = view === "chat" && selected !== undefined;

  function setChatParam(id: string | null) {
    const url = new URL(window.location.href);
    // `?conversation=` (staff alert links) is only the way in; from here the URL says `chat`, so it can't disagree.
    url.searchParams.delete("conversation");
    if (id) url.searchParams.set("chat", id);
    else url.searchParams.delete("chat");
    window.history.replaceState(null, "", url);
  }

  function openChat(id: string) {
    setSelectedId(id);
    setView("chat");
    setChatParam(id);
    setLeadSheetOpen(false);
  }

  function backToList() {
    setView("list");
    setChatParam(null);
    setLeadSheetOpen(false);
  }

  const leadState: LeadCardState = activeId ? (leadCards[activeId] ?? { status: "loading" }) : { status: "loading" };
  const aiState: LeadCardAiState = activeId ? (leadAi[activeId] ?? { status: "loading" }) : { status: "loading" };
  // Try again on the card retries whichever part failed: the stored lead (then the AI part follows it) or the AI part alone.
  const retryLead = () => {
    if (!selected) return;
    if (leadState.status === "error") {
      setLeadCards((prev) => ({ ...prev, [selected.id]: { status: "loading" } }));
      void loadLead(selected.id, selected.contactId);
    } else if (aiState.status === "unavailable") {
      setLeadAi((prev) => ({ ...prev, [selected.id]: { status: "loading" } }));
      void loadLeadAi(selected.id);
    }
  };
  const closeLeadSheet = useCallback(() => setLeadSheetOpen(false), []);

  return (
    <div className="app-inbox pk-light" data-view={showingChat ? "chat" : "list"} data-lead={selected ? "true" : undefined} data-testid="inbox">
      <h1 className="app-inbox-title">Inbox</h1>
      <ConversationList
        list={list}
        visible={visible}
        filter={filter}
        onFilter={setFilter}
        query={query}
        onQuery={setQuery}
        selectedId={activeId}
        onOpen={openChat}
        onRetry={() => void loadList()}
        realtime={realtime}
        now={now}
        timeZone={timeZone}
      />
      <div className="app-inbox-chat">
        {selected ? (
          <ChatView
            tenantId={tenantId}
            conversation={selected}
            chat={chatState}
            now={now}
            timeZone={timeZone}
            onBack={backToList}
            onRetry={() => void loadChat(selected.id)}
            onShowLead={() => setLeadSheetOpen(true)}
            onModeChanged={(id, mode) => changeList((items) => items.map((c) => (c.id === id ? { ...c, mode } : c)))}
          />
        ) : (
          <div style={{ flex: "1", background: "var(--wa-bg)", display: "flex", alignItems: "center", padding: "40px" }}>
            {list.status === "ready" ? (
              <div style={{ maxWidth: "360px", color: "var(--wa-ink)" }}>
                <div style={{ fontWeight: "800", fontSize: "22px", marginBottom: "6px" }}>
                  {items.length === 0 ? "Your first chat will open here" : "Pick a chat to read it here"}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>
      {selected ? <LeadCardPanel state={leadState} ai={aiState} conversation={selected} onRetry={retryLead} /> : null}
      {selected && leadSheetOpen ? <LeadCardSheet state={leadState} ai={aiState} conversation={selected} onRetry={retryLead} onClose={closeLeadSheet} /> : null}
    </div>
  );
}
