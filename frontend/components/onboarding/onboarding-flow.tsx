"use client";

import * as React from "react";
import Link from "next/link";
import Image from "next/image";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CHECKS, ROUTES, STEP_LABELS, TOTAL_STEPS, type CheckKind } from "@/features/onboarding/data";
import { offeredTrades, type ActivePack, type OfferedTrade } from "@/features/onboarding/packs";
import {
  industryKey,
  phoneProblem,
  trialPhoneOf,
  initialState,
  plannedFailure,
  waitHiIndex,
  type OnboardingState,
  type Patch,
} from "@/features/onboarding/state";
import { startTrial } from "@/lib/onboarding/trial";
import { StepVerifyPhone } from "@/components/onboarding/step-verify-phone";
import { StepBusiness } from "@/components/onboarding/step-business";
import { StepTeach } from "@/components/onboarding/step-teach";
import { StepTry } from "@/components/onboarding/step-try";
import { StepWhatsApp } from "@/components/onboarding/step-whatsapp";
import { StepTeam } from "@/components/onboarding/step-team";
import { StepLive } from "@/components/onboarding/step-live";

const CHECK_TICK_MS = 650;

/** Starts on the default trade if it is offered, otherwise on the first offered one, with its profile. */
function initialStateFor(trades: OfferedTrade[]): OnboardingState {
  if (trades.length === 0 || trades.some((t) => t.index === initialState.ind)) return initialState;
  return { ...initialState, ind: trades[0].index };
}

/** activePacks: the active vertical packs, or null when they couldn't be read (no trade is offered). */
export function OnboardingFlow({ activePacks }: { activePacks: ActivePack[] | null }) {
  const trades = React.useMemo(() => offeredTrades(activePacks ?? []), [activePacks]);
  const [s, setRaw] = React.useState<OnboardingState>(() => initialStateFor(trades));
  const tradeOffered = trades.some((t) => t.index === s.ind);

  /** Class-style setState: shallow-merge a patch or an updater's result. */
  const set = React.useCallback((patch: Patch) => {
    setRaw((prev) => ({
      ...prev,
      ...(typeof patch === "function" ? patch(prev) : patch),
    }));
  }, []);

  /* ── Connection checks: one row every 650ms; may fail or wait for “hi” ── */
  React.useEffect(() => {
    if (s.wa !== "checking" || s.chkFail >= 0 || s.waitHi) return;
    const t = window.setTimeout(() => {
      set((x) => {
        if (x.wa !== "checking") return {};
        const list = CHECKS[x.chkKind];
        const n = x.chkStep;
        if (n === x.chkPlannedFail) return { chkFail: n };
        if (n === waitHiIndex(x.chkKind)) return { waitHi: true };
        if (n + 1 >= list.length) return { chkStep: list.length, wa: "live" };
        return { chkStep: n + 1 };
      });
    }, CHECK_TICK_MS);
    return () => window.clearTimeout(t);
  }, [s.wa, s.chkStep, s.chkFail, s.waitHi, s.chkRun, set]);

  const startChecks = React.useCallback(
    (kind: CheckKind) => {
      set((x) => ({
        wa: "checking",
        chkKind: kind,
        chkStep: 0,
        chkFail: -1,
        waitHi: false,
        chkPlannedFail: plannedFailure(kind, x),
        chkRun: x.chkRun + 1,
      }));
    },
    [set]
  );

  /* ── Business step: the API creates the trial business (or finds the account's business) ── */
  const [savingBusiness, startSavingBusiness] = React.useTransition();
  const submitBusiness = () => {
    if (!tradeOffered) return;
    startSavingBusiness(async () => {
      const result = await startTrial({ name: s.biz, industry: industryKey(s), phone: trialPhoneOf(s) });
      if (result.status === "ready") {
        set({ trial: result.trial, hasBusiness: false, trialError: null, step: 2 });
      } else if (result.status === "has_business") {
        set({ hasBusiness: true, trialError: null, step: 2 });
      } else {
        set({
          trialError:
            result.status === "unavailable"
              ? "Trials for this trade aren’t open yet."
              : result.status === "invalid"
                ? (result.fields.name ?? result.fields.industry ?? result.fields.phone ?? "Check your business details.")
                : result.message,
        });
        return;
      }
      window.scrollTo?.(0, 0);
    });
  };

  /* ── Wizard navigation ── */
  const st = s.step;
  const inSteps = st < TOTAL_STEPS;

  const nextOff =
    (st === 0 && (!!phoneProblem(s) || (s.otpSent && s.otp.length < 6))) ||
    (st === 1 && (!s.biz.trim() || !tradeOffered || savingBusiness));

  const nextLabel =
    st === 0
      ? s.otpSent
        ? "Verify and continue"
        : "Send code on WhatsApp"
      : st === 1 && savingBusiness
        ? "Setting up…"
        : st === 3
          ? "I’ve tried it"
          : st === 4
            ? s.waConnection?.status === "active"
              ? "Continue"
              : s.wa === "idle"
              ? "Do this later"
              : s.wa === "pending"
                ? "Continue while we wait"
                : "Continue"
            : st === 5
              ? "Go live"
              : "Continue";

  const next = () => {
    if (st === 0 && !s.otpSent) {
      set({ otpSent: true });
      return;
    }
    if (st === 1) {
      submitBusiness();
      return;
    }
    set({ step: st + 1 });
    window.scrollTo?.(0, 0);
  };
  const back = () => set({ step: st - 1 });
  const skip = () => set({ step: st + 1 });

  return (
    <div
      data-screen-label="02 Onboarding"
      className="min-h-screen flex flex-col text-foreground font-sans"
    >
      {/* ── Header ── */}
      <header className="flex items-center gap-4 py-3.5 px-[clamp(16px,4vw,40px)] border-b-2 border-divider">
        <Link
          href={ROUTES.landing}
          className="flex items-center gap-2.5 text-foreground no-underline mr-auto hover:text-foreground"
        >
          <Image src="/spark-agent-logo.png" alt="" aria-hidden width={26} height={26} className="block size-[26px]" />
          <span className="font-extrabold text-lg">Spark Agent</span>
        </Link>
        {inSteps && (
          <span className="text-[13px] font-semibold">
            Step {st + 1} of {TOTAL_STEPS}
          </span>
        )}
      </header>

      {/* ── Progress ── */}
      {inSteps && (
        <ol
          aria-label="Onboarding progress"
          className="m-0 list-none grid grid-cols-6 gap-[3px] pt-4 px-[clamp(16px,4vw,40px)] pb-0"
        >
          {STEP_LABELS.map((label, i) => (
            <li
              key={label}
              aria-current={i === st ? "step" : undefined}
              className="flex flex-col gap-1.5 min-w-0"
            >
              <span
                className={cn("block h-1.5", i <= st ? "bg-primary" : "bg-neutral-300")}
              />
              <span
                className={cn(
                  "text-[11px] whitespace-nowrap overflow-hidden text-ellipsis",
                  i === st ? "font-extrabold text-foreground" : "font-normal text-neutral-700"
                )}
              >
                {label}
              </span>
            </li>
          ))}
        </ol>
      )}

      {/* ── Body ── */}
      <main className="flex-1 py-[clamp(28px,5vw,56px)] px-[clamp(16px,4vw,40px)] flex flex-col">
        <div className="max-w-[680px] w-full flex flex-col gap-6">
          {st === 0 && <StepVerifyPhone s={s} set={set} />}
          {st === 1 && <StepBusiness s={s} set={set} trades={trades} packsFailed={activePacks === null} />}
          {st === 2 && <StepTeach />}
          {st === 3 && <StepTry s={s} />}
          {st === 4 && (
            <StepWhatsApp s={s} set={set} onRunChecks={startChecks} />
          )}
          {st === 5 && <StepTeam s={s} />}
          {st === 6 && <StepLive s={s} />}

          {/* ── Footer nav ── */}
          {inSteps && (
            <div className="flex gap-2.5 items-center pt-4 border-t-2 border-divider flex-wrap">
              <Button
                variant="primary"
                onClick={next}
                disabled={nextOff}
                className="text-base px-[18px] py-3 min-w-[200px] justify-start"
              >
                {nextLabel}
              </Button>
              {st > 0 && (
                <Button
                  variant="secondary"
                  onClick={back}
                  disabled={savingBusiness}
                  className="text-base px-[18px] py-3"
                >
                  Back
                </Button>
              )}
              {st === 3 && (
                <Button variant="ghost" onClick={skip}>
                  Skip for now
                </Button>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
