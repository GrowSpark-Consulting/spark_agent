import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scoreLead } from "../scoring/score";
import { fileSource, loadPack, PackError, resolvePack } from "./load";
import { readPackFiles, syncPacks, type PackStore } from "./sync";

// Day 7 PR D: the interiors and salon packs through the generic loader, and what their scoring can and cannot judge today.
// The packs are data (packs/*.json); the loader reads them by key and version and knows no industry. The second block pins
// KNOWN LIMITS of the scoring code as they are (scoring/score.ts is not changed here); see the task note of 15 Oct.

const PACKS_DIR = fileURLToPath(new URL("../../../../packs", import.meta.url));
const AGENT_DIR = fileURLToPath(new URL("..", import.meta.url));
const KEYS = ["interiors", "salon"] as const;

describe.each(KEYS)("the %s pack through the loader", (key) => {
  it("loads by key and version 1 from the pack file, with no warnings, and its fields build a lead schema", async () => {
    const loaded = await loadPack(fileSource(PACKS_DIR), key, 1);
    expect(loaded.pack.key).toBe(key);
    expect(loaded.pack.version).toBe(1);
    expect(loaded.warnings).toEqual([]);
    expect(Object.keys(loaded.fieldSchema.shape).sort()).toEqual(loaded.pack.fields.map((f) => f.key).sort());
  });

  it("refuses another version, and does not answer to a file name that is not a pack key", async () => {
    await expect(loadPack(fileSource(PACKS_DIR), key, 2)).rejects.toMatchObject({ code: "version_mismatch" });
    await expect(loadPack(fileSource(PACKS_DIR), `../${key}`, 1)).rejects.toMatchObject({ code: "not_found" });
  });

  it("is stored by the sync once, as an active row, and a second sync changes nothing", async () => {
    const rows = new Map<string, { definition: unknown; active: boolean }>();
    const store: PackStore = {
      async insertIfAbsent(row) {
        const id = `${row.key}@${row.version}`;
        if (rows.has(id)) return false;
        rows.set(id, { definition: row.definition, active: row.active });
        return true;
      },
      async get(k, v) {
        return rows.get(`${k}@${v}`)?.definition ?? null;
      },
    };
    const first = await syncPacks({ dir: PACKS_DIR, store });
    expect(first.packs.find((p) => p.key === key)?.outcome).toBe("inserted");
    expect(rows.get(`${key}@1`)?.active).toBe(true);
    const second = await syncPacks({ dir: PACKS_DIR, store });
    expect(second.packs.find((p) => p.key === key)?.outcome).toBe("unchanged");
    // what is stored is what the loader reads: the stored definition resolves with no warnings
    expect(resolvePack(rows.get(`${key}@1`)?.definition).warnings).toEqual([]);
  });

  it("is found by the sync's file reader at version 1, without warnings", async () => {
    const files = await readPackFiles(PACKS_DIR);
    const file = files.find((f) => f.key === key);
    expect(file?.version).toBe(1);
    expect(file?.warnings).toEqual([]);
  });

  it("a broken copy of the file is a deployment error (PackError), never a half-loaded pack", () => {
    const raw = JSON.parse(readFileSync(join(PACKS_DIR, `${key}.json`), "utf8")) as Record<string, unknown>;
    delete raw.fields;
    expect(() => resolvePack(raw)).toThrow(PackError);
  });
});

describe("no industry name in the agent's code (industry specifics live in pack data only)", () => {
  it("no non-test source file under backend/src/agent names the interiors or salon pack", () => {
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) sources.push(path);
      }
    };
    walk(AGENT_DIR);
    expect(sources.length).toBeGreaterThan(20);
    for (const path of sources) expect(readFileSync(path, "utf8"), path).not.toMatch(/["'`](interiors|salon)["'`]/);
  });
});

/** Every named matcher a pack uses, in its scoring rules and hard fails. */
function matchersOf(raw: unknown): string[] {
  const scoring = (raw as { scoring: { rules: { match?: string }[]; hardFails: { match?: string }[] } }).scoring;
  return [...new Set([...scoring.rules, ...scoring.hardFails].flatMap((r) => (r.match ? [r.match] : [])))].sort();
}

describe("KNOWN LIMIT: matchers the scoring code cannot judge (scoring/score.ts judge() reads only within_<x>_band and in_<x>_area(s))", () => {
  const files = readPackFiles(PACKS_DIR);
  // Generous references of every shape judge() reads: any matcher it knows gets an answer from these, so `undefined` means "unknown matcher".
  const references = { service_bands: [{ min: 0 }], service_areas: ["600042"], project_bands: [{ min: 0 }], project_areas: ["velachery"] };
  const unjudged = async (key: string) => {
    const file = (await files).find((f) => f.key === key);
    // judge() is exercised through scoreLead: a rule it cannot judge is reported in `unscored`
    const scoring = (file?.definition as { scoring: { rules: { field: string; match?: string }[] } }).scoring;
    const fieldsWithMatchers = scoring.rules.filter((r) => r.match !== undefined);
    return { matchers: matchersOf(file?.definition), fieldsWithMatchers, scoring };
  };

  it("lists the matchers each pack uses (a new matcher in a pack file must be added here on purpose)", async () => {
    expect((await unjudged("interiors")).matchers).toEqual(["in_service_area", "starts_within_days", "within_service_band"]);
    expect((await unjudged("salon")).matchers).toEqual(["in_service_catalog", "is_available_stylist", "none_in_service_catalog", "starts_within_days", "within_working_hours"]);
  });

  it("interiors: only starts_within_days (the possession date, 25 points) is not judged; the band and the service area are", async () => {
    const { matchers } = await unjudged("interiors");
    const file = (await files).find((f) => f.key === "interiors");
    const pack = file?.definition as Parameters<typeof scoreLead>[0];
    // every answer as good as it can be: a budget in the band, a pincode in the areas, the possession date next month
    const answers = { property_type: "apartment", area_sqft: 1150, scope: "full_home", budget: "12-15L", possession_date: "next month", pincode: "600042" };
    const result = scoreLead(pack, answers, { references: { service_bands: [{ min: 1_000_000, max: 3_000_000 }], service_areas: ["600042"] } });
    expect(matchers).toContain("starts_within_days");
    expect(result.unscored).toEqual(["possession_date"]);
    expect(result.score).toBe(75); // 100 in the pack, 25 of it never earned
    expect(result.temperature).toBe("hot"); // still over the hot line (70)
  });

  it("salon: none of its five matchers is judged, so the best possible lead scores 10 and is cold, and the hard fail never fires", async () => {
    const file = (await files).find((f) => f.key === "salon");
    const pack = file?.definition as Parameters<typeof scoreLead>[0];
    const best = { services: "haircut", preferred_stylist: "Asha", preferred_date: "tomorrow", preferred_time: "evening", party_size: 4 };
    const result = scoreLead(pack, best, { references });
    expect(result.unscored.sort()).toEqual(["preferred_date", "preferred_stylist", "preferred_time", "services"]);
    expect(result.score).toBe(10); // party_size is the only rule that needs no matcher
    expect(result.temperature).toBe("cold"); // the pack's warm line is 30
    // a service the salon does not offer: the hard fail { services, none_in_service_catalog } cannot be judged, so it does not fire
    const unknownService = scoreLead(pack, { ...best, services: "hair transplant" }, { references });
    expect(unknownService.temperature).not.toBe("disqualified");
    expect(unknownService.hardFail).toBeNull();
  });

  it("references the business has on file do not change that: with or without them, the same score", async () => {
    const file = (await files).find((f) => f.key === "salon");
    const pack = file?.definition as Parameters<typeof scoreLead>[0];
    const answers = { services: "haircut", party_size: 2 };
    expect(scoreLead(pack, answers, {}).score).toBe(scoreLead(pack, answers, { references }).score);
  });
});
