import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// CLAUDE.md: "Never write industry names in code; branch on pack capabilities." The build fails (pnpm lint, which CI runs) if backend code
// branches on an industry. This runs the real ESLint config over small pieces of code and checks what it refuses and what it allows.

const backend = fileURLToPath(new URL("../..", import.meta.url));
const eslint = new ESLint({ cwd: backend });
const RULE = "no-restricted-syntax";

async function messages(code: string, filePath = "src/agent/example.ts") {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((m) => m.ruleId === RULE);
}

// A real pack's key, read from packs/*.json the way the rule reads it, so a new pack is covered without touching the rule.
const packKeys = readdirSync(fileURLToPath(new URL("../../../packs", import.meta.url)))
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""));

describe("code that branches on an industry fails the build", () => {
  it.each([
    ["a comparison with a name that says vertical", `declare const vertical: string;\nif (vertical === "x") {}`],
    ["a comparison with a name that says industry", `declare const industry: string;\nif (industry !== "x") {}`],
    ["the other way round", `declare const vertical: string;\nif ("x" === vertical) {}`],
    ["a loose comparison", `declare const vertical: string;\nif (vertical == "x") {}`],
    ["a property that says vertical", `declare const tenant: { vertical: string };\nif (tenant.vertical === "x") {}`],
    ["a property that says industry, in a ternary", `declare const t: { industryKey: string };\nconst a = t.industryKey === "x" ? 1 : 2;`],
    ["a comparison with a template string", "declare const vertical: string;\nif (vertical === `x`) {}"],
    ["a switch on a vertical", `declare const vertical: string;\nswitch (vertical) { case "x": break; }`],
    ["a switch on a property that says vertical", `declare const t: { vertical: string };\nswitch (t.vertical) { default: break; }`],
    ["the pack key of the business", `declare const pack: { key: string };\nif (pack.key === "${packKeys[0]}") {}`],
  ])("%s", async (_why, code) => {
    const found = await messages(code);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].message).toMatch(/industry|pack/i);
  });

  it.each(packKeys)("any comparison with the pack key %s, whatever the variable is called", async (key) => {
    expect((await messages(`declare const x: string;\nif (x === "${key}") {}`)).length).toBeGreaterThan(0);
    expect((await messages(`declare const x: string;\nif ("${key}" !== x) {}`)).length).toBeGreaterThan(0);
  });

  it.each(packKeys)("a case for the pack key %s", async (key) => {
    expect((await messages(`declare const x: string;\nswitch (x) { case "${key}": break; }`)).length).toBeGreaterThan(0);
  });

  it.each(packKeys)("%s looked up in a list", async (key) => {
    expect((await messages(`declare const x: string[];\nx.includes("${key}");`)).length).toBeGreaterThan(0);
  });

  it("says what to do instead", async () => {
    const [first] = await messages(`declare const vertical: string;\nif (vertical === "x") {}`);
    expect(first.message).toMatch(/capabilit/i);
  });
});

describe("code that does not branch on an industry is left alone", () => {
  it.each([
    ["a comparison on a capability", `declare const pack: { bookingModes: string[] };\nif (pack.bookingModes.includes("site_visit")) {}`],
    ["a comparison on something else with a literal", `declare const status: string;\nif (status === "confirmed") {}`],
    ["passing a vertical on, without comparing it", `declare const vertical: string;\nfunction load(key: string) { return key; }\nload(vertical);`],
    ["comparing two verticals with each other", `declare const a: { vertical: string }; declare const b: { vertical: string };\nif (a.vertical === b.vertical) {}`],
    ["comparing a vertical with a number or null", `declare const vertical: string | null;\nif (vertical === null) {}`],
    ["a comparison of a vertical-named number with a number", `declare const verticalSpace: number;\nif (verticalSpace === 3) {}`],
    ["a switch on something else", `declare const kind: string;\nswitch (kind) { case "slot": break; }`],
    ["a pack key as data (a property value, not a test)", `export const sample = { key: "${packKeys[0]}" };`],
  ])("%s", async (_why, code) => {
    expect(await messages(code)).toEqual([]);
  });

  it("tests may name a pack: they are not the product's code", async () => {
    expect(await messages(`declare const vertical: string;\nif (vertical === "${packKeys[0]}") {}`, "src/agent/example.test.ts")).toEqual([]);
  });

  it("the test support code may too", async () => {
    expect(await messages(`declare const vertical: string;\nif (vertical === "${packKeys[0]}") {}`, "src/test-support/example.ts")).toEqual([]);
  });
});
