"use client";

import * as React from "react";
import type { FeatureList, Role } from "@pakka/types";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { featureService, isFeatureApiMissing } from "@/features/toggles/feature-api";
import { FEATURES, featureDescription } from "@/features/onboarding/data";
import { describeSaveError, PartialFeatureError, setWizardFeature, viewOf, WIZARD_FEATURES } from "@/features/onboarding/persistence";
import { profileOf, type OnboardingState } from "@/features/onboarding/state";
import { resolveBrowserTenant } from "@/lib/api/tenant";
import { formatError } from "@/lib/errors";
import { RuleHeading, StepIntro } from "@/components/onboarding/primitives";

// The Team step. What the assistant does is real: the switches show the business's saved feature switches (GET /api/features) and each
// press is saved at once (PATCH /api/features/:key, owner or admin), so a refresh or a return to the wizard shows the same thing and a
// switch never looks saved before the server says so. Staff and the calendar are not set up here: inviting staff has no API yet, and
// Google Calendar connects per staff member or resource from Booking setup, so the step says that instead of showing sample people.

type Load =
  | { status: "loading" }
  | { status: "none"; message: string }
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; tenantId: string; role: Role; list: FeatureList };

export function StepTeam({ s }: { s: OnboardingState }) {
  const profile = profileOf(s);
  const [load, setLoad] = React.useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = React.useState(0);
  // One request at a time; a ref too, because state updates after the click.
  const [busy, setBusy] = React.useState<number | null>(null);
  const lock = React.useRef(false);
  const [rowError, setRowError] = React.useState<{ index: number; message: string } | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    (async () => {
      const tenant = await resolveBrowserTenant();
      if (controller.signal.aborted) return;
      if (tenant.status === "no_business") return setLoad({ status: "none", message: "Your business isn’t set up yet, so there is nothing to switch on. Go back to the Business step first." });
      if (tenant.status === "signed_out") return setLoad({ status: "none", message: "Your session has ended. Sign in again to see these switches." });
      if (tenant.status === "choose") return setLoad({ status: "none", message: "Your account belongs to more than one business. Choose one from your dashboard, then change these in Features." });
      if (tenant.status === "error") return setLoad({ status: "error", message: "We couldn’t load your business. Try again in a moment." });
      try {
        const list = await featureService.load(tenant.tenantId, controller.signal);
        if (!controller.signal.aborted) setLoad({ status: "ready", tenantId: tenant.tenantId, role: tenant.role, list });
      } catch (err) {
        if (controller.signal.aborted) return;
        setLoad(isFeatureApiMissing(err) ? { status: "missing" } : { status: "error", message: formatError(err).message });
      }
    })().catch(() => {});
    return () => controller.abort();
  }, [attempt]);

  const toggle = async (index: number, wantOn: boolean) => {
    if (load.status !== "ready" || lock.current) return;
    lock.current = true;
    setBusy(index);
    setRowError(null);
    const spec = WIZARD_FEATURES[index];
    try {
      const result = await setWizardFeature(load.tenantId, load.list, spec, load.role, wantOn);
      setLoad({ ...load, list: result.list });
    } catch (err) {
      // The list the server holds now (some rows may have changed before one failed); the switch shows that, not what was pressed.
      if (err instanceof PartialFeatureError) setLoad({ ...load, list: err.list });
      setRowError({ index, message: describeSaveError(err, spec, load.list) });
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };

  const retry = () => {
    setLoad({ status: "loading" });
    setAttempt((n) => n + 1);
  };

  return (
    <>
      <StepIntro title="Team, calendar and features">
        Who meets customers, when they’re free, and what your assistant should do.
      </StepIntro>

      <section className="flex flex-col gap-2">
        <RuleHeading>Your team</RuleHeading>
        <div className="flex flex-col gap-1.5 text-sm bg-surface p-4" data-testid="team-note">
          <strong>Alerts reach you first</strong>
          <span className="text-neutral-700">
            Adding teammates and choosing who gets which alert is done from Team once you’re live. Inviting staff isn’t switched on yet, so nobody is added here.
          </span>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <RuleHeading>Calendar</RuleHeading>
        <div className="flex flex-col gap-1.5 text-sm bg-surface p-4" data-testid="calendar-note">
          <strong>Calendar and working hours</strong>
          <span className="text-neutral-700">
            Connect Google Calendar for each staff member, and set working hours, in Booking setup once you’re live. Until then your business hours apply and nothing is connected.
          </span>
        </div>
      </section>

      <section className="flex flex-col" aria-busy={load.status === "loading" || undefined}>
        <RuleHeading>What your assistant does</RuleHeading>
        {load.status === "loading" ? (
          <p role="status" data-testid="features-loading" className="m-0 py-3 text-sm text-neutral-700">
            Loading your saved choices…
          </p>
        ) : null}
        {load.status === "none" ? (
          <p role="status" data-testid="features-none" className="m-0 py-3 text-sm text-neutral-700">
            {load.message}
          </p>
        ) : null}
        {load.status === "missing" ? (
          <p role="status" data-testid="features-missing" className="m-0 py-3 text-sm text-neutral-700">
            Feature switches aren’t available on this server yet. Nothing was changed. You can set them later in Features.
          </p>
        ) : null}
        {load.status === "error" ? (
          <div role="alert" data-testid="features-error" className="border-2 border-foreground p-4 text-sm flex flex-col gap-2 my-2">
            <strong>Couldn’t load your saved choices</strong>
            <span className="text-neutral-700">{load.message}</span>
            <Button variant="secondary" onClick={retry} className="self-start">
              Try again
            </Button>
          </div>
        ) : null}
        {load.status === "ready"
          ? FEATURES.map((f, i) => {
              const view = viewOf(load.list, WIZARD_FEATURES[i], load.role);
              if (view.kind === "missing") return null;
              const saving = busy === i;
              return (
                <div key={f.name} data-testid="wizard-feature" data-feature={WIZARD_FEATURES[i].keys[0]} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 items-center py-3 border-b border-divider">
                  <span>
                    <strong className="text-[15px]">{f.name}</strong>
                    <span className="block text-[13px] text-neutral-700">{featureDescription(i, profile)}</span>
                    {view.kind === "fixed" ? (
                      <span className="block text-[13px] text-neutral-700" data-testid="feature-why">
                        {view.why}
                      </span>
                    ) : null}
                    {saving ? (
                      <span role="status" className="block text-[13px] text-neutral-700">
                        Saving…
                      </span>
                    ) : null}
                    {rowError?.index === i ? (
                      <span role="alert" data-testid="feature-error" className="block text-[13px] text-brand-700">
                        {rowError.message}
                      </span>
                    ) : null}
                  </span>
                  <Switch
                    checked={view.checked}
                    aria-label={f.name}
                    disabled={view.kind === "fixed" || busy !== null}
                    aria-busy={saving || undefined}
                    onCheckedChange={(next) => void toggle(i, next)}
                  />
                </div>
              );
            })
          : null}
        <span className="text-[13px] text-neutral-700 mt-2">Each switch is saved as soon as you press it. You can change any of these later in Features.</span>
      </section>
    </>
  );
}
