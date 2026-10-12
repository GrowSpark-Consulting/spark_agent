import type { ErrorCode, SendResult } from "@pakka/types";
import type { Interactive } from "./interactive";

// The WhatsApp adapter (module 1) plugs in here: channels/whatsapp/message-sender.ts registers its
// factory at startup (server/main.ts). notify.send asks the factory for a sender bound to one tenant's
// connection, and never sees the token. Until a factory is registered, sends answer not_available
// before any credits are spent.

// Every method throws a SendError when WhatsApp does not accept the message.
export interface MessageSender {
  sendText(to: string, text: string): Promise<SendResult>;
  /** `buttons`: the payloads of the template's quick-reply buttons, in their order (only when it has exactly that many). */
  sendTemplate(to: string, name: string, language: string, params: string[], buttons?: string[]): Promise<SendResult>;
  /** Reply buttons or a list; free-form, so inside the 24-hour window only (like sendText). */
  sendInteractive(to: string, message: Interactive): Promise<SendResult>;
}

/**
 * Why a send failed, as one of the shared error codes (outside_window, rate_limited,
 * whatsapp_not_connected, validation_failed, upstream_failed, internal); notify.send passes it on.
 * `retryable`: a later attempt may work. `outcomeUnknown`: the message may have gone out anyway (a
 * timeout, a network failure or an unreadable answer), so it must never be resent automatically.
 */
export class SendError extends Error {
  readonly retryable: boolean;
  readonly outcomeUnknown: boolean;

  constructor(
    readonly code: ErrorCode,
    message: string,
    options: { retryable?: boolean; outcomeUnknown?: boolean } = {},
  ) {
    super(message);
    this.name = "SendError";
    this.retryable = options.retryable ?? false;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
  }
}

/**
 * Thrown by sendText and sendInteractive when WhatsApp refuses a free-form message because the 24-hour window has closed (Meta
 * error 131047, the adapter's `outside_window`). notify.send then sends the approved template instead.
 */
export class OutsideWindowError extends SendError {
  constructor(message = "WhatsApp only allows an approved template outside the 24-hour window.") {
    super("outside_window", message);
    this.name = "OutsideWindowError";
  }
}

export type SenderFactory = (connection: { tenantId: string; connectionId: string }) => Promise<MessageSender>;

let factory: SenderFactory | undefined;

/** Called once at startup (server/main.ts registers the WhatsApp sender); tests pass a fake, or undefined to reset. */
export function registerSender(next: SenderFactory | undefined): void {
  factory = next;
}

export function senderFactory(): SenderFactory | undefined {
  return factory;
}
