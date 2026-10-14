import { z } from "zod";

// Vertical pack file format (packs/*.json). Covers every shape in docs/handover.md. Cross-checks
// that need the whole pack (a scoring rule naming a field the pack lacks, bookingType to
// bookingModes) belong in the loader, which warns instead of failing.

const snakeKey = z.string().regex(/^[a-z][a-z0-9_]*$/, "must be lower snake_case");

export const PackFieldType = z.enum([
  "text",
  "int",
  "boolean",
  "enum",
  "range_inr",
  "date_range_or_month",
]);

export const PackField = z
  .strictObject({
    key: snakeKey,
    label: z.string().min(1),
    type: PackFieldType,
    required: z.boolean().default(false),
    options: z.array(z.string().min(1)).min(1).optional(),
  })
  .refine((f) => f.type !== "enum" || f.options !== undefined, {
    message: "enum fields need options",
    path: ["options"],
  });
export type PackField = z.infer<typeof PackField>;

const Scalar = z.union([z.string(), z.number(), z.boolean()]);

export const ScoringRule = z
  .strictObject({
    field: snakeKey,
    points: z.int().min(0),
    match: z.string().optional(), // named matcher, e.g. within_project_band
    value: z.union([z.string(), z.number()]).optional(), // parameter for `match`
    equals: Scalar.optional(),
    in: z.array(Scalar).min(1).optional(),
    gte: z.number().optional(),
  })
  .refine((r) => [r.match, r.equals, r.in, r.gte].some((c) => c !== undefined), {
    message: "a rule needs one of match, equals, in or gte",
  });

export const HardFail = z
  .strictObject({
    field: snakeKey,
    below: z.union([z.string(), z.number()]).optional(),
    match: z.string().optional(),
  })
  .refine((h) => h.below !== undefined || h.match !== undefined, {
    message: "a hard fail needs below or match",
  });

export const Scoring = z.object({
  rules: z.array(ScoringRule),
  thresholds: z
    .strictObject({ hot: z.int().min(0), warm: z.int().min(0) })
    .refine((t) => t.hot > t.warm, { message: "hot must be above warm" }),
  hardFails: z.array(HardFail).default([]),
});

// Offsets are relative to an event anchor, never absolute: "-30m", "+2d".
export const PackReminder = z.strictObject({
  event: z.string().min(1),
  anchor: z.enum(["start", "end", "quote_sent"]),
  offset: z.string().regex(/^[+-]\d+[mhd]$/, "must look like -30m, +2d"),
  template: z.string().min(1),
  feature: z.string().optional(),
});

export const BookingMode = z.enum([
  "slot",
  "site_visit",
  "field_visit",
  "callback",
  "date_range",
  "quote",
]);

export const PackCatalog = z.strictObject({
  type: z.string().min(1),
  attributes: z.array(z.string()),
  matchOn: z.array(z.string()),
});

// Where the business works, for a pack that says so: the field that holds where the customer is (an area, a pincode) and the area matcher
// that judges it against the business's own catalog (`in_<x>_area` or `in_<x>_areas`, the same names scoring rules use). Optional: a pack
// published before it existed is read through its own area scoring rule instead, because a published version is never edited.
export const PackCoverage = z.strictObject({
  field: z.string().min(1),
  match: z.string().regex(/^in_[a-z][a-z0-9]*_areas?$/, "must be an area matcher such as in_project_areas"),
});

const stringList = z.array(z.string().min(1)).default([]);

export const PackDefinition = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]*$/, "must be lower kebab-case"),
  version: z.int().min(1),
  label: z.string().optional(),
  // Older packs use the single bookingType; the loader derives bookingModes from it.
  bookingType: z.string().min(1).optional(),
  bookingModes: z.array(BookingMode).min(1).optional(),
  catalog: PackCatalog.optional(),
  coverage: PackCoverage.optional(),
  fields: z.array(PackField).min(1),
  scoring: Scoring,
  reminders: z.array(PackReminder).default([]),
  feedback: PackReminder.optional(),
  handoffTriggers: stringList, // pack-specific strings are allowed, unlike HandoffTrigger
  templates: stringList,
  kbStarter: stringList,
  extraGuardrails: stringList,
});
export type PackDefinition = z.infer<typeof PackDefinition>;
