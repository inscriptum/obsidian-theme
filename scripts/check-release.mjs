import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { brotliDecompressSync } from "node:zlib";

const SEMVER = /^\d+\.\d+\.\d+$/;

// WHY: CSS decodes escape sequences before parsing, so "u\72l(" is a url(
// function for the engine while a raw-text search finds no "url(" — normalize
// escapes before the self-containment checks (review 2026-11-23 F15).
export function decodeCssEscapes(css) {
  return css.replace(
    /\\([0-9a-fA-F]{1,6})(\r\n|[ \t\r\n\f])?|\\(.)/g,
    (match, hex, space, literal) => {
      if (hex === undefined) {
        return literal;
      }
      const code = parseInt(hex, 16);
      // CSS Syntax L3 "consume an escaped code point": NUL, lone surrogates
      // and anything above the Unicode range all decode to U+FFFD.
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return "\u{FFFD}";
      }
      return String.fromCodePoint(code);
    },
  );
}

// WOFF2 known table tags (W3C WOFF2 1.0, section 4); the index is the 6-bit
// tag field of a table directory entry.
const WOFF2_KNOWN_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ",
  "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp",
  "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF",
  "GPOS", "GSUB", "EBSC", "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL",
  "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc",
  "feat", "fmtx", "fvar", "gvar", "hsty", "just", "lcar", "mort", "morx",
  "opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill",
];

// UIntBase128: up to 5 bytes, 7 payload bits each, high bit is a continuation.
function readUIntBase128(buffer, offset) {
  let result = 0;
  for (let i = 0; i < 5; i++) {
    const byte = buffer[offset + i];
    if (byte === undefined) {
      throw new Error("UIntBase128 runs past the end of the WOFF2 directory");
    }
    if (i === 0 && byte === 0x80) {
      throw new Error("Malformed UIntBase128 (leading zero byte)");
    }
    result = result * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      return { value: result, length: i + 1 };
    }
  }
  throw new Error("Malformed UIntBase128 (longer than 5 bytes)");
}

// CONTRACT: parses an embedded WOFF2 subset and returns its cmap coverage as
// sorted, merged [start, end] codepoint intervals. The declared unicode-range
// of an @font-face must stay inside what this returns, so a re-subset that
// drops glyphs cannot ship silently (review 2026-11-23 D2). Only cmap formats
// 4 and 12 are read — the two formats the subsetter emits for these fonts.
// COVERAGE LIMITATION (review 2026-11-23 R4): covered means a cmap
// segment/group [start, end] exists — idDelta/idRangeOffset/startGlyphID are
// not resolved, so a segment whose characters all map to glyph 0 still counts
// as covered. Accepted and documented here: a binary audit of the embedded
// Inter subsets found zero segment/glyph divergences (2026-11-23 lens review).
// WOFF2 layout relied on (W3C WOFF2 1.0): a 48-byte header, then the table
// directory, then one Brotli stream (totalCompressedSize bytes) holding the
// concatenated table data in directory order. Per-table size in that stream is
// transformLength when the entry is transformed, else origLength; the null
// transform is version 3 for glyf/loca and version 0 for every other table
// (a transformed loca entry is a placeholder whose transformLength is 0).
export function parseWoff2CmapCoverage(fontData) {
  const buffer = Buffer.isBuffer(fontData) ? fontData : Buffer.from(fontData);
  if (buffer.toString("latin1", 0, 4) !== "wOF2") {
    throw new Error("Not a WOFF2 font (bad signature)");
  }
  const numTables = buffer.readUInt16BE(12);
  const totalCompressedSize = buffer.readUInt32BE(20);

  let offset = 48;
  const tableSizes = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buffer[offset];
    offset += 1;
    const tagIndex = flags & 0x3f;
    const tag =
      tagIndex === 0x3f
        ? buffer.toString("latin1", offset, offset + 4)
        : WOFF2_KNOWN_TAGS[tagIndex];
    if (tagIndex === 0x3f) {
      offset += 4;
    }
    const origLength = readUIntBase128(buffer, offset);
    offset += origLength.length;
    const isGlyfOrLoca = tag === "glyf" || tag === "loca";
    const transformVersion = (flags >> 6) & 0x03;
    const isNullTransform = isGlyfOrLoca
      ? transformVersion === 3
      : transformVersion === 0;
    if (isNullTransform) {
      tableSizes.push({ tag, size: origLength.value });
    } else {
      const transformLength = readUIntBase128(buffer, offset);
      offset += transformLength.length;
      tableSizes.push({ tag, size: transformLength.value });
    }
  }

  const decompressed = brotliDecompressSync(
    buffer.subarray(offset, offset + totalCompressedSize),
  );
  let position = 0;
  let cmap = null;
  for (const { tag, size } of tableSizes) {
    if (tag === "cmap") {
      cmap = decompressed.subarray(position, position + size);
    }
    position += size;
  }
  if (!cmap || cmap.length < 4) {
    throw new Error("WOFF2 subset has no usable cmap table");
  }

  const rawIntervals = [];
  const seenSubtableOffsets = new Set();
  const numSubtables = cmap.readUInt16BE(2);
  for (let i = 0; i < numSubtables; i++) {
    const subtableOffset = cmap.readUInt32BE(8 + i * 8);
    // Windows and Unicode platform records often point at the same bytes.
    if (seenSubtableOffsets.has(subtableOffset)) {
      continue;
    }
    seenSubtableOffsets.add(subtableOffset);
    const format = cmap.readUInt16BE(subtableOffset);
    if (format === 4) {
      const segCount = cmap.readUInt16BE(subtableOffset + 6) / 2;
      const endCodesOffset = subtableOffset + 14;
      // The reservedPad word separates endCode[] from startCode[].
      const startCodesOffset = endCodesOffset + 2 * segCount + 2;
      for (let s = 0; s < segCount; s++) {
        const startCode = cmap.readUInt16BE(startCodesOffset + 2 * s);
        const endCode = cmap.readUInt16BE(endCodesOffset + 2 * s);
        if (startCode === 0xffff && endCode === 0xffff) {
          continue; // sentinel segment, not a real codepoint
        }
        rawIntervals.push([startCode, endCode]);
      }
    } else if (format === 12) {
      const numGroups = cmap.readUInt32BE(subtableOffset + 12);
      for (let g = 0; g < numGroups; g++) {
        const base = subtableOffset + 16 + g * 12;
        rawIntervals.push([
          cmap.readUInt32BE(base),
          cmap.readUInt32BE(base + 4),
        ]);
      }
    }
  }
  return mergeIntervals(rawIntervals);
}

function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

function isCovered(codepoint, intervals) {
  return intervals.some(([start, end]) => codepoint >= start && codepoint <= end);
}

// Parses a unicode-range value ("U+0400-045F, U+2074, U+30??") into
// [start, end] codepoint pairs; wildcards expand to their full hex span.
// Malformed and reversed tokens throw instead of silently shrinking the
// checked set — a reversed token would otherwise parse into an empty
// interval that passes every coverage probe (review 2026-11-23 R2).
export function parseUnicodeRange(value) {
  const ranges = [];
  for (const part of value.split(",")) {
    const token = part.trim();
    if (!/^u\+/i.test(token)) {
      continue;
    }
    const body = token.slice(2);
    const dash = body.indexOf("-");
    let start;
    let end;
    if (dash !== -1) {
      start = parseInt(body.slice(0, dash), 16);
      end = parseInt(body.slice(dash + 1), 16);
    } else if (body.includes("?")) {
      start = parseInt(body.replace(/\?/g, "0"), 16);
      end = parseInt(body.replace(/\?/g, "f"), 16);
    } else {
      start = parseInt(body, 16);
      end = start;
    }
    assert(
      !Number.isNaN(start) && !Number.isNaN(end),
      `Malformed unicode-range token: "${token}"`,
    );
    assert(start <= end, `Reversed unicode-range token: "${token}"`);
    ranges.push([start, end]);
  }
  return ranges;
}

// CONTRACT: a declared unicode-range may be a Google-Fonts-compatible
// superset of the binary subset's cmap; a codepoint declared but absent from
// cmap falls through to the next font in the stack per character, which is the
// intended fallback behavior (see the WHY comment above the @font-face rules
// in theme.css). EXPECTED_FALLBACK lists exactly the ranges measured
// uncovered on the embedded Inter subsets (2026-11-23, binary cmap review):
// C0/C1 controls never carry glyphs, the rare-punctuation holes and the two
// singletons are deliberate per-codepoint fallbacks. Anything outside this
// list fails the check, so a re-subset that drops real glyphs cannot pass.
// Exported for the allowlist-precision invariant test (review 2026-11-23 R1b):
// every codepoint listed here and declared in theme.css must remain actually
// uncovered by the embedded cmap, otherwise the allowlist hides a real hole.
export const EXPECTED_FALLBACK = [
  [0x0000, 0x001f], [0x007f, 0x009f],
  [0x2000, 0x2001], [0x2003, 0x2008], [0x200a, 0x200a], [0x200c, 0x2012],
  [0x2015, 0x2017], [0x201b, 0x201b], [0x201f, 0x2021], [0x2023, 0x2025],
  [0x2027, 0x2031], [0x2034, 0x2038], [0x203b, 0x2043], [0x2045, 0x206f],
  [0x2215, 0x2215], [0xfffd, 0xfffd],
];

function isExpectedFallback(codepoint) {
  return EXPECTED_FALLBACK.some(([start, end]) => codepoint >= start && codepoint <= end);
}

// D2: every declared codepoint must be covered by the embedded cmap unless it
// is a documented fallback range. Uncovered declarations outside the expected
// list mean the font binary and its advertisement have diverged.
function checkFontCoverage(css) {
  // R3: match @font-face and unicode-range on decoded CSS — "@\66 ont-face"
  // and "unic\6f de-range" are real to the engine while raw-text matching
  // sees nothing (same escape trick as the self-containment scans above).
  // decodeCssEscapes rewrites only backslash escapes, never base64 payloads,
  // so the font data extracted from the decoded block is byte-identical.
  for (const match of decodeCssEscapes(css).matchAll(/@font-face\s*\{([^{}]*)\}/g)) {
    const block = match[1];
    const src = /src:[^;]*url\(\s*["']?data:font\/woff2;base64,([A-Za-z0-9+/=]+)/.exec(block);
    const range = /unicode-range:\s*([^;]+);/.exec(block);
    assert(src, "Every @font-face must embed a data:font/woff2 URL.");
    assert(range, "Every @font-face must declare a unicode-range.");
    const covered = parseWoff2CmapCoverage(Buffer.from(src[1], "base64"));
    const uncovered = [];
    for (const [start, end] of parseUnicodeRange(range[1])) {
      for (let codepoint = start; codepoint <= end; codepoint++) {
        if (!isCovered(codepoint, covered) && !isExpectedFallback(codepoint)) {
          uncovered.push(codepoint);
        }
      }
    }
    assert.equal(
      uncovered.length,
      0,
      `unicode-range advertises codepoints the embedded font's cmap does not cover: ${
        uncovered
          .slice(0, 10)
          .map((c) => `U+${c.toString(16).toUpperCase().padStart(4, "0")}`)
          .join(", ")
      }${uncovered.length > 10 ? `, +${uncovered.length - 10} more` : ""} — re-subset the font or narrow the range`,
    );
  }
}

export function validateReleaseData({ manifest, pkg, versions, lock, css }) {
  assert.equal(manifest.name, "Inscriptum");
  assert.match(manifest.version, SEMVER);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  // Obsidian shows these fields in the community-plugin/theme card.
  assert.equal(typeof manifest.author, "string", "manifest.author must be a string");
  assert.notEqual(manifest.author.trim(), "", "manifest.author must be non-empty");
  assert.equal(typeof manifest.authorUrl, "string", "manifest.authorUrl must be a string");
  assert.match(manifest.authorUrl, /^https:\/\//, "manifest.authorUrl must start with https://");
  // Without this check an undefined minAppVersion turns the lookup below into
  // a degenerate undefined == undefined pass (review TEST3).
  assert.match(manifest.minAppVersion, SEMVER, "manifest.minAppVersion must be x.y.z");
  const currentMinAppVersion = versions[manifest.version];
  assert.equal(
    typeof currentMinAppVersion,
    "string",
    `versions.json must map "${manifest.version}" to a minAppVersion string`,
  );
  assert.equal(currentMinAppVersion, manifest.minAppVersion);

  if (process.env.RELEASE_TAG) {
    assert.equal(
      process.env.RELEASE_TAG,
      manifest.version,
      "RELEASE_TAG must match the released manifest.version",
    );
  }

  // Every published app version needs a strict x.y.z -> x.y.z mapping.
  for (const [version, minAppVersion] of Object.entries(versions)) {
    assert.match(version, SEMVER, `versions.json key "${version}" must be x.y.z`);
    assert.equal(
      typeof minAppVersion,
      "string",
      `versions.json value for "${version}" must be a string`,
    );
    assert.match(minAppVersion, SEMVER, `versions.json value for "${version}" must be x.y.z`);
  }

  // D6: at-keywords and url() are case-insensitive per CSS Syntax L3, so both
  // scans run on decoded CSS with the i flag — "@IMPORT U\52L(" and
  // "u\52l(http://x)" are real @import/url() to the engine.
  const decodedCss = decodeCssEscapes(css);
  assert(!/@import\b/i.test(decodedCss), "The release CSS must be self-contained.");
  for (const match of decodedCss.matchAll(/url\(\s*["']?([^\s"')]+)/gi)) {
    assert(match[1].startsWith("data:"), "Theme assets must be embedded for offline use.");
  }

  // License texts must travel inside the installable file, not only in licenses/.
  for (const notice of [
    "Apache License, Version 2.0",
    "SIL OPEN FONT LICENSE",
    "0BSD",
    "Copyright (c) 2026 sumbad",
  ]) {
    assert(css.includes(notice), `theme.css must embed the license notice: "${notice}"`);
  }

  assert(css.includes(".theme-light") && css.includes(".theme-dark"));

  checkFontCoverage(css);
}

const RELEASE_FILES = [
  "LICENSE",
  "THIRD-PARTY-NOTICES.md",
  "README.md",
  "CONTRIBUTING.md",
  "licenses/Apache-2.0.txt",
  "licenses/Inter-OFL.txt",
  "licenses/Obsidian-sample-0BSD.txt",
  "licenses/Inscriptum-plugin-MIT.txt",
  "screenshots/light.png",
  "screenshots/dark.png",
  "screenshots/screenshot.png",
];

function readJson(file, hint) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    assert.fail(`${file}: ${error.message}${hint ? ` — expected ${hint}` : ""}`);
  }
}

function checkRelease() {
  const manifest = readJson("manifest.json");
  const pkg = readJson("package.json");
  const versions = readJson("versions.json", '{"x.y.z": "minAppVersion"}');
  const lock = readJson("package-lock.json");
  const css = readFileSync("theme.css", "utf8");

  validateReleaseData({ manifest, pkg, versions, lock, css });

  for (const file of RELEASE_FILES) {
    assert(existsSync(file), `Missing release file: ${file}`);
  }

  console.log(`Inscriptum ${manifest.version}: metadata, offline resources, and release files OK.`);
}

// Executable as a script, importable by tests.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  checkRelease();
}
