import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  RELEASE_TYPES,
  bumpVersion,
  bumpPackageJson,
  bumpPackageLock,
  bumpManifest,
  addVersionsEntry,
  updateChangelog,
} from "./release-lib.mjs";

const ROOT = new URL("..", import.meta.url);

const FILES = [
  "package.json",
  "package-lock.json",
  "manifest.json",
  "versions.json",
  "CHANGELOG.md",
];

function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: fileURLToPath(ROOT),
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function git(...args) {
  return spawnSync("git", args, { cwd: fileURLToPath(ROOT), encoding: "utf8" });
}

function gitOutput(...args) {
  const result = git(...args);
  if (result.status !== 0) {
    fail(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function createTag(tag) {
  const tagResult = git("tag", "-a", tag, "-m", `Inscriptum ${tag}`);
  if (tagResult.status !== 0) {
    fail(
      `git tag failed: ${tagResult.stderr.trim()}\nThe release commit exists but the tag was not created. Recover with either:\n  git tag -a ${tag} -m 'Inscriptum ${tag}' && git push origin HEAD --follow-tags\n  git reset --hard HEAD~1`,
    );
  }
  console.log(`\nCommitted and tagged ${tag}.`);
  console.log("To publish, run:");
  console.log("  git push origin HEAD --follow-tags");
}

// D8: restoration must never mask the original failure — collect what could
// not be written back so the caller can report it for manual recovery.
async function restoreOriginalFiles(originalContents) {
  const failed = [];
  for (const file of FILES) {
    try {
      await writeFile(new URL(file, ROOT), originalContents[file], "utf8");
    } catch {
      failed.push(file);
    }
  }
  return failed;
}

async function main() {
  const releaseType = process.argv[2] ?? "patch";
  if (!RELEASE_TYPES.includes(releaseType)) {
    fail(
      `Unknown release type "${releaseType}". Use one of: ${RELEASE_TYPES.join(", ")}`,
    );
  }

  const packageJson = JSON.parse(
    await readFile(new URL("package.json", ROOT), "utf8"),
  );
  const nextVersion = bumpVersion(packageJson.version, releaseType);

  const dirty = gitOutput("status", "--porcelain");
  if (dirty !== "") {
    fail("Working tree is dirty. Commit or stash changes before releasing.");
  }

  if (gitOutput("branch", "--show-current") !== "master") {
    fail("Release from master after merging the reviewed task branch.");
  }

  // Idempotent retry (review TEST4): a previous run bumped and committed but
  // failed to create the tag — finish that run instead of starting a new one.
  if (
    gitOutput("tag", "--list", packageJson.version) === "" &&
    gitOutput("log", "-1", "--pretty=%s") === `release: ${packageJson.version}`
  ) {
    // D7: the HEAD subject alone does not prove a release commit — verify the
    // bumped content before tagging, then re-run the full check on it.
    let headManifest;
    let headVersions;
    try {
      headManifest = JSON.parse(gitOutput("show", "HEAD:manifest.json"));
      headVersions = JSON.parse(gitOutput("show", "HEAD:versions.json"));
    } catch (error) {
      fail(
        `HEAD does not look like a release commit: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      headManifest?.version !== packageJson.version ||
      !Object.hasOwn(headVersions ?? {}, packageJson.version)
    ) {
      fail(
        `HEAD subject is "release: ${packageJson.version}" but manifest.json/versions.json on HEAD do not carry that version — refusing to tag a non-release commit.`,
      );
    }
    // No restore needed here: the retry path never modifies files.
    run("npm", ["run", "check"], { RELEASE_TAG: packageJson.version });
    createTag(packageJson.version);
    return;
  }

  const tag = nextVersion;
  if (gitOutput("tag", "--list", tag) !== "") {
    fail(`Tag ${tag} already exists.`);
  }

  const manifest = JSON.parse(
    await readFile(new URL("manifest.json", ROOT), "utf8"),
  );
  // The release below derives versions.json from this field — writing files
  // from an undefined/invalid minAppVersion would corrupt them (review TEST3).
  if (
    typeof manifest.minAppVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(manifest.minAppVersion)
  ) {
    fail(
      `manifest.minAppVersion must be a semver x.y.z string, got "${manifest.minAppVersion}".`,
    );
  }
  const versions = JSON.parse(
    await readFile(new URL("versions.json", ROOT), "utf8"),
  );
  if (Object.prototype.hasOwnProperty.call(versions, nextVersion)) {
    fail(`Version ${nextVersion} already present in versions.json.`);
  }

  // Local date (not UTC): a morning release must not be dated yesterday.
  const date = new Intl.DateTimeFormat("sv-SE").format(new Date());

  const transform = {
    "package.json": (content) => bumpPackageJson(content, nextVersion),
    "package-lock.json": (content) => bumpPackageLock(content, nextVersion),
    "manifest.json": (content) => bumpManifest(content, nextVersion),
    "versions.json": (content) =>
      addVersionsEntry(content, nextVersion, manifest.minAppVersion),
    "CHANGELOG.md": (content) => updateChangelog(content, nextVersion, date),
  };

  const originalContents = {};
  const nextContents = {};
  for (const file of FILES) {
    originalContents[file] = await readFile(new URL(file, ROOT), "utf8");
    nextContents[file] = transform[file](originalContents[file]);
  }

  // D8: the bump itself is guarded — a failed write mid-loop must not leave a
  // half-bumped tree behind without an attempt to restore it.
  try {
    for (const file of FILES) {
      await writeFile(new URL(file, ROOT), nextContents[file], "utf8");
    }
  } catch (error) {
    const failedRestore = await restoreOriginalFiles(originalContents);
    let message = `Version bump failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    if (failedRestore.length > 0) {
      message += `\nCould not restore: ${failedRestore.join(", ")} — restore these files manually before retrying.`;
    }
    fail(message);
  }

  console.log(`Bumped version to ${nextVersion}`);

  try {
    run("npm", ["run", "check"], { RELEASE_TAG: nextVersion });
  } catch (error) {
    // Undo the bump so the tree stays clean for the next attempt (F11).
    const failedRestore = await restoreOriginalFiles(originalContents);
    let message = error instanceof Error ? error.message : String(error);
    if (failedRestore.length > 0) {
      message += `\nCould not restore: ${failedRestore.join(", ")} — restore these files manually before retrying.`;
    }
    fail(message);
  }

  const addResult = git("add", ...FILES);
  if (addResult.status !== 0) {
    fail(`git add failed: ${addResult.stderr.trim()}`);
  }

  const commitResult = git("commit", "-m", `release: ${nextVersion}`);
  if (commitResult.status !== 0) {
    fail(`git commit failed: ${commitResult.stderr.trim()}`);
  }

  createTag(tag);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
