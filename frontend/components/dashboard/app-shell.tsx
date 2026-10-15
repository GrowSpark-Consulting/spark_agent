"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Role } from "@pakka/types";
import { useEffect, useRef, type ReactNode } from "react";
import { logout } from "@/lib/auth/actions";
import { packLabel } from "@/lib/format";

/** Who is signed in, and their business; `business` is null only in the development no-business view. */
export interface ShellIdentity {
  email: string | null;
  business: { name: string; vertical: string; role: Role } | null;
}

const NAV = [
  { href: "/dashboard", label: "Home", d: "M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10" },
  { href: "/dashboard/inbox", label: "Inbox", d: "M7.9 20A9 9 0 1 0 4 16.1L2 22z" },
  { href: "/dashboard/leads", label: "Leads", d: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M9 3v18 M15 3v18" },
  { href: "/dashboard/calendar", label: "Calendar", d: "M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M16 2v4 M8 2v4 M3 10h18" },
  { href: "/dashboard/features", label: "Features", d: "M8 6h8a6 6 0 0 1 0 12H8A6 6 0 0 1 8 6z M16 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4z" },
  { href: "/dashboard/agent", label: "Agent settings", d: "M4 6h16 M4 12h16 M4 18h16 M9 3v6 M15 9v6 M8 15v6" },
  { href: "/dashboard/billing", label: "Billing", d: "M2 6h20v12H2z M2 10h20 M6 15h4" },
  { href: "/dashboard/knowledge", label: "Knowledge base", d: "M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" },
  { href: "/dashboard/settings/booking", label: "Booking setup", d: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 6v6l4 2" },
  { href: "/dashboard/settings/privacy", label: "Data & privacy", d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" },
  { href: "/dashboard/settings/integrations", label: "Integrations", d: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71 M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" },
  { href: "/dashboard/team", label: "Team", d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75" },
  { href: "/dashboard/messages/test", label: "Send test message", d: "M7.9 20A9 9 0 1 0 4 16.1L2 22z" },
  { href: "/dashboard/templates/new", label: "Create template", d: "M4 4h16v12H5.2L4 17.2z M8 8h8 M8 12h5" },
  { href: "/dashboard/whatsapp", label: "WhatsApp", d: "M5 2h14a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z M12 18h.01" },
  { href: "/dashboard/preview", label: "Dashboard preview", note: "Sample data", d: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M9 3v18" },
] as const;

const ROLE_LABEL = { owner: "Owner", admin: "Admin", staff: "Staff" } as const;

/** A section's own page and the pages under it (a lead under Leads); Home only for itself. */
function isCurrent(pathname: string, href: string): boolean {
  return pathname === href || (href !== "/dashboard" && pathname.startsWith(`${href}/`));
}

export function AppShell({ identity, children }: { identity: ShellIdentity; children: ReactNode }) {
  const { email, business } = identity;
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);

  // On phones the nav is a scrolling row; keep the current page's link in view. Scrolls the row itself:
  // scrollIntoView() would also move the browser's keyboard starting point to that link, so the first
  // Tab would skip "Skip to content", the logo and the current link.
  useEffect(() => {
    const nav = navRef.current;
    const current = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !current || nav.scrollWidth <= nav.clientWidth) return;
    const row = nav.getBoundingClientRect();
    const link = current.getBoundingClientRect();
    if (link.left < row.left) nav.scrollLeft += link.left - row.left;
    else if (link.right > row.right) nav.scrollLeft += link.right - row.right;
  }, [pathname]);

  return (
    <div className="app-root">
      <a href="#main" className="app-skip">
        Skip to content
      </a>
      <aside className="app-side">
        <Link href="/dashboard" className="app-brand">
          <span className="app-brand-mark" aria-hidden="true" />
          <span className="app-brand-name">Spark Agent</span>
        </Link>
        <div className="app-biz" data-testid="tenant-identity">
          {business ? (
            <>
              <div className="app-biz-name">{business.name}</div>
              <div className="app-biz-meta">
                {packLabel(business.vertical)} · {ROLE_LABEL[business.role]}
              </div>
            </>
          ) : (
            <>
              <div className="app-biz-name">No business yet</div>
              <div className="app-biz-meta">Development view · no business data</div>
            </>
          )}
        </div>
        <nav ref={navRef} className="app-nav" aria-label="Main">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="app-nav-link"
              aria-current={isCurrent(pathname, item.href) ? "page" : undefined}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={item.d} />
              </svg>
              <span className="app-nav-label">
                {item.label}
                {"note" in item ? <span className="app-nav-note">{item.note}</span> : null}
              </span>
            </Link>
          ))}
        </nav>
        <div className="app-user">
          <span className="app-user-email">{email}</span>
          <form action={logout}>
            <button type="submit" className="btn btn-secondary">
              Log out
            </button>
          </form>
        </div>
      </aside>
      {/* tabIndex -1: the skip link moves keyboard focus here, not just the scroll position. */}
      <main id="main" tabIndex={-1} className="app-main">
        {children}
      </main>
    </div>
  );
}
