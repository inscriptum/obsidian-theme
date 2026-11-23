import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const theme = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.some(a => !["--dry-run", "--workspace"].includes(a) && args[args.indexOf(a) - 1] !== "--workspace")) {
  throw new Error("Usage: npm run dev:vault -- [--dry-run] [--workspace /path/to/inscriptum]");
}
const workspaceIndex = args.indexOf("--workspace");
if (workspaceIndex >= 0 && !args[workspaceIndex + 1]) throw new Error("--workspace needs a path");
const workspace = workspaceIndex < 0 ? dirname(theme) : resolve(args[workspaceIndex + 1]);
const plugin = join(workspace, "obsidian-plugin");
const vault = join(workspace, "obsidian-dev-vault");
const marker = join(vault, ".inscriptum-dev-vault.json");
if (existsSync(vault) && (!existsSync(marker) || JSON.parse(readFileSync(marker, "utf8")).kind !== "inscriptum-dev-vault")) {
  throw new Error(`Refusing to write an unmarked existing vault: ${vault}`);
}
if (!existsSync(join(plugin, "package.json"))) throw new Error(`Plugin repository not found: ${plugin}`);
if (args.includes("--dry-run")) {
  console.log(`Would build ${plugin} and deploy plugin + theme to ${vault}. Existing notes/settings are preserved.`);
  process.exit(0);
}
const build = spawnSync("npm", ["run", "build"], { cwd: plugin, stdio: "inherit" });
if (build.status !== 0) throw new Error("Plugin build failed; vault was not updated.");
const outputs = [
  [join(plugin, "dist/main.js"), ".obsidian/plugins/inscriptum/main.js"],
  [join(plugin, "dist/styles.css"), ".obsidian/plugins/inscriptum/styles.css"],
  [join(plugin, "manifest.json"), ".obsidian/plugins/inscriptum/manifest.json"],
  [join(theme, "theme.css"), ".obsidian/themes/Inscriptum/theme.css"],
  [join(theme, "manifest.json"), ".obsidian/themes/Inscriptum/manifest.json"],
];
for (const [source] of outputs) if (!existsSync(source)) throw new Error(`Missing deploy artifact: ${source}`);
mkdirSync(vault, { recursive: true });
for (const [source, name] of outputs) {
  const target = join(vault, name);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}
const createJson = (name, value) => {
  const path = join(vault, name);
  if (!existsSync(path)) writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
createJson(".inscriptum-dev-vault.json", { kind: "inscriptum-dev-vault", version: 1 });
createJson(".obsidian/appearance.json", { cssTheme: "Inscriptum", theme: "system", baseFontSize: 18 });
createJson(".obsidian/community-plugins.json", ["inscriptum"]);
for (const name of ["Inscriptum.md", "Inscriptum.note", "Inscriptum.um"]) {
  if (!existsSync(join(vault, name))) copyFileSync(join(theme, "examples", name), join(vault, name));
}
console.log(`Ready: ${vault}\nOpen this folder as a vault in Obsidian. Allow community plugins if prompted. Reload the vault after deploying updated code.`);
