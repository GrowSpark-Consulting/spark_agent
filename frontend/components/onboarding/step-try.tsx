"use client";

import { Button } from "@/components/ui/button";
import { bizLabel, profileOf, testChatOf, type OnboardingState } from "@/features/onboarding/state";
import { demoWhatsAppNumber } from "@/lib/env";
import { StepIntro } from "@/components/onboarding/primitives";

/** `demoNumber` is the configured shared number (NEXT_PUBLIC_DEMO_WHATSAPP_NUMBER). */
export function StepTry({ s, demoNumber = demoWhatsAppNumber() }: { s: OnboardingState; demoNumber?: string | null }) {
  const profile = profileOf(s);
  const chat = testChatOf(s, demoNumber);

  return (
    <>
      <StepIntro title="Try your assistant now">
        {chat.kind === "none"
          ? "Message your assistant as if you were a customer, from the WhatsApp page once your number is connected."
          : `Message it as if you were a customer. It already knows ${bizLabel(s)}.`}
      </StepIntro>

      {chat.kind === "none" ? (
        <div data-testid="no-trial-chat" role="status" className="text-[13px] bg-surface px-3 py-2.5">
          {chat.reason === "has_business"
            ? "This account already has a business, so no new trial test chat was set up."
            : "No trial was set up, so there is no test chat."}
        </div>
      ) : (
        <div className="flex flex-col gap-3 max-w-[480px]">
          {chat.kind === "ready" ? (
            <>
              <div className="text-sm text-neutral-700">Open the test chat on this phone</div>
              <Button
                asChild
                variant="primary"
                className="justify-start bg-whatsapp hover:bg-whatsapp active:bg-whatsapp"
              >
                <a href={chat.url} target="_blank" rel="noopener noreferrer">
                  Open WhatsApp test chat
                </a>
              </Button>
              <div className="text-[13px] bg-surface px-3 py-2.5">
                Your code is <strong>{chat.code}</strong>. It works on our test number until your own number is connected.
              </div>
            </>
          ) : (
            <div data-testid="test-chat-unavailable" role="status" className="text-[13px] bg-surface px-3 py-2.5">
              The WhatsApp test chat isn’t available right now. Your code is <strong>{chat.code}</strong>; ask the Spark Agent
              team for the test number, or connect your own number in the next step.
            </div>
          )}
          <div className="text-[13px] text-neutral-700">Try asking: {profile.tryAsk}</div>
          <div data-testid="one-trial-note" className="text-[13px] text-neutral-700">
            There is one free trial for each WhatsApp number. If the phone you use here has already started a trial, the test chat will tell you so.
          </div>
        </div>
      )}
    </>
  );
}
