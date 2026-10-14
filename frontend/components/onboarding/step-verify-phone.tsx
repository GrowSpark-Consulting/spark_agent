"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { phoneProblem, type OnboardingState, type SetState } from "@/features/onboarding/state";
import { StepIntro } from "@/components/onboarding/primitives";

export function StepVerifyPhone({
  s,
  set,
}: {
  s: OnboardingState;
  set: SetState;
}) {
  const problem = phoneProblem(s);
  return (
    <>
      <StepIntro title="Start your free trial">
        7 days, 300 credits, no card. We’ll send a code to your WhatsApp.
      </StepIntro>

      <div>
        <Label htmlFor="pk-phone">Your WhatsApp number</Label>
        <div className="flex gap-2">
          <span className="w-[72px] flex-none flex items-center min-h-12 px-2.5 py-1.5 text-sm font-semibold bg-surface border border-divider">
            +91
          </span>
          <Input
            id="pk-phone"
            value={s.phone}
            onChange={(e) => set({ phone: e.target.value })}
            inputMode="tel"
            placeholder="98400 12345"
            aria-invalid={!!problem}
            aria-describedby={problem ? "pk-phone-error" : undefined}
            className="min-h-12 text-[17px]"
          />
        </div>
        {problem ? (
          <p id="pk-phone-error" role="alert" data-testid="phone-error" className="mt-1.5 text-sm">
            {problem}
          </p>
        ) : null}
      </div>

      {s.otpSent && (
        <>
          <div>
            <Label htmlFor="pk-otp">6-digit code sent to +91 {s.phone}</Label>
            <Input
              id="pk-otp"
              value={s.otp}
              onChange={(e) =>
                set({ otp: e.target.value.replace(/\D/g, "").slice(0, 6) })
              }
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="––––––"
              className="min-h-14 text-[28px] font-extrabold tracking-[.5em] max-w-[280px]"
            />
          </div>
          <Button
            variant="ghost"
            onClick={() => {
              /* resend is a no-op in the prototype */
            }}
            className="self-start pl-0"
          >
            Resend code in 0:24
          </Button>
        </>
      )}

      <span className="text-xs text-neutral-700">
        By continuing you agree to our Terms and Privacy policy.
      </span>
    </>
  );
}
