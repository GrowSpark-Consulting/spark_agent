import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ResetPasswordForm } from "@/components/dashboard/reset-password-form";
import { getAuth } from "@/lib/auth/session";
import "@/styles/app.css";

export const metadata: Metadata = { title: "Choose a new password · Spark Agent" };

// Where a reset link lands: /auth/callback has already signed the account in from the link. Without
// that session there is nothing to change, so the visitor asks for a new link.
export default async function ResetPasswordPage() {
  const { user } = await getAuth();
  if (!user) redirect("/forgot-password?error=link_expired");
  return (
    <main className="app-auth">
      <div className="app-auth-card">
        <Link href="/login" className="app-brand">
          <span className="app-brand-mark" aria-hidden="true" />
          <span className="app-brand-name">Spark Agent</span>
        </Link>
        <div>
          <h1 className="app-h1" style={{ fontSize: 34 }}>Choose a new password</h1>
          <p className="app-lede" style={{ fontSize: 15 }}>You&apos;ll use it to sign in from now on.</p>
        </div>
        <ResetPasswordForm />
      </div>
    </main>
  );
}
