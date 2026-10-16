import type { Metadata } from "next";
import Link from "next/link";
import { ForgotPasswordForm } from "@/components/dashboard/forgot-password-form";
import { ErrorState } from "@/components/shared/states";
import { authLinkErrorMessage } from "@/lib/auth/redirect";
import "@/styles/app.css";

export const metadata: Metadata = { title: "Forgot password · Spark Agent" };

// Asks Supabase to email a reset link. The link comes back through /auth/callback to /reset-password.
export default async function ForgotPasswordPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { error } = await searchParams;
  const linkError =
    error === "link_expired" ? "That reset link has expired or was already used. Enter your email to get a new one." : authLinkErrorMessage(error);
  return (
    <main className="app-auth">
      <div className="app-auth-card">
        <Link href="/login" className="app-brand">
          <span className="app-brand-mark" aria-hidden="true" />
          <span className="app-brand-name">Spark Agent</span>
        </Link>
        <div>
          <h1 className="app-h1" style={{ fontSize: 34 }}>Forgot password</h1>
          <p className="app-lede" style={{ fontSize: 15 }}>Enter your account&apos;s email and we&apos;ll send you a link to choose a new password.</p>
        </div>
        {linkError ? <ErrorState compact title="Couldn't open that link" description={linkError} /> : null}
        <ForgotPasswordForm />
        <p className="app-hint" style={{ fontSize: 14 }}>
          Remembered it? <Link href="/login">Sign in</Link>
        </p>
      </div>
    </main>
  );
}
