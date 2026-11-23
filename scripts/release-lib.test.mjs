import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync } from "node:zlib";
import {
  addVersionsEntry,
  bumpManifest,
  bumpPackageLock,
  bumpVersion,
  parseVersion,
  updateChangelog,
} from "./release-lib.mjs";
import {
  EXPECTED_FALLBACK,
  decodeCssEscapes,
  parseUnicodeRange,
  parseWoff2CmapCoverage,
  validateReleaseData,
} from "./check-release.mjs";
import { discoverTestFiles } from "./run-tests.mjs";

const repoRoot = new URL("../", import.meta.url);

test("parseVersion accepts strict x.y.z", () => {
  assert.deepEqual(parseVersion("1.10.6"), { major: 1, minor: 10, patch: 6 });
});

test("parseVersion rejects malformed versions", () => {
  for (const bad of ["0.1", "v0.1.0", "0.1.0-beta", "", "1.2.3.4"]) {
    assert.throws(() => parseVersion(bad), /Invalid semver version/);
  }
});

test("bumpVersion resets lower components per release type", () => {
  assert.equal(bumpVersion("0.1.0", "major"), "1.0.0");
  assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0");
  assert.equal(bumpVersion("1.2.3", "patch"), "1.2.4");
});

test("bumpVersion rejects unknown release types", () => {
  assert.throws(() => bumpVersion("1.2.3", "pre"), /Unknown release type/);
});

test("bumpPackageLock updates both the root version and packages root", () => {
  const lock = JSON.parse(
    bumpPackageLock(
      JSON.stringify({
        version: "0.1.0",
        packages: {
          "": { name: "@inscriptum/obsidian-theme", version: "0.1.0" },
          "node_modules/stylelint": { version: "17.0.0" },
        },
      }),
      "0.2.0",
    ),
  );
  assert.equal(lock.version, "0.2.0");
  assert.equal(lock.packages[""].version, "0.2.0");
  assert.equal(lock.packages["node_modules/stylelint"].version, "17.0.0");
});

test("bumpManifest updates version and keeps other fields", () => {
  const manifest = JSON.parse(
    bumpManifest(
      JSON.stringify({ id: "inscriptum", version: "0.1.0", minAppVersion: "1.10.6" }),
      "0.3.0",
    ),
  );
  assert.equal(manifest.version, "0.3.0");
  assert.equal(manifest.minAppVersion, "1.10.6");
});

test("addVersionsEntry puts the new entry first", () => {
  const versions = JSON.parse(
    addVersionsEntry(JSON.stringify({ "0.1.0": "1.10.6" }), "0.2.0", "1.12.0"),
  );
  assert.equal(Object.keys(versions)[0], "0.2.0");
  assert.deepEqual(versions, { "0.2.0": "1.12.0", "0.1.0": "1.10.6" });
});

test("updateChangelog renames exactly the Unreleased header and re-seeds the section", () => {
  const input = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "- Something shipped.",
    "",
    "## [0.1.0] - 2026-11-01",
    "",
    "- Initial release.",
  ].join("\n");
  const lines = updateChangelog(input, "0.2.0", "2026-11-24").split("\n");
  assert.equal(lines[2], "## [Unreleased]");
  assert.equal(lines[3], "");
  assert.equal(lines[4], "## [0.2.0] - 2026-11-24");
  assert.equal(lines[6], "- Something shipped.");
  assert.equal(lines[8], "## [0.1.0] - 2026-11-01");
  assert.equal(lines.filter((line) => line === "## [Unreleased]").length, 1);
  assert.equal(lines.filter((line) => line.startsWith("## [0.2.0]")).length, 1);
});

test("updateChangelog fails without an Unreleased section", () => {
  assert.throws(
    () => updateChangelog("# Changelog\n\n## [0.1.0] - 2026-11-01\n", "0.2.0", "2026-11-24"),
    /No "## \[Unreleased\]" section/,
  );
});

test("decodeCssEscapes resolves hex and literal escapes", () => {
  assert.equal(decodeCssEscapes("\\72"), "r");
  assert.equal(decodeCssEscapes("\\6F"), "o");
  // CSS reads "u\72l(" as a url( function while the raw text hides it from
  // a plain grep — this is exactly the self-containment bypass (review F15).
  assert.equal(decodeCssEscapes("u\\72l("), "url(");
  assert.equal(decodeCssEscapes("@import u\\72l(evil.css);"), "@import url(evil.css);");
  assert.equal(decodeCssEscapes("\\20 x"), " x");
  assert.equal(decodeCssEscapes("plain text"), "plain text");
});

test("decodeCssEscapes clamps NUL, surrogates and out-of-range escapes to U+FFFD", () => {
  // CSS Syntax L3: these decode to U+FFFD, never to the raw code point.
  assert.equal(decodeCssEscapes("\\0"), "\u{FFFD}");
  assert.equal(decodeCssEscapes("\\d800"), "\u{FFFD}");
  assert.equal(decodeCssEscapes("\\dfff"), "\u{FFFD}");
  assert.equal(decodeCssEscapes("\\110000"), "\u{FFFD}");
  // Six hex digits are consumed, so "\000072" is still just "r".
  assert.equal(decodeCssEscapes("\\000072"), "r");
  // "\\" is a literal backslash escape: the digits stay untouched text.
  assert.equal(decodeCssEscapes("\\\\72"), "\\72");
});

test("obfuscated @IMPORT and url() are detected after decoding", () => {
  // "@IMPORT U\52L(" decodes to "@IMPORT URL(" and "u\52l(" to "uRl(" — both
  // are the same at-keyword/function to the CSS engine, so detection relies on
  // the case-insensitive scans (review 2026-11-23 D6).
  const importCss = decodeCssEscapes("@IMPORT U\\52L(evil.css)");
  assert.equal(importCss, "@IMPORT URL(evil.css)");
  assert.match(importCss, /@import\b/i);
  const urlCss = decodeCssEscapes("u\\52l(http://x)");
  assert.equal(urlCss, "uRl(http://x)");
  assert.match(urlCss, /url\(/i);
});

function releaseFixture(overrides = {}) {
  const manifest = {
    name: "Inscriptum",
    version: "0.1.0",
    author: "sumbad",
    authorUrl: "https://github.com/sumbad",
    minAppVersion: "1.10.6",
  };
  const pkg = { version: "0.1.0" };
  const versions = { "0.1.0": "1.10.6" };
  const lock = { version: "0.1.0", packages: { "": { version: "0.1.0" } } };
  const css = [
    ".theme-light {}",
    ".theme-dark {}",
    "Apache License, Version 2.0",
    "SIL OPEN FONT LICENSE",
    "0BSD",
    "Copyright (c) 2026 sumbad",
  ].join("\n");
  return { manifest, pkg, versions, lock, css, ...overrides };
}

test("validateReleaseData accepts the real release data on disk", () => {
  validateReleaseData({
    manifest: JSON.parse(readFileSync(new URL("manifest.json", repoRoot), "utf8")),
    pkg: JSON.parse(readFileSync(new URL("package.json", repoRoot), "utf8")),
    versions: JSON.parse(readFileSync(new URL("versions.json", repoRoot), "utf8")),
    lock: JSON.parse(readFileSync(new URL("package-lock.json", repoRoot), "utf8")),
    css: readFileSync(new URL("theme.css", repoRoot), "utf8"),
  });
});

test("validateReleaseData rejects a blank author", () => {
  const data = releaseFixture();
  data.manifest = { ...data.manifest, author: "   " };
  assert.throws(() => validateReleaseData(data), /must be non-empty/);
});

test("validateReleaseData rejects a non-https authorUrl", () => {
  const data = releaseFixture();
  data.manifest = { ...data.manifest, authorUrl: "http://github.com/sumbad" };
  assert.throws(() => validateReleaseData(data), /must start with https:\/\//);
});

test("validateReleaseData rejects a malformed minAppVersion", () => {
  const data = releaseFixture();
  data.manifest = { ...data.manifest, minAppVersion: "1.10" };
  assert.throws(() => validateReleaseData(data), /minAppVersion must be x\.y\.z/);
});

test("validateReleaseData rejects non-x.y.z versions.json keys and values", () => {
  const badKey = releaseFixture();
  badKey.versions = { "0.1.0": "1.10.6", latest: "1.10.6" };
  assert.throws(() => validateReleaseData(badKey), /key "latest" must be x\.y\.z/);

  const badValue = releaseFixture();
  badValue.versions = { "0.1.0": "1.10.6", "0.2.0": "1.x" };
  assert.throws(() => validateReleaseData(badValue), /value for "0\.2\.0" must be x\.y\.z/);
});

test("validateReleaseData rejects a RELEASE_TAG mismatch", () => {
  const original = process.env.RELEASE_TAG;
  process.env.RELEASE_TAG = "9.9.9";
  try {
    assert.throws(
      () => validateReleaseData(releaseFixture()),
      /RELEASE_TAG must match the released manifest\.version/,
    );
  } finally {
    if (original === undefined) {
      delete process.env.RELEASE_TAG;
    } else {
      process.env.RELEASE_TAG = original;
    }
  }
});

test("validateReleaseData rejects css missing a license notice", () => {
  const data = releaseFixture();
  data.css = ".theme-light {}\n.theme-dark {}";
  assert.throws(() => validateReleaseData(data), /must embed the license notice/);
});

test("validateReleaseData rejects obfuscated @import in css", () => {
  const data = releaseFixture();
  data.css += "\n@IMPORT U\\52L(evil.css);";
  assert.throws(() => validateReleaseData(data), /must be self-contained/);
});

function coversCodepoint(intervals, codepoint) {
  return intervals.some(([start, end]) => codepoint >= start && codepoint <= end);
}

test("parseWoff2CmapCoverage reads both embedded Inter subsets", () => {
  const css = readFileSync(new URL("theme.css", repoRoot), "utf8");
  const faces = [...css.matchAll(/@font-face\s*\{([^{}]*)\}/g)];
  assert.equal(faces.length, 2, "theme.css embeds a Cyrillic and a Latin subset");
  const coverage = faces.map((face) => {
    const base64 = /data:font\/woff2;base64,([A-Za-z0-9+/=]+)/.exec(face[1]);
    assert(base64, "each @font-face embeds a WOFF2 data URL");
    const intervals = parseWoff2CmapCoverage(Buffer.from(base64[1], "base64"));
    assert(intervals.length > 0, "cmap coverage is non-empty");
    return intervals;
  });
  const [cyrillic, latin] = coverage;
  // Spot checks that survive a broken re-subset, split per declared subset.
  assert(coversCodepoint(cyrillic, 0x42f), "Cyrillic Ya is mapped");
  assert(coversCodepoint(cyrillic, 0x451), "Cyrillic io is mapped");
  assert(coversCodepoint(cyrillic, 0x2116), "numero sign is mapped");
  assert(!coversCodepoint(cyrillic, 0x41), "Latin A stays out of the Cyrillic subset");
  assert(coversCodepoint(latin, 0x41), "A is mapped");
  assert(coversCodepoint(latin, 0x2014), "em dash is mapped");
  assert(coversCodepoint(latin, 0x0153), "oe ligature is mapped");
  assert(!coversCodepoint(latin, 0x42f), "Cyrillic Ya stays out of the Latin subset");
});

test("parseWoff2CmapCoverage returns merged Cyrillic segments", () => {
  const css = readFileSync(new URL("theme.css", repoRoot), "utf8");
  const block = /@font-face\s*\{([^{}]*)\}/.exec(css)[1];
  const base64 = /data:font\/woff2;base64,([A-Za-z0-9+/=]+)/.exec(block)[1];
  const intervals = parseWoff2CmapCoverage(Buffer.from(base64, "base64"));
  // The Cyrillic subset's cmap must declare the whole U+0400-045F block as
  // one merged interval — proof the format 4/12 merge worked.
  assert(
    intervals.some(([start, end]) => start === 0x400 && end === 0x45f),
    `intervals: ${JSON.stringify(intervals)}`,
  );
});

test("parseWoff2CmapCoverage rejects non-WOFF2 data", () => {
  assert.throws(
    () => parseWoff2CmapCoverage(Buffer.from("not a font")),
    /Not a WOFF2 font/,
  );
});

// --- Font coverage gate: synthetic WOFF2 fixtures (review 2026-11-23 R1) ---

// Minimal UIntBase128 encoder (WOFF2 1.0 section 2.3): 7 payload bits per
// byte, high bit marks continuation. Enough for the small synthetic tables.
function uintBase128(value) {
  assert(Number.isInteger(value) && value >= 0 && value < 2 ** 28);
  const bytes = [];
  do {
    bytes.push(value & 0x7f);
    value >>>= 7;
  } while (value > 0);
  bytes.reverse();
  for (let i = 0; i < bytes.length - 1; i++) {
    bytes[i] |= 0x80;
  }
  return Buffer.from(bytes);
}

// Builds a minimal WOFF2 wrapping a cmap format 12 subtable with the given
// [start, end] codepoint groups (WOFF2 1.0 layout: 48-byte header, a table
// directory entry for the known tag "cmap" carrying the null transform, then
// one Brotli stream holding the concatenated table data).
function buildWoff2WithCmap12(groups) {
  const groupBytes = Buffer.alloc(groups.length * 12);
  groups.forEach(([start, end], index) => {
    groupBytes.writeUInt32BE(start, index * 12);
    groupBytes.writeUInt32BE(end, index * 12 + 4);
    groupBytes.writeUInt32BE(0, index * 12 + 8); // startGlyphID
  });
  const subtable = Buffer.alloc(16 + groupBytes.length);
  subtable.writeUInt16BE(12, 0); // format 12
  subtable.writeUInt16BE(0, 2); // reserved
  subtable.writeUInt32BE(subtable.length, 4); // length
  subtable.writeUInt32BE(0, 8); // language
  subtable.writeUInt32BE(groups.length, 12); // nGroups
  groupBytes.copy(subtable, 16);

  const cmap = Buffer.alloc(12 + subtable.length);
  cmap.writeUInt16BE(0, 0); // version
  cmap.writeUInt16BE(1, 2); // numTables (encoding records)
  cmap.writeUInt16BE(3, 4); // platformID: Windows
  cmap.writeUInt16BE(10, 6); // encodingID: UCS-4
  cmap.writeUInt32BE(12, 8); // subtable offset
  subtable.copy(cmap, 12);

  const compressed = brotliCompressSync(cmap);
  // Directory flags 0x00 = known-tag index 0 ("cmap") with transform version
  // 0, which is the null transform for non-glyf/loca tables; then origLength.
  const dirEntry = Buffer.concat([
    Buffer.from([0x00]),
    uintBase128(cmap.length),
  ]);
  const header = Buffer.alloc(48);
  header.write("wOF2", 0, "latin1");
  header.writeUInt32BE(0x00010000, 4); // sfntVersion
  header.writeUInt32BE(48 + dirEntry.length + compressed.length, 8); // length
  header.writeUInt16BE(1, 12); // numTables
  header.writeUInt16BE(0, 14); // reserved
  // WOFF2 1.0 §4.1: totalSfntSize counts the uncompressed font layout — the
  // 12-byte sfnt header, a 16-byte directory entry per table and the table
  // data (12 + 16 * 1 + cmap.length).
  header.writeUInt32BE(12 + 16 + cmap.length, 16); // totalSfntSize
  header.writeUInt32BE(compressed.length, 20); // totalCompressedSize
  header.writeUInt16BE(1, 24); // majorVersion
  // minorVersion and the meta/priv fields stay zero.

  return Buffer.concat([header, dirEntry, compressed]);
}

function fontFaceBlock(base64, unicodeRange) {
  return [
    "@font-face {",
    '  font-family: "Inscriptum Test";',
    `  src: url("data:font/woff2;base64,${base64}") format("woff2");`,
    `  unicode-range: ${unicodeRange};`,
    "}",
  ].join("\n");
}

test("validateReleaseData rejects a font that drops a declared codepoint", () => {
  const data = releaseFixture();
  // One cmap group covering "A" only; the face declares U+0041-0042, so "B"
  // is advertised but absent, and U+0042 is not in EXPECTED_FALLBACK.
  const font = buildWoff2WithCmap12([[0x41, 0x41]]);
  data.css += `\n${fontFaceBlock(font.toString("base64"), "U+0041-0042")}`;
  assert.throws(
    () => validateReleaseData(data),
    /unicode-range advertises codepoints[\s\S]*U\+0042/,
  );
});

test("validateReleaseData accepts a font that covers its declared range", () => {
  const data = releaseFixture();
  const font = buildWoff2WithCmap12([[0x41, 0x42]]);
  data.css += `\n${fontFaceBlock(font.toString("base64"), "U+0041-0042")}`;
  validateReleaseData(data); // must not throw
});

test("every EXPECTED_FALLBACK codepoint declared in theme.css is really uncovered", () => {
  // Allowlist precision invariant (review 2026-11-23 R1b): a listed codepoint
  // that the embedded cmap actually covers would mean the allowlist hides a
  // real glyph hole instead of a measured per-codepoint fallback.
  const css = readFileSync(new URL("theme.css", repoRoot), "utf8");
  const faces = [...css.matchAll(/@font-face\s*\{([^{}]*)\}/g)];
  assert.equal(faces.length, 2, "theme.css embeds a Cyrillic and a Latin subset");
  let declaredFallback = 0;
  for (const face of faces) {
    const range = /unicode-range:\s*([^;]+);/.exec(face[1])[1];
    const declared = parseUnicodeRange(range);
    const base64 = /data:font\/woff2;base64,([A-Za-z0-9+/=]+)/.exec(face[1])[1];
    const covered = parseWoff2CmapCoverage(Buffer.from(base64, "base64"));
    for (const [start, end] of EXPECTED_FALLBACK) {
      for (let codepoint = start; codepoint <= end; codepoint++) {
        if (!declared.some(([s, e]) => codepoint >= s && codepoint <= e)) {
          continue;
        }
        declaredFallback++;
        assert(
          !coversCodepoint(covered, codepoint),
          `U+${codepoint.toString(16).toUpperCase().padStart(4, "0")} is listed in EXPECTED_FALLBACK but the embedded cmap covers it — shrink the allowlist`,
        );
      }
    }
  }
  // Pinned to the lens-measured figure (2026-11-23): exactly 161 allowlist
  // codepoints are declared in theme.css today. If this moves, the allowlist
  // or the advertised ranges changed and the fallback holes need re-measuring.
  assert.equal(declaredFallback, 161);
});

test("parseUnicodeRange expands ranges, wildcards and skips non-U+ tokens", () => {
  assert.deepEqual(parseUnicodeRange("U+0400-045F, U+2116"), [
    [0x400, 0x45f],
    [0x2116, 0x2116],
  ]);
  assert.deepEqual(parseUnicodeRange("U+30??"), [[0x3000, 0x30ff]]);
  assert.deepEqual(parseUnicodeRange("U+2074"), [[0x2074, 0x2074]]);
  assert.deepEqual(parseUnicodeRange("nonsense, U+0041"), [[0x41, 0x41]]);
});

test("parseUnicodeRange rejects NaN and reversed tokens", () => {
  assert.throws(
    () => parseUnicodeRange("U+zzzz"),
    /Malformed unicode-range token: "U\+zzzz"/,
  );
  // A reversed token used to parse into an empty [start, end] interval that
  // passed every coverage probe (review 2026-11-23 R2); it must throw instead.
  assert.throws(
    () => parseUnicodeRange("U+045F-0400"),
    /Reversed unicode-range token: "U\+045F-0400"/,
  );
});

test("run-tests discovery picks only *.test.mjs files, sorted", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "run-tests-discovery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "beta.test.mjs"), "");
  writeFileSync(join(dir, "alpha.test.mjs"), "");
  writeFileSync(join(dir, "helper.mjs"), "");
  writeFileSync(join(dir, "gamma.test.js"), ""); // wrong extension on purpose
  assert.deepEqual(discoverTestFiles(dir), [
    join(dir, "alpha.test.mjs"),
    join(dir, "beta.test.mjs"),
  ]);
});

test("run-tests discovery returns nothing for a directory without tests", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "run-tests-empty-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "only-scripts.mjs"), "");
  assert.deepEqual(discoverTestFiles(dir), []);
});
