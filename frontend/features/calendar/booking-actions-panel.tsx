"use client";

import type { Role } from "@pakka/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatError } from "@/lib/errors";
import {
  availability,
  bookingActionService as defaultService,
  CANCEL_REASON_MAX,
  failureKind,
  mayAct,
  type ActionBooking,
  type BookingActionService,
  type MoveSlot,
} from "./booking-actions";
import type { ShownBooking } from "./data";
import { isDateString, localParts, zonedTime } from "./time";

// The buttons in the booking panel: Move, Cancel, Mark visited, No-show (docs/contracts.md, section 4). Every one calls
// Dev 2's route and waits for the answer: the booking on screen only changes when the calendar re-reads the database
// afterwards (`onDone`), never because a button was pressed. One action at a time. A customer is not messaged about a
// cancel or a move made here, and the panel says so before it is confirmed.

type Mode = "move" | "cancel" | "no_show" | null;

export interface ActionDone {
  message: string;
  /** The booking to keep selected afterwards (a move makes a new one); null closes the panel. */
  selectId: string | null;
}

export function BookingActionsPanel({
  booking,
  tenantId,
  role,
  userId,
  resourceUserId,
  now,
  timeZone,
  onDone,
  onStale,
  service = defaultService,
}: {
  booking: ShownBooking;
  tenantId: string;
  role: Role;
  userId: string;
  /** resources.user_id of the booking's resource, when it has one. */
  resourceUserId: string | null;
  now: Date;
  timeZone: string;
  onDone: (done: ActionDone) => void;
  /** The server says the booking is not as the screen has it: re-read the calendar. */
  onStale: () => void;
  service?: BookingActionService;
}) {
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Bumped when the server says a time was taken, so the list of free times is read again. */
  const [timesVersion, setTimesVersion] = useState(0);
  const can = availability(booking.shown, booking.start, now);
  const allowed = mayAct(role, userId, resourceUserId);

  async function run(label: string, call: () => Promise<ActionBooking>, done: (saved: ActionBooking) => ActionDone) {
    if (busy) return;
    setBusy(label);
    setError(null);
    try {
      const saved = await call();
      setMode(null);
      onDone(done(saved));
    } catch (err) {
      setError(formatError(err).message);
      const kind = failureKind(err);
      if (kind === "stale") onStale();
      if (kind === "slot_taken") setTimesVersion((v) => v + 1);
    } finally {
      setBusy(null);
    }
  }

  if (!can.reschedule && !can.cancel && can.complete === "no") return null;

  if (!allowed) {
    return (
      <p className="app-hint" style={{ margin: 0 }} data-testid="booking-actions-staff-note">
        Staff can change only the bookings in their own calendar.
      </p>
    );
  }

  const disabled = busy !== null;
  return (
    <section aria-label="Change this booking" style={{ display: "flex", flexDirection: "column", gap: "10px", borderTop: "2px solid var(--color-text)", paddingTop: "12px" }}>
      {mode === null ? (
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {can.complete !== "no" ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={disabled || can.complete === "not_started"}
              onClick={() => void run("complete", () => service.complete(tenantId, booking.id), () => ({ message: "Marked as visited", selectId: booking.id }))}
            >
              {busy === "complete" ? "Saving…" : "Mark visited"}
            </button>
          ) : null}
          {can.noShow !== "no" ? (
            <button type="button" className="btn btn-secondary" disabled={disabled || can.noShow === "not_started"} onClick={() => setMode("no_show")}>
              Mark no-show
            </button>
          ) : null}
          {can.reschedule ? (
            <button type="button" className="btn btn-secondary" disabled={disabled} onClick={() => setMode("move")}>
              Move to another time
            </button>
          ) : null}
          {can.cancel ? (
            <button type="button" className="btn btn-secondary" disabled={disabled} onClick={() => setMode("cancel")}>
              Cancel booking
            </button>
          ) : null}
        </div>
      ) : null}

      {mode === null && can.complete === "not_started" ? (
        <p className="app-hint" style={{ margin: 0 }}>
          Mark visited and no-show become available once the booking has started.
        </p>
      ) : null}

      {mode === "no_show" ? (
        <Confirm
          title="Mark this booking as a no-show?"
          text="If rebooking offers are switched on for your business, the customer is offered a new time. This can't be undone from here."
          confirm="Mark no-show"
          busy={busy === "no_show"}
          onConfirm={() => void run("no_show", () => service.noShow(tenantId, booking.id), () => ({ message: "Marked as a no-show", selectId: booking.id }))}
          onKeep={() => setMode(null)}
        />
      ) : null}

      {mode === "cancel" ? (
        <CancelForm
          busy={busy === "cancel"}
          onConfirm={(reason) => void run("cancel", () => service.cancel(tenantId, booking.id, reason), () => ({ message: "Booking cancelled", selectId: booking.id }))}
          onKeep={() => setMode(null)}
        />
      ) : null}

      {mode === "move" ? (
        <MoveForm
          booking={booking}
          tenantId={tenantId}
          timeZone={timeZone}
          service={service}
          version={timesVersion}
          busy={busy === "move"}
          onKeep={() => setMode(null)}
          onStale={onStale}
          onPick={(slot) =>
            void run("move", () => service.reschedule(tenantId, booking.id, slot), (saved) => ({ message: `Moved to ${slot.label}`, selectId: saved.id }))
          }
          onError={setError}
        />
      ) : null}

      {error ? (
        <div role="alert" style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-accent-700)", overflowWrap: "anywhere" }}>
          {error}
        </div>
      ) : null}
    </section>
  );
}

function Confirm({ title, text, confirm, busy, onConfirm, onKeep }: { title: string; text: string; confirm: string; busy: boolean; onConfirm: () => void; onKeep: () => void }) {
  return (
    <div role="group" aria-label={title} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <div style={{ fontWeight: 800 }}>{title}</div>
      <div style={{ fontSize: "14px", color: "var(--color-neutral-700)" }}>{text}</div>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={busy}>
          {busy ? "Saving…" : confirm}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onKeep} disabled={busy} autoFocus>
          Keep it
        </button>
      </div>
    </div>
  );
}

function CancelForm({ busy, onConfirm, onKeep }: { busy: boolean; onConfirm: (reason: string) => void; onKeep: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <div role="group" aria-label="Cancel this booking?" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <div style={{ fontWeight: 800 }}>Cancel this booking?</div>
      <div style={{ fontSize: "14px", color: "var(--color-neutral-700)" }}>The customer isn&apos;t told automatically. Message them from the inbox if they should know.</div>
      <div className="field">
        <label htmlFor="cancel-reason">Reason (optional)</label>
        <textarea id="cancel-reason" className="input" rows={2} maxLength={CANCEL_REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} />
      </div>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <button type="button" className="btn btn-primary" onClick={() => onConfirm(reason)} disabled={busy}>
          {busy ? "Cancelling…" : "Cancel booking"}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onKeep} disabled={busy} autoFocus>
          Keep it
        </button>
      </div>
    </div>
  );
}

type Times = { status: "loading" } | { status: "ready"; slots: MoveSlot[] } | { status: "error"; message: string };

function MoveForm({
  booking,
  tenantId,
  timeZone,
  service,
  version,
  busy,
  onKeep,
  onStale,
  onPick,
  onError,
}: {
  booking: ShownBooking;
  tenantId: string;
  timeZone: string;
  service: BookingActionService;
  /** Changes when the list must be read again without clearing the message that explains why. */
  version: number;
  busy: boolean;
  onKeep: () => void;
  onStale: () => void;
  onPick: (slot: MoveSlot) => void;
  onError: (message: string | null) => void;
}) {
  const [from, setFrom] = useState("");
  const [times, setTimes] = useState<Times>({ status: "loading" });
  const [picked, setPicked] = useState<MoveSlot | null>(null);
  const fromRef = useRef("");
  const latest = useRef(0);

  const find = useCallback(
    async (date: string, keepMessage = false) => {
      const request = ++latest.current;
      setTimes({ status: "loading" });
      setPicked(null);
      if (!keepMessage) onError(null);
      // From midnight of the chosen day in the business's zone; a day that has started (today or earlier) asks from now.
      const start = isDateString(date) && date > localParts(new Date(), timeZone).date ? zonedTime(date, 0, timeZone) : undefined;
      try {
        const slots = await service.slots(tenantId, booking.id, start);
        if (request === latest.current) setTimes({ status: "ready", slots });
      } catch (err) {
        if (request !== latest.current) return;
        setTimes({ status: "error", message: formatError(err).message });
        if (failureKind(err) === "stale") onStale();
      }
    },
    [service, tenantId, booking.id, timeZone, onError, onStale],
  );

  useEffect(() => {
    // The first look, and again after a taken time (the message stays: it says why the list changed).
    void find(fromRef.current, version > 0);
  }, [find, version]);

  return (
    <div role="group" aria-label="Move this booking" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div style={{ fontWeight: 800 }}>Move to another time</div>
      <label style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "13px", flexWrap: "wrap" }}>
        <span>Show times from</span>
        <input
          type="date"
          className="input"
          value={from}
          disabled={busy}
          onChange={(e) => {
            fromRef.current = e.target.value;
            setFrom(e.target.value);
            if (e.target.value === "" || isDateString(e.target.value)) void find(e.target.value);
          }}
          style={{ width: "auto", minHeight: "36px", padding: "4px 8px" }}
        />
      </label>

      {times.status === "loading" ? (
        <p className="app-hint" style={{ margin: 0 }} role="status">
          Looking for free times…
        </p>
      ) : null}
      {times.status === "error" ? (
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
          <span role="alert" style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-accent-700)" }}>
            {times.message}
          </span>
          <button type="button" className="btn btn-secondary" onClick={() => void find(from)}>
            Try again
          </button>
        </div>
      ) : null}
      {times.status === "ready" && times.slots.length === 0 ? (
        <p className="app-hint" style={{ margin: 0 }}>
          No free times in that week. Try a later date.
        </p>
      ) : null}
      {times.status === "ready" && times.slots.length > 0 ? (
        <div role="radiogroup" aria-label="Free times" style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {times.slots.map((slot) => {
            const on = picked?.start === slot.start && picked.resourceId === slot.resourceId;
            return (
              <button
                key={`${slot.start}:${slot.resourceId}`}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={busy}
                onClick={() => setPicked(slot)}
                style={{
                  textAlign: "left",
                  padding: "8px 10px",
                  font: "inherit",
                  fontSize: "14px",
                  cursor: "pointer",
                  border: `2px solid ${on ? "var(--color-text)" : "var(--color-divider)"}`,
                  background: on ? "var(--color-surface)" : "transparent",
                  color: "var(--color-text)",
                }}
              >
                <span style={{ fontWeight: 700 }}>{slot.label}</span>
                <span style={{ color: "var(--color-neutral-700)" }}> · {slot.resourceName}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="app-hint" style={{ margin: 0 }}>
        The customer isn&apos;t told automatically. Message them from the inbox if they should know.
      </div>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <button type="button" className="btn btn-primary" disabled={busy || picked === null} onClick={() => picked && onPick(picked)}>
          {busy ? "Moving…" : "Move booking"}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onKeep} disabled={busy}>
          Keep it where it is
        </button>
      </div>
    </div>
  );
}
