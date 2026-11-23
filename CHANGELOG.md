# Changelog

## [Unreleased]
- A calm reading theme for Obsidian: neutral light and dark palettes, 18 px article text and a 700 px reading column.
- Inter for interface and headings ships embedded offline (Cyrillic and Latin variable subsets), so documents render the same without network access.
- Inscriptum `.note` and `.um` documents pick up the theme automatically, with no change to the plugin.
- Obsidian's own font and size settings keep priority over the theme defaults.
- Faint text in both palettes and dark highlights now meet WCAG AA contrast.
- Cover text keeps its own fixed sizes and no longer scales with your article font-size setting.
- Releases are harder to break: the version tag is verified in CI, automation is locked to fixed tool versions, and a failed check no longer leaves local changes behind.
