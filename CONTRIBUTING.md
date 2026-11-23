# Contributing

Thanks for your interest in improving Inscriptum. For installation and features, see [README.md](README.md).

## Development

Use Node.js 24 or newer, then install dependencies and run the checks:

```sh
npm ci
npm run check
```

Edit `theme.css` directly. It is the installable stylesheet; fonts and license notices are embedded, and no build step is required. Preserve the embedded font data and notices when editing visual rules.

Check Markdown Reading view and Live Preview, as well as Inscriptum documents, in light and dark modes on desktop and mobile. Include tables, code, quotes, checklists, images, menus, selection and keyboard focus.

## Release

On a clean, updated `master`, prepare a release with `npm run release -- patch` (or `minor` / `major`). The command updates version metadata and the changelog, runs checks, creates a commit and an annotated version tag. It does not push. Pushing the commit and tag triggers the GitHub release workflow. Community directory submission is a separate step.

The project began with [obsidian-sample-theme](https://github.com/obsidianmd/obsidian-sample-theme). See [third-party notices](THIRD-PARTY-NOTICES.md) for attribution.
