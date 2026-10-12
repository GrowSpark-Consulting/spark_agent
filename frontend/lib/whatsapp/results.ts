import { SendResult, TEMPLATE_LANGUAGES, type CreateTemplateResult, type SendTestMessageResult } from "@pakka/types";
import { z } from "zod";
import type { FormattedError } from "@/lib/errors";

// The answers of POST /api/messages/test and POST /api/templates, checked before the forms say "sent" or "submitted".
// postJson only casts what the API sends; without this a 2xx with some other body would be shown as success with empty
// values. The shapes are the shared ones (@pakka/types SendResult, CreateTemplateResult), so this and the API agree by construction.

const SendTestMessageAnswer = SendResult.extend({ status: z.literal("accepted") });
const CreateTemplateAnswer = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  language: z.enum(TEMPLATE_LANGUAGES),
  status: z.enum(["pending", "draft"]),
});

export class ResultDataError extends Error {
  constructor(readonly what: "test message" | "template") {
    super(`The ${what} answer had an unexpected shape.`);
    this.name = "ResultDataError";
  }
}

export function readTestMessageResult(json: unknown): SendTestMessageResult {
  const parsed = SendTestMessageAnswer.safeParse(json);
  if (!parsed.success) throw new ResultDataError("test message");
  return parsed.data;
}

export function readTemplateResult(json: unknown): CreateTemplateResult {
  const parsed = CreateTemplateAnswer.safeParse(json);
  if (!parsed.success) throw new ResultDataError("template");
  return parsed.data;
}

/** The request was answered, but not in a form we can read, so whether it worked is unknown: say that, and not "sent" or "not sent". */
export function unconfirmedFailure(err: ResultDataError): FormattedError {
  return err.what === "template"
    ? {
        code: "internal",
        title: "Couldn't confirm the template",
        message: "We couldn't confirm whether the template was saved or sent to Meta. Check your templates before submitting it again.",
        retryable: false,
      }
    : {
        code: "internal",
        title: "Couldn't confirm the message",
        message: "We couldn't confirm whether WhatsApp accepted the message. Check the phone before sending it again.",
        retryable: false,
      };
}
