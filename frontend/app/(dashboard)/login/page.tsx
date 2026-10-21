import type { Metadata } from "next";
import Link from "next/link";
import { GoogleButton } from "@/components/dashboard/google-button";
import { LoginForm } from "@/components/dashboard/login-form";
import { ErrorState } from "@/components/shared/states";
import { authLinkErrorMessage } from "@/lib/auth/redirect";
import "@/styles/app.css";

export const metadata: Metadata = { title: "Sign in · Spark Agent" };

// Existing accounts. Opening this page never decides where anyone belongs, even with a session
// already in place: signing in (password or Google) does, in lib/auth/actions.ts and
// app/auth/callback/route.ts.
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { next, error } = await searchParams;
  const linkError = authLinkErrorMessage(error);
  return (
    <main className="app-auth">
      <div className="app-auth-card">
        <Link href="/login" className="app-brand">
          <span className="app-brand-mark" aria-hidden="true" />
          <span className="app-brand-name">Spark Agent</span>
        </Link>
        <div>
          <h1 className="app-h1" style={{ fontSize: 34 }}>Sign in</h1>
          <p className="app-lede" style={{ fontSize: 15 }}>Use the email and password for your business account.</p>
        </div>
        {linkError ? <ErrorState compact title="Couldn't sign you in" description={linkError} /> : null}
        <LoginForm next={typeof next === "string" ? next : undefined} />
        <p className="app-hint" style={{ fontSize: 14, margin: 0 }}>
          <Link href="/forgot-password">Forgot password?</Link>
        </p>
        <p className="app-hint" style={{ fontSize: 14, margin: 0 }}>Or</p>
        <GoogleButton next={typeof next === "string" ? next : undefined} />
        <p className="app-hint" style={{ fontSize: 14 }}>
          Don&apos;t have an account? <Link href="/signup">Sign up</Link>
        </p>
      </div>
    </main>
  );
}
