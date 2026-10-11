import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";

// Same TypeScript rule set the frontend gets from eslint-config-next/typescript, without the
// React and Next.js rules.
//
// Plus one rule of ours (CLAUDE.md: "Never write industry names in code; branch on pack capabilities"): the build fails if backend code
// branches on an industry. Industries are packs (packs/*.json); the engine reads what a pack CAN do (booking modes, fields, scoring), never
// which trade it is. Refused in the product's code (not in tests):
//   - a comparison of anything named vertical or industry with a string  (vertical === "x", tenant.industryKey !== "x")
//   - a switch on anything named vertical or industry
//   - a comparison, a `case` or an includes/indexOf with the key of a pack (read from packs/*.json, so a new pack is covered at once)
// src/lint-rules/no-industry-branching.test.ts holds what this refuses and what it allows.

const packKeys = readdirSync(fileURLToPath(new URL("../packs", import.meta.url)))
  .filter((file) => file.endsWith(".json"))
  .map((file) => file.slice(0, -".json".length));
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const PACK_KEY = `/^(${packKeys.map(escapeRegex).join("|")})$/`;
const NAMED = "/vertical|industry/i";
const COMPARISON = "BinaryExpression[operator=/^[=!]==?$/]";
const STRING = (side) => `:matches([${side}.type="Literal"][${side}.raw=/^["']/], [${side}.type="TemplateLiteral"])`;

const message = "Never branch on an industry or a pack's key. Branch on the pack's capabilities (bookingModes, fields, scoring, catalog) instead: industries are packs, not code.";
const noIndustryBranching = [
  ...[
    ["left", "right"],
    ["right", "left"],
  ].flatMap(([named, other]) => [`${COMPARISON}[${named}.name=${NAMED}]${STRING(other)}`, `${COMPARISON}[${named}.property.name=${NAMED}]${STRING(other)}`]),
  `SwitchStatement[discriminant.name=${NAMED}]`,
  `SwitchStatement[discriminant.property.name=${NAMED}]`,
  `${COMPARISON}:matches([left.value=${PACK_KEY}], [right.value=${PACK_KEY}])`,
  `SwitchCase[test.value=${PACK_KEY}]`,
  `CallExpression[callee.property.name=/^(includes|indexOf)$/][arguments.0.value=${PACK_KEY}]`,
].map((selector) => ({ selector, message }));

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    ignores: ["node_modules/**"],
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts", "src/test-support/**"],
    rules: { "no-restricted-syntax": ["error", ...noIndustryBranching] },
  },
);
