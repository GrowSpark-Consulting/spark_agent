"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { INDUSTRIES, PROFILES } from "@/features/onboarding/data";
import type { OfferedTrade } from "@/features/onboarding/packs";
import { type OnboardingState, type SetState } from "@/features/onboarding/state";
import { StepIntro } from "@/components/onboarding/primitives";

/**
 * trades: the trades with an active pack, by their INDUSTRIES index (the index `s.ind` stores).
 * packsFailed: the active packs couldn't be read, so no trade is offered.
 */
export function StepBusiness({
  s,
  set,
  trades,
  packsFailed,
}: {
  s: OnboardingState;
  set: SetState;
  trades: OfferedTrade[];
  packsFailed: boolean;
}) {
  // The trade's sample business name is only a placeholder: the name becomes the real business's.
  const pickIndustry = (i: number) =>
    set(() => {
      const profile = PROFILES[INDUSTRIES[i].key];
      return {
        ind: i,
        staff: profile.staff.map((p) => ({ ...p })),
        trialError: null,
      };
    });
  const trialOpen = trades.some((t) => t.index === s.ind);

  return (
    <>
      <StepIntro title="Tell us about your business">
        We’ll set up questions and replies that suit your trade.
      </StepIntro>

      <div>
        <Label htmlFor="pk-biz">Business name</Label>
        <Input
          id="pk-biz"
          value={s.biz}
          placeholder={PROFILES[INDUSTRIES[s.ind]?.key ?? "re"].biz}
          onChange={(e) => set({ biz: e.target.value, trialError: null })}
          autoComplete="organization"
          className="min-h-12 text-[17px]"
        />
      </div>

      <div>
        <Label asChild>
          <span>What do you do?</span>
        </Label>
        {trades.length > 0 && (
          <div
            role="radiogroup"
            aria-label="What do you do?"
            className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,190px),1fr))] gap-2"
          >
            {trades.map(({ index: i, name }) => {
              const ind = INDUSTRIES[i];
              const selected = s.ind === i;
              return (
                <button
                  key={ind.key}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => pickIndustry(i)}
                  className={cn(
                    "flex flex-col gap-1 text-left p-4 min-h-24 border-2 text-foreground cursor-pointer hover:border-primary",
                    selected
                      ? "border-primary bg-brand-100"
                      : "border-divider bg-transparent"
                  )}
                >
                  <span className="font-extrabold text-base">{name}</span>
                  <span className="text-xs text-neutral-700">Books: {ind.books}</span>
                </button>
              );
            })}
          </div>
        )}
        {packsFailed ? (
          <p role="status" className="m-0 mt-2 text-sm text-brand-700">
            We couldn’t load the trades that are open. Reload the page to try again.
          </p>
        ) : trades.length === 0 ? (
          <p role="status" className="m-0 mt-2 text-sm text-brand-700">
            Trials aren’t open for any trade yet.
          </p>
        ) : (
          !trialOpen && (
            <p role="status" className="m-0 mt-2 text-sm text-brand-700">
              Trials for this trade aren’t open yet.
            </p>
          )
        )}
      </div>

      {s.trialError && (
        <div role="alert" className="border-2 border-primary bg-brand-100 text-brand-900 px-3.5 py-3 text-sm">
          {s.trialError}
        </div>
      )}
      {s.hasBusiness && (
        <p role="status" className="m-0 text-sm text-neutral-700">
          Your account already belongs to a business, so no new one was created.
        </p>
      )}
    </>
  );
}
