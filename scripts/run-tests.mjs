// Test runner (review 2026-11-23 R5/D4): discovers scripts/*.test.mjs and
// hands the files to `node --test`, so a new *.test.mjs is picked up
// automatically instead of being silently left out of `npm run check`.
// Exit 1 when nothing is discovered — an empty glob must never pass silently.
import { readdirSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Discovery resolves relative to this script's own directory, not the process
// cwd: running `node scripts/run-tests.mjs` from any working directory tests
// the same scripts/ folder, and a copy of this script without test files next
// to it fails fast instead of running a foreign directory's tests.
const scriptDir = fileURLToPath(new URL(".", import.meta.url));

export function discoverTestFiles(dir = scriptDir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => join(dir, name));
}

function main() {
  const files = discoverTestFiles();
  if (files.length === 0) {
    console.error(`No *.test.mjs files found in ${scriptDir} — nothing to run.`);
    process.exit(1);
  }
  const result = spawnSync(process.execPath, ["--test", ...files], {
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`Failed to spawn node --test: ${result.error.message}`);
    process.exit(1);
  }
  // status is null when the child died from a signal — treat that as failure.
  process.exitCode = result.status ?? 1;
}

// Executable as a script, importable by tests (same pattern as
// check-release.mjs). The entry comparison goes through realpath so it also
// matches when the script is invoked via a symlinked path (macOS /tmp ->
// /private/tmp): import.meta.url is already the resolved physical path,
// while process.argv[1] is whatever was typed. A missing/unresolvable
// argv[1] just means "not the entry" rather than a crash.
function isEntryScript() {
  try {
    return (
      import.meta.url ===
      pathToFileURL(realpathSync(process.argv[1] ?? "")).href
    );
  } catch {
    return false;
  }
}

if (isEntryScript()) {
  main();
}
