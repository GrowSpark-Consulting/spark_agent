import { describe, expect, it } from "vitest";
import { backendSources, scanBackend, scanSource, type LogCall } from "./scan";
import { DEV1_ALLOWED, FOREIGN_FLAGGED, isDev1 } from "./static-guard-allowlist";

// Day 7, PR B, the static guard: every console.* call in the backend's own source that writes more than fixed words must be accounted for. It looks at what
// is interpolated or passed (a name that says phone, token, secret, key, body, text, message, name, email, ...; or an argument that is not a string, such as an
// error object that prints its message and stack), after taking out what is safe whatever it is called (`error.name`, `result.status`, `x instanceof Y`).
//
// Dev 1's files: a flagged call must be in DEV1_ALLOWED with a one-line reason, or be fixed; an entry that no longer matches fails (no stale entries).
// Other files (Dev 2's and shared code): a flagged call is a candidate, not a proof. They are counted per file in FOREIGN_FLAGGED, reported in the task note
// and not edited; a NEW flagged call there fails the guard until it is added, a fixed one never does.
// Scope: console.log, error, warn, info and debug in the backend's source (tests, test support, scripts, the conversation runner and this folder excluded).
// Not covered: a `log(line)` callback (the request logger and the error envelope: request-logger.test.ts), anything printed by a library.

const flaggedOf = (calls: LogCall[]) => calls.filter((c) => c.flags.length > 0);

describe("the scanner", () => {
  const scan = (src: string) => scanSource("x.ts", src);

  it("passes fixed words, ids, kinds, codes and statuses", () => {
    const calls = scan(`
      console.log("[pipeline] replied");
      console.error(\`[pipeline] gave up (\${error.name}) on \${original.data.messageId} \${tenantId}\`);
      console.warn(\`try \${attempts} of \${tries} failed: \${failure.code} status \${failure.status}\`);
      console.log(\`\${error instanceof Error ? error.name : "unknown"}\`);
    `.replace(/\$\{original\.data\.messageId\}/, "${messageId}"));
    expect(calls).toHaveLength(4);
    expect(flaggedOf(calls)).toEqual([]);
  });

  it.each([
    ["a phone", "console.log(`from ${phone}`)"],
    ["a property called phone", "console.log(`from ${contact.phone}`)"],
    ["a token", "console.error(`bad ${token}`)"],
    ["a secret", "console.error(`bad ${connection.secret}`)"],
    ["an error's message", "console.error(`failed: ${err.message}`)"],
    ["an error's message through a conditional", "console.error(`failed: ${e instanceof Error ? e.message : String(e)}`)"],
    ["a text", "console.log(`wrote ${text}`)"],
    ["a body", "console.log(`got ${request.body}`)"],
    ["a name", "console.log(`for ${customerName} ${name}`)"],
    ["an email", "console.log(`mail ${email}`)"],
    ["an argument that is not a string", "console.error(err)"],
    ["a variable line", "console.log(line)"],
    ["a call result", "console.warn(formatRetry(info))"],
    ["a string joined to a variable", 'console.log("a " + body)'],
    ["a second argument", 'console.error("failed", error)'],
    ["a camelCase name that holds a phone", "console.log(`from ${ownerPhone}`)"],
    ["a snake_case property that holds a phone", "console.log(`from ${row.phone_number}`)"],
    ["a user's message by a compound name", "console.log(`wrote ${userMessage}`)"],
    ["a customer's name (a property called name that is not an error's)", "console.log(`for ${contact.name}`)"],
    ["the notes of a lead", "console.log(`notes ${lead.notes}`)"],
    ["an argument hidden after a // inside a string", 'console.log("a // b", token)'],
  ])("flags %s", (_name, code) => {
    expect(flaggedOf(scan(code))).toHaveLength(1);
  });

  it("passes ids by any name, and an error's class name", () => {
    expect(flaggedOf(scan("console.log(`${tenantId} ${message.messageId} ${connection_id} ${conversationIds.length} ${err.name} ${cause.name}`)"))).toEqual([]);
  });

  it("is not fooled by a log call inside a comment, or by parentheses and braces in strings", () => {
    const calls = scan(`
      // console.log(\`\${phone}\`)
      /* console.error(token) */
      console.log("a (b) {c} \\" ) \`d\`");
      console.log(\`x \${fn("}")} y\`);
    `);
    expect(calls).toHaveLength(2);
  });

  it("reads a call that runs over several lines, and says the line it starts on", () => {
    const calls = scan(`\n\n  console.log(\n    \`[x] \${a}\`,\n    body,\n  );`);
    expect(calls).toHaveLength(1);
    expect(calls[0].line).toBe(3);
    expect(calls[0].flags.length).toBe(1);
  });
});

describe("the backend's log calls", () => {
  const calls = scanBackend();
  const flagged = flaggedOf(calls);

  it("found them all (a scanner that silently finds nothing proves nothing)", () => {
    expect(calls.length).toBeGreaterThan(80);
    expect(new Set(calls.map((c) => c.file)).size).toBeGreaterThan(30);
  });

  it("Dev 1's files: every flagged call is allowed, with its reason", () => {
    const unaccounted = flagged
      .filter((c) => isDev1(c.file))
      .filter((c) => !DEV1_ALLOWED.some((a) => a.file === c.file && c.text.includes(a.contains)));
    expect(unaccounted.map((c) => `${c.file}:${c.line} ${c.flags.join(" | ")}`), "add it to DEV1_ALLOWED with a reason, or fix the line").toEqual([]);
  });

  it("Dev 1's allowlist: every entry matches exactly one flagged call, and has a one-line reason", () => {
    for (const entry of DEV1_ALLOWED) {
      const matches = flagged.filter((c) => c.file === entry.file && c.text.includes(entry.contains));
      expect(matches, `${entry.file}: ${entry.contains}`).toHaveLength(1);
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(entry.reason.length).toBeLessThanOrEqual(220);
      expect(entry.reason).not.toContain("\n");
    }
    expect(DEV1_ALLOWED.every((a) => isDev1(a.file))).toBe(true);
  });

  it("other files (Dev 2's and shared): no NEW flagged call (they are counted, reported in the task note, and not edited here)", () => {
    const byFile = new Map<string, number>();
    for (const c of flagged.filter((c) => !isDev1(c.file))) byFile.set(c.file, (byFile.get(c.file) ?? 0) + 1);
    const known = new Map(FOREIGN_FLAGGED.map((f) => [f.file, f.count]));
    const added = [...byFile].filter(([file, n]) => n > (known.get(file) ?? 0)).map(([file, n]) => `${file}: ${n} flagged, ${known.get(file) ?? 0} reported`);
    expect(added, "a new flagged log line in a file that is not Dev 1's: tell its owner, then add it to FOREIGN_FLAGGED").toEqual([]);
  });

  it("the reported counts are real (a file that no longer has a flagged call is dropped from the list)", () => {
    const byFile = new Map<string, number>();
    for (const c of flagged.filter((c) => !isDev1(c.file))) byFile.set(c.file, (byFile.get(c.file) ?? 0) + 1);
    for (const f of FOREIGN_FLAGGED) expect(byFile.get(f.file) ?? 0, `${f.file} is no longer flagged that many times: lower or remove the entry`).toBeGreaterThan(0);
  });

  it("no source file takes console apart or aliases it, so the scan sees every log call (const { log } = console, const c = console, console['log'])", () => {
    const sneaky = backendSources().filter(({ src }) => /=\s*console\b(?!\.)|\{[^}]*\}\s*=\s*console\b|console\s*\[/.test(src.replace(/\/\/.*$/gm, "")));
    expect(sneaky.map((f) => f.file)).toEqual([]);
  });

  it("no source file writes to the process's output directly or uses another console method (table, dir, trace)", () => {
    const direct = backendSources().filter(({ src }) => /process\.(?:stdout|stderr)\.write|console\.(?:table|dir|trace|group)\b/.test(src.replace(/\/\/.*$/gm, "").replace(/`[^`]*`/g, "")));
    expect(direct.map((f) => f.file)).toEqual([]);
  });

  it("no call writes a phone number, a token, a secret or a customer's words by name in Dev 1's files (the rule in one line)", () => {
    const dev1 = flagged.filter((c) => isDev1(c.file) && !DEV1_ALLOWED.some((a) => a.file === c.file && c.text.includes(a.contains)));
    expect(dev1).toEqual([]);
  });
});
