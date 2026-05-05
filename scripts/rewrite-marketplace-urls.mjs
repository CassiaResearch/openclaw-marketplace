#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const marketplacePath = path.join(repoRoot, "marketplace.json");
const stagingDir = path.join(repoRoot, "tarballs-staged");
const manifestPath = path.join(stagingDir, "manifest.json");

const args = process.argv.slice(2);
const tagIdx = args.indexOf("--tag");
const repoIdx = args.indexOf("--repo");
const tag = tagIdx >= 0 ? args[tagIdx + 1] : null;
const releaseRepo = repoIdx >= 0 ? args[repoIdx + 1] : "CassiaResearch/openclaw-marketplace";

if (!tag) {
  console.error("usage: node scripts/rewrite-marketplace-urls.mjs --tag <release-tag> [--repo <owner/repo>]");
  process.exit(2);
}

if (!fs.existsSync(manifestPath)) {
  console.error(`tarballs-staged/manifest.json not found; run scripts/build-plugin-tarballs.mjs first`);
  process.exit(2);
}

const { built } = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const builtByName = new Map(built.map((b) => [b.name, b]));

const marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
const releaseBase = `https://github.com/${releaseRepo}/releases/download/${encodeURIComponent(tag)}`;

let changed = false;
for (const entry of marketplace.plugins) {
  const built = builtByName.get(entry.name);
  if (!built) continue;
  const newUrl = `${releaseBase}/${built.tarball}`;
  if (entry.source !== newUrl || entry.version !== built.version) {
    entry.source = newUrl;
    entry.version = built.version;
    changed = true;
    console.log(`updated ${entry.name} -> ${newUrl}`);
  }
}

if (changed) {
  fs.writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2) + "\n");
  console.log(`\nmarketplace.json rewritten with ${tag}`);
} else {
  console.log("no marketplace.json changes");
}
