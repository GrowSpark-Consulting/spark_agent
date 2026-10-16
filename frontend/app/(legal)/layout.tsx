// Root layout for the policy pages (/privacy, /terms, /data-deletion): public, no session, no dashboard shell. It shares the onboarding look.
import { Archivo } from "next/font/google";
import "@/styles/onboarding.css";

const archivo = Archivo({ subsets: ["latin", "latin-ext", "vietnamese"], weight: ["400", "600", "800"], display: "swap", variable: "--font-archivo" });

export default function LegalRootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={archivo.variable}>
      <body className="bg-background text-foreground font-sans antialiased">{children}</body>
    </html>
  );
}
