#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const marketplacePath = path.join(repoRoot, "marketplace.json");
const pluginsDir = path.join(repoRoot, "plugins");
const stagingDir = path.join(repoRoot, "tarballs-staged");

const args = process.argv.slice(2);
const onlyArgIdx = args.indexOf("--only");
const onlyName = onlyArgIdx >= 0 ? args[onlyArgIdx + 1] : null;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function detectPackageManager(pluginDir) {
  if (fs.existsSync(path.join(pluginDir, "pnpm-lock.yaml"))) return "pnpm";
  return "npm";
}

function discoverPluginDirs() {
  const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginDir = path.join(pluginsDir, entry.name);
    const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
    const pkgPath = path.join(pluginDir, "package.json");
    if (!fs.existsSync(manifestPath) || !fs.existsSync(pkgPath)) continue;
    dirs.push(pluginDir);
  }
  return dirs;
}

function pluginIsBuildable(pluginDir) {
  const pkg = readJson(path.join(pluginDir, "package.json"));
  const manifest = readJson(path.join(pluginDir, "openclaw.plugin.json"));
  if (!pkg.scripts?.build) return { ok: false, reason: "no build script", pkg, manifest };
  if (!pkg.openclaw?.runtimeExtensions?.length) {
    return { ok: false, reason: "no openclaw.runtimeExtensions declared", pkg, manifest };
  }
  return { ok: true, pkg, manifest };
}

function packedTarballName(pkg) {
  const name = pkg.name.replace(/^@/, "").replace(/\//g, "-");
  return `${name}-${pkg.version}.tgz`;
}

function run(cmd, cmdArgs, cwd) {
  const result = spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${cmdArgs.join(" ")} (cwd=${cwd}) exited ${result.status}`);
  }
}

function main() {
  fs.mkdirSync(stagingDir, { recursive: true });
  const marketplace = readJson(marketplacePath);
  const marketplaceByName = new Map(marketplace.plugins.map((p) => [p.name, p]));

  const built = [];
  const skipped = [];

  for (const pluginDir of discoverPluginDirs()) {
    const buildable = pluginIsBuildable(pluginDir);
    const manifestId = buildable.manifest?.id;
    if (!manifestId) {
      skipped.push({ pluginDir, reason: "openclaw.plugin.json has no id" });
      continue;
    }
    const marketplaceEntry = marketplaceByName.get(manifestId);
    if (!marketplaceEntry) {
      skipped.push({ name: manifestId, pluginDir, reason: "no marketplace.json entry matches manifest id" });
      continue;
    }
    if (onlyName && manifestId !== onlyName) continue;
    if (!buildable.ok) {
      skipped.push({ name: manifestId, pluginDir, reason: buildable.reason });
      continue;
    }
    const pkg = buildable.pkg;

    console.log(`\n=== Building ${manifestId} (${pkg.name}@${pkg.version}) ===`);
    const manager = detectPackageManager(pluginDir);

    if (manager === "pnpm") {
      run("pnpm", ["install", "--frozen-lockfile=false"], pluginDir);
      run("pnpm", ["pack", "--pack-destination", stagingDir], pluginDir);
    } else {
      const lockPath = path.join(pluginDir, "package-lock.json");
      run("npm", [fs.existsSync(lockPath) ? "ci" : "install", "--include=dev"], pluginDir);
      run("npm", ["pack", "--pack-destination", stagingDir], pluginDir);
    }

    const tarballName = packedTarballName(pkg);
    const tarballPath = path.join(stagingDir, tarballName);
    if (!fs.existsSync(tarballPath)) {
      throw new Error(`expected tarball not produced: ${tarballPath}`);
    }
    built.push({
      name: manifestId,
      packageName: pkg.name,
      version: pkg.version,
      tarball: tarballName,
    });
  }

  const manifestPath = path.join(stagingDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ built, skipped }, null, 2));
  console.log("\nBuilt:", built);
  console.log("Skipped:", skipped);
  console.log(`\nManifest written to ${manifestPath}`);
}

main();
