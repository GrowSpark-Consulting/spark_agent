"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { destinationForUser } from "@/lib/auth/destination";
import { inviteNext, RESET_PASSWORD_PATH, safeNext } from "@/lib/auth/redirect";
import { getAuth, getSessionState, TENANT_COOKIE } from "@/lib/auth/session";
import { formatError } from "@/lib/errors";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface LoginState {
  error?: string;
  fields?: { email?: string; password?: string };
  email?: string;
}

const LoginInput = z.object({
  email: z.email("Enter a valid email address"),
  password: z.string().min(1, "Enter your password"),
});

export async function login(_prev: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get("email") ?? "").trim();
  const parsed = LoginInput.safeParse({ email, password: form.get("password") ?? "" });
  if (!parsed.success) {
    const fields: LoginState["fields"] = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as "email" | "password";
      fields[key] ??= issue.message;
    }
    return { fields, email };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error || !data.user) return { error: formatError(error).message, email };

  // An existing account: the dashboard, unless it still has no business (then onboarding).
  redirect(await destinationForUser(supabase, data.user, form.get("next")));
}

export interface SignupState {
  error?: string;
  fields?: { email?: string; password?: string; confirmPassword?: string };
  email?: string;
  /** Shown instead of the form: "check your email". Also used when the address is taken. */
  sent?: boolean;
}

// Supabase hashes passwords with bcrypt, which reads at most 72 bytes.
const NewPassword = z.string().min(8, "Use at least 8 characters").max(72, "Use 72 characters or fewer");
const passwordsMatch = { path: ["confirmPassword"], message: "Passwords don't match" };

const SignupInput = z
  .object({ email: z.email("Enter a valid email address"), password: NewPassword, confirmPassword: z.string() })
  .refine((v) => v.password === v.confirmPassword, passwordsMatch);

/**
 * The address this request came in on, for links Supabase sends people back to. Supabase only
 * redirects to URLs on its allow list, so a forged header can't send anyone off-site.
 */
async function appOrigin(): Promise<string> {
  const h = await headers();
  const origin = h.get("origin");
  if (origin && URL.canParse(origin)) return new URL(origin).origin;
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) throw new Error("Cannot work out the app's address for the sign-in link");
  return `${h.get("x-forwarded-proto") ?? "https"}://${host}`;
}

/** /auth/callback, which finishes Google sign-in and email confirmation links. */
async function callbackUrl(next: string): Promise<string> {
  return `${await appOrigin()}/auth/callback?next=${encodeURIComponent(next)}`;
}

export async function signup(_prev: SignupState, form: FormData): Promise<SignupState> {
  const email = String(form.get("email") ?? "").trim();
  const parsed = SignupInput.safeParse({
    email,
    password: form.get("password") ?? "",
    confirmPassword: form.get("confirmPassword") ?? "",
  });
  if (!parsed.success) {
    const fields: SignupState["fields"] = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as keyof NonNullable<SignupState["fields"]>;
      fields[key] ??= issue.message;
    }
    return { fields, email };
  }

  // Someone who followed an invitation continues to it, not to onboarding: accepting it gives them their business.
  const after = inviteNext(form.get("next")) ?? "/onboarding";
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: { emailRedirectTo: await callbackUrl(after) },
  });
  if (error) {
    // Same screen as a fresh signup, so the form can't be used to find out who has an account.
    if (error.code === "user_already_exists" || error.code === "email_exists") return { sent: true, email };
    return { error: formatError(error).message, email };
  }
  // A session means email confirmation is off: the new account goes straight to onboarding.
  if (data.session) redirect(after);
  return { sent: true, email };
}

export interface OAuthState {
  error?: string;
}

/** Starts "Continue with Google": Supabase sends the browser to Google, then to /auth/callback. */
export async function signInWithGoogle(_prev: OAuthState, form: FormData): Promise<OAuthState> {
  const next = safeNext(form.get("next"));
  const supabase = await createSupabaseServerClient();
  // Stores the PKCE code verifier in a cookie; /auth/callback needs it to exchange the code.
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: await callbackUrl(next) },
  });
  if (error || !data.url) return { error: formatError(error).message };
  redirect(data.url);
}

export interface ResetRequestState {
  error?: string;
  fields?: { email?: string };
  email?: string;
  /** Shown instead of the form: "check your email", whether or not the address has an account. */
  sent?: boolean;
}

/** "Forgot password": Supabase emails a reset link that comes back through /auth/callback. */
export async function requestPasswordReset(_prev: ResetRequestState, form: FormData): Promise<ResetRequestState> {
  const email = String(form.get("email") ?? "").trim();
  const parsed = z.email("Enter a valid email address").safeParse(email);
  if (!parsed.success) return { fields: { email: parsed.error.issues[0]?.message }, email };

  const supabase = await createSupabaseServerClient();
  // Stores a PKCE code verifier marked as a recovery; /auth/callback needs it to exchange the code.
  // Supabase answers the same way for addresses without an account, so this reveals nothing.
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data, { redirectTo: await callbackUrl(RESET_PASSWORD_PATH) });
  if (error) return { error: formatError(error).message, email };
  return { sent: true, email };
}

export interface NewPasswordState {
  error?: string;
  fields?: { password?: string; confirmPassword?: string };
}

const NewPasswordInput = z
  .object({ password: NewPassword, confirmPassword: z.string() })
  .refine((v) => v.password === v.confirmPassword, passwordsMatch);

/** The form a reset link opens: sets the signed-in account's new password, then into the app. */
export async function updatePassword(_prev: NewPasswordState, form: FormData): Promise<NewPasswordState> {
  const parsed = NewPasswordInput.safeParse({ password: form.get("password") ?? "", confirmPassword: form.get("confirmPassword") ?? "" });
  if (!parsed.success) {
    const fields: NewPasswordState["fields"] = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as keyof NonNullable<NewPasswordState["fields"]>;
      fields[key] ??= issue.message;
    }
    return { fields };
  }

  const { supabase, user } = await getAuth();
  if (!user) redirect("/forgot-password?error=link_expired");
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) return { error: formatError(error).message };
  redirect(await destinationForUser(supabase, user, null));
}

export async function logout(): Promise<void> {
  const { supabase } = await getAuth();
  await supabase.auth.signOut();
  (await cookies()).delete(TENANT_COOKIE);
  redirect("/login");
}

/** Remembers which business to open. Only stored if the user is a member (checked through RLS). */
export async function chooseTenant(form: FormData): Promise<void> {
  const tenantId = String(form.get("tenantId") ?? "");
  const state = await getSessionState();
  if (state.status === "signed_out") redirect("/login");
  const memberships = state.status === "no_membership" ? [] : state.memberships;
  if (memberships.some((m) => m.tenantId === tenantId)) {
    (await cookies()).set(TENANT_COOKIE, tenantId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
  }
  redirect("/dashboard");
}
