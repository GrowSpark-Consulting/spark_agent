import Link from "next/link";
import type { Block, Inline } from "@/lib/legal/markdown";
import type { LegalDocument } from "@/lib/legal/documents";

// Shell and renderer for a policy page (/privacy, /terms, /data-deletion). Public, no session, server-rendered.
// The footer repeats the effective date and the contact details from the policy text so they are always at the bottom.
const CONTACT = {
  name: "Grow Spark Consulting",
  address: "No. F2, Plot 1B, MG Nagar II, Urapakkam, Chennai - 603 211, India",
  email: "admin@growsparkconsulting.com",
  phone: "+91 63814 61106",
};

function Inlines({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.kind) {
          case "text":
            return n.text;
          case "bold":
            return <strong key={i} className="font-semibold"><Inlines nodes={n.children} /></strong>;
          case "code":
            return <code key={i} className="font-mono text-[0.9em] break-words">{n.text}</code>;
          case "link":
            return <a key={i} href={n.href} className="underline">{n.text}</a>;
          case "br":
            return <br key={i} />;
        }
      })}
    </>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "h1":
      return null; // the title is rendered by the page, above the text
    case "h2":
      return <h2 className="mt-10 mb-3 text-2xl"><Inlines nodes={block.children} /></h2>;
    case "p":
      return <p className="mb-4 break-words"><Inlines nodes={block.children} /></p>;
    case "ul":
      return (
        <ul className="mb-4 list-disc space-y-2 pl-6">
          {block.items.map((item, i) => <li key={i} className="break-words"><Inlines nodes={item} /></li>)}
        </ul>
      );
  }
}

export function LegalPage({ doc }: { doc: LegalDocument }) {
  return (
    <>
      <header className="mx-auto w-full max-w-3xl px-4 pt-8 sm:px-6">
        <Link href="/" className="text-sm font-extrabold no-underline">Spark Agent</Link>
      </header>
      <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
        <article>
          <h1 className="mb-6 text-4xl sm:text-5xl">{doc.title}</h1>
          {doc.blocks.map((block, i) => <BlockView key={i} block={block} />)}
        </article>
      </main>
      <footer className="mx-auto w-full max-w-3xl px-4 pb-14 text-sm text-muted-foreground sm:px-6">
        <div className="border-t border-divider pt-6">
          <p className="mb-1"><span className="font-semibold">Effective date:</span> {doc.effectiveDate}</p>
          <p className="mb-0">
            <span className="font-semibold">Contact:</span> {CONTACT.name}, {CONTACT.address} ·{" "}
            <a href={`mailto:${CONTACT.email}`}>{CONTACT.email}</a> · <a href={`tel:${CONTACT.phone.replace(/\s/g, "")}`}>{CONTACT.phone}</a>
          </p>
        </div>
      </footer>
    </>
  );
}
