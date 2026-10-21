// Root layout for the team invitation page (/invite/:token): public to read, no dashboard shell. It shares the onboarding look.
import type { Metadata } from "next";
import { Archivo } from "next/font/google";
import "@/styles/onboarding.css";

const archivo = Archivo({ subsets: ["latin", "latin-ext", "vietnamese"], weight: ["400", "600", "800"], display: "swap", variable: "--font-archivo" });

// The link is a credential: keep it out of search indexes and referrers.
export const metadata: Metadata = { title: "Spark Agent — Join your team", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default function InviteRootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={archivo.variable}>
      <body className="bg-background text-foreground font-sans antialiased">{children}</body>
    </html>
  );
}
