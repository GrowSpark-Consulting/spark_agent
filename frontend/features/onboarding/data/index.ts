/* Mock data for the Spark Agent onboarding prototype. Content is copied verbatim
   from the original design; only the shape changed (tuples → typed objects). */

import { TRIAL_PACKS, type IndustryKey } from "@pakka/types";

export const TRIAL_CODE = "TRIAL-7F3K";

/** The WhatsApp test chat, with a trial code as the first message. */
export const trialChatUrl = (code: string) => `https://wa.me/919000000000?text=${encodeURIComponent(code)}`;

export const ROUTES = {
  landing: "/",
  dashboard: "/dashboard",
} as const;
export const TOTAL_STEPS = 6;

export const STEP_LABELS = [
  "Verify phone",
  "Business",
  "Teach",
  "Try it",
  "WhatsApp",
  "Team & go live",
] as const;

/** The trade keys and their packs are shared with the API (@pakka/types, onboarding.ts). */
export type { IndustryKey };

export interface Industry {
  key: IndustryKey;
  name: string;
  books: string;
  /**
   * The vertical pack a trial business in this trade runs on (TRIAL_PACKS). Trades without one can't
   * start a trial yet. Shown here only to open the button; the API maps the trade to its pack.
   */
  packKey?: string;
}

const TRADES: Omit<Industry, "packKey">[] = [
  { key: "re", name: "Real estate", books: "site visits" },
  { key: "int", name: "Interior design", books: "site measurements" },
  { key: "salon", name: "Salon", books: "appointments" },
  { key: "hotel", name: "Hotel", books: "room bookings" },
  { key: "rest", name: "Restaurant", books: "table bookings" },
  { key: "fix", name: "Plumber / Electrician", books: "technician visits" },
];

export const INDUSTRIES: Industry[] = TRADES.map((t) => {
  const packKey = TRIAL_PACKS[t.key];
  return packKey ? { ...t, packKey } : t;
});

export interface Service {
  name: string;
  detail: string;
  price: string;
}

export interface Faq {
  q: string;
  a: string;
}

export interface StaffMember {
  name: string;
  initials: string;
  phone: string;
  role: string;
}

export interface IndustryProfile {
  biz: string;
  site: string;
  svcTitle: string;
  noun: string;
  services: Service[];
  faqs: Faq[];
  tryAsk: string;
  staff: StaffMember[];
  email: string;
  /** Feature descriptions that change per trade */
  qualify: string;
  booking: string;
  reminders: string;
  feedback: string;
}

const svc = (name: string, detail: string, price: string): Service => ({
  name,
  detail,
  price,
});
const faq = (q: string, a: string): Faq => ({ q, a });
const person = (
  name: string,
  initials: string,
  phone: string,
  role: string
): StaffMember => ({ name, initials, phone, role });

const REAL_ESTATE_FAQS: Faq[] = [
  faq("Is Aster RERA approved?", "Yes, TN/29/Building/0412/2024."),
  faq("Which banks give loans?", "SBI, HDFC, ICICI and LIC HFL."),
  faq("What is the booking advance?", "₹2 lakh, adjusted against the first payment."),
  faq("Is car parking included?", "One covered car park with every home."),
  faq("Site visit timings?", "Mon–Sat 9:30 am – 7 pm. Sunday on request."),
  faq("Do you have villas on ECR?", "Not right now. Greens Villas in Porur is closest."),
];

export const PROFILES: Record<IndustryKey, IndustryProfile> = {
  re: {
    biz: "Skyline Homes",
    site: "skylinehomes.in",
    svcTitle: "Projects & prices",
    noun: "projects and prices",
    services: [
      svc("Skyline Aster", "Velachery · 3BHK", "₹88 L – ₹1.02 Cr"),
      svc("Skyline Meadows", "OMR · 2 & 3BHK", "₹62 L – ₹1.1 Cr"),
      svc("Skyline Greens", "Porur · 2 & 3BHK", "₹70 – 96 L"),
      svc("Greens Villas", "Porur · 4BHK", "₹1.6 – 1.9 Cr"),
    ],
    faqs: REAL_ESTATE_FAQS,
    tryAsk: "“3BHK Velachery la irukka?” or “Saturday site visit possible?”",
    staff: [
      person("Ramesh", "RA", "+91 99620 xxx45", "Sales"),
      person("Divya", "DI", "+91 97890 xxx72", "Sales"),
    ],
    email: "arun@skylinehomes.in",
    qualify: "Asks budget, area and timeline",
    booking: "Offers free slots and books visits",
    reminders: "24 hours and 2 hours before visits",
    feedback: "Asks for a rating after the visit",
  },
  int: {
    biz: "Nest Interiors",
    site: "nestinteriors.in",
    svcTitle: "Packages & prices",
    noun: "packages and prices",
    services: [
      svc("Essential 2BHK", "Kitchen, wardrobes, TV unit", "₹4.5 – 6 L"),
      svc("Complete 2BHK", "Full home + ceiling", "₹7.5 – 9 L"),
      svc("Complete 3BHK", "Full home + ceiling", "₹10 – 13 L"),
      svc("Modular kitchen", "Any home", "₹1.8 – 3.5 L"),
    ],
    faqs: [
      faq("Is the 3D design free?", "Yes, after a site measurement."),
      faq("What warranty do you give?", "10 years on modular work."),
      faq("Payment schedule?", "10% design, 50% production, 40% handover."),
      faq("Which materials?", "BWP ply for kitchens, soft-close hardware."),
      faq("Do you offer EMI?", "No-cost EMI up to 12 months."),
      faq("Do you do painting only?", "No, we take full interiors and kitchens."),
    ],
    tryAsk: "“2BHK full interiors evvalavu?” or “Measurement this Saturday?”",
    staff: [
      person("Arjun", "AJ", "+91 99620 xxx81", "Designer"),
      person("Nithya", "NI", "+91 97890 xxx09", "Designer"),
    ],
    email: "vikram@nestinteriors.in",
    qualify: "Asks scope, budget and handover date",
    booking: "Books site measurements and showroom visits",
    reminders: "24 hours and 2 hours before visits",
    feedback: "Asks for a rating after the visit",
  },
  salon: {
    biz: "Glow Studio",
    site: "glowstudio.in",
    svcTitle: "Services & prices",
    noun: "services and prices",
    services: [
      svc("HD bridal package", "Makeup, hair, draping", "₹24,000"),
      svc("Airbrush bridal", "Includes trial", "₹32,000"),
      svc("Keratin", "Shoulder length", "₹4,500 – ₹6,500"),
      svc("Gel nails", "Hands, 60 min", "₹1,200"),
    ],
    faqs: [
      faq("Do you do home service?", "Yes, within 15 km, ₹1,500 extra."),
      faq("Is the trial fee adjusted?", "Yes, when you book a package."),
      faq("Advance to block a date?", "₹5,000, refundable up to 30 days before."),
      faq("Which products?", "Fragrance-free professional ranges."),
      faq("Parking?", "Two-wheelers in front, cars on 2nd Avenue."),
      faq("Male stylists?", "Not right now."),
    ],
    tryAsk: "“Bridal makeup price?” or “Haircut today 5 pm free ah?”",
    staff: [
      person("Priya", "PR", "+91 99620 xxx18", "Senior stylist"),
      person("Kavya", "KA", "+91 97890 xxx64", "Stylist"),
    ],
    email: "kavitha@glowstudio.in",
    qualify: "Asks the service, occasion and date",
    booking: "Offers each stylist’s free slots",
    reminders: "24 hours and 2 hours before appointments",
    feedback: "Asks for a rating after the appointment",
  },
  hotel: {
    biz: "Hotel Kaveri",
    site: "hotelkaveri.in",
    svcTitle: "Rooms & rates",
    noun: "rooms and rates",
    services: [
      svc("Deluxe", "Sleeps 2 · breakfast", "₹3,200 a night"),
      svc("Heritage view", "Temple-view balcony", "₹4,500 a night"),
      svc("Family suite", "Sleeps 4 · two rooms", "₹5,400 a night"),
      svc("Banquet hall", "Up to 150 guests", "₹45,000 a day"),
    ],
    faqs: [
      faq("Check-in and checkout?", "12 noon and 11 am."),
      faq("How far is the Big Temple?", "1 km, about 5 minutes."),
      faq("Cancellation policy?", "Free up to 48 hours before check-in."),
      faq("Parking?", "Free, 30 cars and tour buses."),
      faq("Pets allowed?", "Sorry, no pets in rooms."),
      faq("Airport pickup?", "Trichy airport pickup ₹2,200."),
    ],
    tryAsk: "“Room for 4 on Saturday?” or “Family suite price?”",
    staff: [
      person("Manoj", "MA", "+91 99620 xxx27", "Front office"),
      person("Anjali", "AN", "+91 97890 xxx90", "Reservations"),
    ],
    email: "raghavan@hotelkaveri.in",
    qualify: "Asks dates, guests and room type",
    booking: "Checks availability and holds rooms",
    reminders: "Day before and morning of check-in",
    feedback: "Asks for a rating after checkout",
  },
  rest: {
    biz: "Amma’s Kitchen",
    site: "ammaskitchen.in",
    svcTitle: "Menu & packages",
    noun: "menu and prices",
    services: [
      svc("Full meals", "Veg, banana leaf", "₹280"),
      svc("Chettinad chicken meals", "Non-veg", "₹390"),
      svc("Party set menu A", "Min 15 guests", "₹650 a head"),
      svc("Home catering", "Min 50 plates", "From ₹350 a plate"),
    ],
    faqs: [
      faq("Parking?", "Valet from 7 pm."),
      faq("Jain food?", "Yes, tell us when booking."),
      faq("Private section size?", "Up to 40 guests."),
      faq("Advance for groups?", "20% for 15 or more."),
      faq("Kids’ menu?", "Yes, from ₹120."),
      faq("Outside cake allowed?", "Yes, ₹200 cutting charge."),
    ],
    tryAsk: "“Table for 6 tonight 8 pm?” or “Catering for 100 people?”",
    staff: [
      person("Selvi", "SE", "+91 99620 xxx14", "Manager"),
      person("Ravi", "RV", "+91 97890 xxx38", "Captain"),
    ],
    email: "murugan@ammaskitchen.in",
    qualify: "Asks party size, date and occasion",
    booking: "Offers free tables and books them",
    reminders: "Morning of, and 2 hours before",
    feedback: "Asks for a rating after the meal",
  },
  fix: {
    biz: "QuickFix Services",
    site: "quickfix.in",
    svcTitle: "Services & charges",
    noun: "services and charges",
    services: [
      svc("Visit charge", "Any job, Chennai", "₹199"),
      svc("Tap or leak repair", "Most jobs under 1 hour", "₹350 – ₹600"),
      svc("Fan or light fitting", "Per point", "₹250"),
      svc("Water heater service", "Includes descaling", "₹650"),
    ],
    faqs: [
      faq("Do you come on Sundays?", "Yes, 8 am – 6 pm."),
      faq("Is the visit charge adjusted?", "Yes, if you go ahead with the job."),
      faq("Warranty on work?", "30 days on labour."),
      faq("Do you bring parts?", "Common parts, charged at MRP."),
      faq("Areas covered?", "All of Chennai within the ORR."),
      faq("Emergency at night?", "Calls after 9 pm are ₹499."),
    ],
    tryAsk: "“Tap leaking, Adyar. Today possible?” or “Fan fitting charge?”",
    staff: [
      person("Senthil", "SE", "+91 99620 xxx52", "Technician"),
      person("Babu", "BA", "+91 97890 xxx31", "Technician"),
    ],
    email: "senthil@quickfix.in",
    qualify: "Asks the problem, area and urgency",
    booking: "Books technician visits in free slots",
    reminders: "Day before and 1 hour before the visit",
    feedback: "Asks for a rating after the job",
  },
};

/** Staff member appended by “+ Add staff” (every click adds the same row). */
export const NEW_STAFF: StaffMember = person(
  "Meera",
  "ME",
  "+91 98xxx xxxxx",
  "Front desk"
);

export interface Feature {
  name: string;
  /** Default description; trade-specific rows are swapped in by `featureDescription`. */
  description: string;
}

export const FEATURES: Feature[] = [
  { name: "AI auto-reply", description: "Answers new messages day and night" },
  { name: "Lead qualification", description: "Asks budget, area and timeline" },
  { name: "Booking in chat", description: "Offers free slots and books visits" },
  { name: "Reminders", description: "24 hours and 2 hours before visits" },
  { name: "Staff WhatsApp alerts", description: "Hot leads and handovers reach your team" },
  { name: "Feedback request", description: "Asks for a rating after the visit" },
];

export function featureDescription(index: number, profile: IndustryProfile) {
  const base = FEATURES[index].description;
  return [base, profile.qualify, profile.booking, profile.reminders, base, profile.feedback][index];
}

export function importStepTexts(site: string, profile: IndustryProfile) {
  return [
    "Reading " + site,
    "Finding " + profile.noun,
    "Collecting common questions",
    "Drafting replies in your tone",
  ];
}

/* ── WhatsApp connection ─────────────────────────────────────────────── */

export type WaMethod = "meta" | "manual";
export type ManualMode = "partner" | "own";
export type CheckKind = "meta" | ManualMode;
export type Coex = "yes" | "no";

export const WA_METHODS: {
  key: WaMethod;
  name: string;
  tag: string;
  description: string;
}[] = [
  {
    key: "meta",
    name: "Connect with Facebook",
    tag: "Recommended",
    description:
      "Log in with Facebook in a pop-up and confirm your number. About 3 minutes.",
  },
  {
    key: "manual",
    name: "Manual connection",
    tag: "Advanced",
    description:
      "Give Spark Agent partner access, or paste the details from your own Meta app.",
  },
];

export const COEX_OPTIONS: { key: Coex; name: string; description: string }[] = [
  {
    key: "yes",
    name: "Yes, keep the app working",
    description:
      "Your chats and contacts stay on your phone. The assistant replies through the same number.",
  },
  {
    key: "no",
    name: "No, it’s a new number or not on the app",
    description:
      "We’ll register it fresh. It can’t be used in the WhatsApp app afterwards.",
  },
];

export const MANUAL_MODES: { key: ManualMode; label: string }[] = [
  { key: "partner", label: "Partner access · recommended" },
  { key: "own", label: "Use my own Meta app" },
];

export interface CopyItem {
  label: string;
  /** Null until the real value exists; shown as not available, with nothing to copy. */
  value: string | null;
}

export const PARTNER_COPY: CopyItem[] = [
  // Filled from the API (META_PARTNER_BUSINESS_ID) when it is configured; null shows "not available".
  { label: "Spark Agent Business Portfolio ID", value: null },
];

export interface ConnectionCheck {
  title: string;
  /** Shown when this check fails */
  error?: string;
}

export const CHECKS: Record<CheckKind, ConnectionCheck[]> = {
  meta: [
    { title: "Secure code exchanged for a business token" },
    { title: "Spark Agent subscribed to your WhatsApp account" },
    { title: "Number registered with a secure PIN" },
    { title: "Display name and quality fetched" },
  ],
  partner: [
    {
      title: "We can see your WhatsApp account",
      error: "We don’t have access yet. Check step 2 and that you picked Full control.",
    },
    {
      title: "Phone number belongs to that account",
      error: "That phone number ID isn’t in this account.",
    },
    { title: "Spark Agent subscribed to your account" },
    { title: "Number registered" },
    { title: "Webhook reachable" },
  ],
  own: [
    {
      title: "Access token is valid",
      error: "Token is invalid or expired. Use a system user token set to never expire.",
    },
    {
      title: "Phone number belongs to that account",
      error: "That phone number ID isn’t in this account.",
    },
    { title: "Your app is subscribed to the account" },
    {
      title: "App secret saved for signature checks",
      error: "App secret is missing, so we can’t verify messages from Meta.",
    },
    { title: "Webhook reachable" },
  ],
};

/* ── Deterministic fake QR (25×25) ───────────────────────────────────── */

export const QR_SIZE = 25;

function buildQrCells(): boolean[] {
  const N = QR_SIZE;
  const cells: boolean[] = [];
  let seed = 7;
  const rnd = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const finder = (r: number, c: number): 0 | 1 | null => {
    for (const [fr, fc] of [
      [0, 0],
      [0, N - 7],
      [N - 7, 0],
    ]) {
      const y = r - fr;
      const x = c - fc;
      if (y >= 0 && y < 7 && x >= 0 && x < 7) {
        return y === 0 || y === 6 || x === 0 || x === 6 || (y >= 2 && y <= 4 && x >= 2 && x <= 4)
          ? 1
          : 0;
      }
      if (y >= -1 && y <= 7 && x >= -1 && x <= 7) return 0;
    }
    return null;
  };
  for (let r = 0; r < N; r++) {
    for (let x = 0; x < N; x++) {
      const f = finder(r, x);
      cells.push(f === null ? rnd() > 0.52 : f === 1);
    }
  }
  return cells;
}

/** true = dark module (#111), false = light (#fff) */
export const QR_CELLS = buildQrCells();
