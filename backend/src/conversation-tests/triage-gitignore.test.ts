import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Real customer chats must never reach the repository. tests/triage/private/ is where they are kept, and git must ignore everything in it; the
// synthetic samples next to it must stay committed. If this fails, a real chat file could be committed.

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const git = (...args: string[]) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
const ignored = (path: string) => git("check-ignore", "-q", "--no-index", path).status === 0;

describe("real chats cannot be committed", () => {
  it("git ignores every file under tests/triage/private/, whatever it is called and however deep", () => {
    for (const name of ["raja-1.txt", "chats.md", "kb.txt", "export.csv", ".hidden", "nested/deeper/real chat.txt", "a b.txt", "UPPER.TXT"]) {
      expect(ignored(`tests/triage/private/${name}`), `tests/triage/private/${name} must be ignored`).toBe(true);
    }
  });

  it("nothing under tests/triage/private/ is tracked by git", () => {
    const tracked = git("ls-files", "--", "tests/triage/private");
    expect(tracked.status).toBe(0);
    expect(tracked.stdout.trim()).toBe("");
  });

  it("the synthetic samples and the README are not ignored", () => {
    for (const name of ["sample-tanglish.txt", "sample-kb.txt", "README.md"]) {
      expect(ignored(`tests/triage/${name}`), `tests/triage/${name} must be committed`).toBe(false);
    }
  });

  it("the rule is the directory itself, so a file cannot slip through by a new name", () => {
    const rules = git("check-ignore", "-v", "--no-index", "tests/triage/private/anything-at-all.dat").stdout;
    expect(rules).toMatch(/tests\/triage\/private/);
  });

  it("the committed triage folder holds only the samples and the README", () => {
    const names = readdirSync(`${ROOT}tests/triage`).filter((n) => n !== "private").sort();
    expect(names).toEqual(["README.md", "sample-kb.txt", "sample-tanglish.txt"]);
  });
});
