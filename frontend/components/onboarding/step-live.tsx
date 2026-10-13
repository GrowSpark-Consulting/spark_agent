"use client";

import { Button } from "@/components/ui/button";
import { ROUTES } from "@/features/onboarding/data";
import { bizLabel, industryKey, trialCodeOf, type OnboardingState } from "@/features/onboarding/state";

export function StepLive({ s }: { s: OnboardingState }) {
  const K = industryKey(s);
  const dashHref =
    ROUTES.dashboard + (K !== "fix" && K !== "re" ? "?industry=" + K : "");
  // Connected only when Connect with Facebook got an active connection back from the API; every other path (a preview,
  // a skip, a number that failed its checks) says not connected. The dashboard's WhatsApp page shows the real status.
  const connected = s.waConnection?.status === "active";
  const numStatus = connected ? "Connected" : "Not connected yet";
  // The real trial once it exists; the prototype's sample figures before that.
  const trialSummary = s.trial
    ? `${s.trial.trialDays} ${s.trial.trialDays === 1 ? "day" : "days"}` +
      (s.trial.credits === null ? "" : ` · ${s.trial.credits} credits`)
    : "7 days · 300 credits";

  return (
    <>
      <div className="bg-primary text-white p-[clamp(28px,5vw,48px)] flex flex-col gap-4">
        <span className="text-xs font-semibold tracking-[.1em] uppercase">
          {bizLabel(s)}
        </span>
        <h1 className="m-0 text-[clamp(48px,8vw,88px)] leading-[.95] tracking-[-0.035em]">
          You’re live.
        </h1>
        <p className="m-0 text-[17px] max-w-[480px]">
          Maya is answering WhatsApp enquiries for you right now, day and night.
        </p>
      </div>

      <div className="flex flex-col border-t-2 border-foreground">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-3 border-b border-divider text-[15px]">
          <span>Test number · code {trialCodeOf(s)}</span>
          <strong>Live</strong>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-3 border-b border-divider text-[15px]">
          <span>Your number {connected && s.waConnection?.displayPhone ? s.waConnection.displayPhone : `+91 ${s.phone}`}</span>
          <strong className={connected ? undefined : "text-brand-700"}>
            {numStatus}
          </strong>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-3 border-b border-divider text-[15px]">
          <span>Trial</span>
          <strong>{trialSummary}</strong>
        </div>
      </div>

      <Button
        asChild
        variant="primary"
        className="self-start text-[17px] px-[22px] py-3.5 min-w-[260px] justify-start"
      >
        <a href={dashHref}>Go to my dashboard</a>
      </Button>
    </>
  );
}
