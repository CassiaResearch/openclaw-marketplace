#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const marketplacePath = path.join(repoRoot, "marketplace.json");
const stagingDir = path.join(repoRoot, "tarballs-staged");
const trackedDir = path.join(repoRoot, "tarballs");
const stagedManifestPath = path.join(stagingDir, "manifest.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function main() {
  if (!fs.existsSync(stagedManifestPath)) {
    console.error(`tarballs-staged/manifest.json not found; run scripts/build-plugin-tarballs.mjs first`);
    process.exit(2);
  }

  const { built } = readJson(stagedManifestPath);
  if (!Array.isArray(built) || built.length === 0) {
    console.log("nothing to publish");
    return;
  }

  fs.mkdirSync(trackedDir, { recursive: true });

  const builtByName = new Map(built.map((b) => [b.name, b]));
  const builtTarballSet = new Set(built.map((b) => b.tarball));

  for (const entry of built) {
    const src = path.join(stagingDir, entry.tarball);
    const dst = path.join(trackedDir, entry.tarball);
    fs.copyFileSync(src, dst);
    console.log(`copied tarballs/${entry.tarball}`);
  }

  const marketplace = readJson(marketplacePath);
  let manifestChanged = false;
  for (const entry of marketplace.plugins) {
    const built = builtByName.get(entry.name);
    if (!built) continue;
    const newSource = `./tarballs/${built.tarball}`;
    if (entry.source !== newSource || entry.version !== built.version) {
      entry.source = newSource;
      entry.version = built.version;
      manifestChanged = true;
      console.log(`marketplace.json: ${entry.name} -> ${newSource}`);
    }
  }
  if (manifestChanged) {
    fs.writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2) + "\n");
  } else {
    console.log("marketplace.json: no changes");
  }

  const referenced = new Set(
    marketplace.plugins
      .map((p) => p.source)
      .filter((s) => typeof s === "string" && s.startsWith("./tarballs/"))
      .map((s) => path.basename(s)),
  );

  for (const file of fs.readdirSync(trackedDir)) {
    if (!file.endsWith(".tgz")) continue;
    if (referenced.has(file)) continue;
    if (builtTarballSet.has(file)) continue;
    fs.unlinkSync(path.join(trackedDir, file));
    console.log(`pruned tarballs/${file}`);
  }
}

main();
