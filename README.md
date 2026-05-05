# OpenClaw Plugin Marketplace

Internal plugin registry for the team. Plugins live here as git subtrees pulled from per-plugin upstream repos. CI in this repo builds each plugin's `dist/` once per change, publishes the resulting tarballs as GitHub release assets on this repo, and rewrites `marketplace.json` to point each entry at its release-asset URL. OpenClaw consumers install via `--marketplace` and get a self-contained tarball.

This shape is required by OpenClaw 2026.5.3+, whose install validator rejects packages that point at TypeScript sources without compiled `dist/` peers. Source-tree marketplaces no longer install. See `scripts/build-plugin-tarballs.mjs` and `.github/workflows/build-and-release.yml` for the pipeline.

## Structure

```
openclaw-marketplace/
├── marketplace.json                         ← registry index (CI rewrites it)
├── README.md
├── .github/workflows/build-and-release.yml  ← rebuilds tarballs on every push
├── scripts/
│   ├── build-plugin-tarballs.mjs            ← npm pack per plugin
│   └── rewrite-marketplace-urls.mjs         ← rewrites source URLs
└── plugins/
    ├── instantly/                           ← subtree from CassiaResearch/openclaw-instantly
    └── ...
```

`plugins/<n>/` directories carry the TypeScript source. Built tarballs live only on GitHub Releases for this repo, never tracked in the working tree.

---

## Installing a Plugin (OpenClaw side)

```bash
openclaw plugins install <plugin-name> --marketplace https://github.com/CassiaResearch/openclaw-marketplace
openclaw gateway restart
```

`<plugin-name>` is the entry's `name` in `marketplace.json` (e.g. `openclaw-instantly`, `copilotai-email-warden`). OpenClaw fetches `marketplace.json`, follows the entry's `source` URL to download the tarball, extracts it, and installs the plugin to `~/.openclaw/extensions/<plugin-id>/`.

If the plugin's bundle hits the install scanner's dangerous-code patterns (e.g. `process.env` access combined with HTTP send for a webhook plugin), add `--dangerously-force-unsafe-install`:

```bash
openclaw plugins install openclaw-instantly --marketplace https://github.com/CassiaResearch/openclaw-marketplace --dangerously-force-unsafe-install
```

After install, set required config:

```bash
openclaw config set plugins.entries.<plugin-id>.config.<key> "<value>"
openclaw gateway restart
```

To pick up a new release:

```bash
openclaw plugins update <plugin-id>
openclaw gateway restart
```

`update` checks the entry's `version` against what's installed; bumping the version in this repo (which CI does on every plugin change) is what makes consumers pick up the new tarball.

---

## Updating an Existing Plugin

The common case: a plugin's source changes upstream and the marketplace needs the rebuilt tarball.

**1. Pull upstream into the marketplace.** From a clean working tree:

```bash
/usr/bin/git subtree pull --prefix plugins/<n> \
  https://github.com/<org>/openclaw-<n>.git <branch> --squash
```

`/usr/bin/git` is required if your `git` binary lacks `git-subtree` (the system git does on most setups). See `scripts/lib/` for upstream URLs per plugin if needed.

**2. Bump versions.** Edit both `plugins/<n>/package.json` and `plugins/<n>/openclaw.plugin.json` to the new version (semver patch for bug fixes, minor for new behavior). The `version` field is what `openclaw plugins update` compares against, so bumping is required for consumers to pick up the change.

**3. (Optional) Rebuild locally to verify.**

```bash
node scripts/build-plugin-tarballs.mjs --only <plugin-name>
```

This runs `npm pack` (or `pnpm pack` for self-learn) inside `plugins/<n>/`, which auto-runs the plugin's `prepack` → `build` script and emits the tarball to `tarballs-staged/`. Inspect or extract it to confirm `dist/index.js` is present.

**4. Commit and push.**

```bash
git add plugins/<n>/
git commit -m "chore(<n>): sync upstream and bump to vX.Y.Z"
git push
```

CI takes over: it builds all plugins, creates a fresh `tarballs-YYYY-MM-DD-HHMM` release, uploads the tarballs, rewrites `marketplace.json` to point at the new URLs, and commits the rewrite back to `main`. Within a few minutes, `openclaw plugins update <plugin-id>` against the new version works for everyone.

---

## Adding a New Plugin

Use this when bringing a community plugin or a new internal plugin into the marketplace.

**1. Fork the upstream repo** (or create a fresh repo) so the marketplace has a stable git URL it can subtree-pull from.

**2. Confirm the plugin's `package.json` is build-ready.** It should have:

- `scripts.build` that compiles TypeScript to `dist/` (e.g., `"tsc"` or `"tsc -p tsconfig.build.json"`).
- `scripts.prepack` that invokes `build` so `npm pack` rebuilds before producing the tarball.
- `openclaw.runtimeExtensions: ["./dist/index.js"]` (or whatever `dist/`-relative path your build produces).
- `openclaw.extensions` pointing at the same `./dist/index.js`. This is the lossless-claw / `@openclaw/kitchen-sink` pattern: marketplace consumers get the compiled output only, so referencing the source `.ts` would warn at install time.
- `files: ["dist/**", "openclaw.plugin.json", "README.md", ...]`. The npm pack tarball includes only what's listed; do not list `index.ts` or `src/` if you ship compiled output.
- `peerDependencies: { "openclaw": "*" }`. npm 7+ auto-installs the peer during local builds, which is what makes type imports from `openclaw/plugin-sdk` resolve under `tsc`.
- `devDependencies` includes `typescript` and `@types/node` so the build runs on a fresh clone.

If the upstream is missing any of these, fix the upstream repo first, then continue.

**3. Add it as a subtree.** From a clean working tree on `main`:

```bash
/usr/bin/git subtree add --prefix plugins/<n> \
  https://github.com/<org>/openclaw-<n>.git <branch> --squash
```

**4. Verify the plugin's `openclaw.plugin.json`** has a unique `id` (don't reuse an existing plugin's id) and a starting `version`.

**5. Register it in `marketplace.json`.** Add an entry with the manifest's `id` as `name`, a `description`, and a placeholder `source`:

```json
{
  "name": "<plugin-id>",
  "description": "Short description shown in `openclaw plugins marketplace list`",
  "source": "./plugins/<n>",
  "version": "0.0.0"
}
```

CI will replace `source` with the release-asset URL on the next build.

**6. Verify the build works locally:**

```bash
node scripts/build-plugin-tarballs.mjs --only <plugin-id>
ls tarballs-staged/
```

**7. Commit and push.** CI will produce the first real release.

```bash
git add plugins/<n>/ marketplace.json
git commit -m "feat: add <plugin-id> plugin"
git push
```

---

## Syncing Upstream Changes Without a Version Bump

If you need to sync upstream code but no behavior changed (e.g., upstream merged a CI-only PR), you can pull without bumping the version, but the CI release will still produce a new tarball at the same version. `openclaw plugins update <id>` will short-circuit as `unchanged` because the version field didn't move. Bump if you want consumers to pick up the new bytes.

---

## Removing a Plugin

```bash
git rm -r plugins/<n>
# Edit marketplace.json to remove the entry
git add marketplace.json
git commit -m "chore: remove <plugin-name>"
git push
```

CI will produce a release without the removed tarball. Existing installs keep working until consumers run `openclaw plugins uninstall <plugin-id>`.

The removed plugin's previous release tarballs stay on GitHub Releases and remain installable via the old `marketplace.json` URL. To fully invalidate, also delete the affected releases.

---

## How the Build/Release Pipeline Works

`.github/workflows/build-and-release.yml` runs on push to `main` whenever `plugins/**` changes (or on `workflow_dispatch`):

1. `node scripts/build-plugin-tarballs.mjs` walks `plugins/*/`, picks any plugin with `openclaw.runtimeExtensions` plus a `build` script, runs `npm install --include=dev` (or `pnpm install`), then `npm pack --pack-destination=../../tarballs-staged/`. The plugin's `prepack` script auto-runs the build before pack.
2. The action creates a fresh release tagged `tarballs-YYYY-MM-DD-HHMM` (UTC) and uploads every `*.tgz` from `tarballs-staged/` as a release asset.
3. `node scripts/rewrite-marketplace-urls.mjs --tag <tag>` rewrites each `marketplace.json` entry whose plugin id matches a built tarball, setting `source` to the release-asset URL and `version` to the built tarball's version.
4. The action commits the rewritten `marketplace.json` back to `main` with a `[skip ci]`-style message via marketplace-bot.

To run the same flow locally (e.g., to debug a build):

```bash
node scripts/build-plugin-tarballs.mjs                 # all plugins
# inspect tarballs-staged/manifest.json
node scripts/rewrite-marketplace-urls.mjs --tag <tag>  # rewrite using a real or test tag
```

`tarballs-staged/` is gitignored and safe to delete between runs.

---

## Reference

### marketplace.json

| Field              | Description                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `name`             | Marketplace identifier                                                                                 |
| `owner`            | GitHub org/user                                                                                        |
| `version`          | Marketplace metadata version                                                                           |
| `plugins[].name`   | Plugin id (must match `openclaw.plugin.json` `id`). Used in `openclaw plugins install <name>`.         |
| `plugins[].source` | https URL to the release-asset tarball (CI-managed) or `./plugins/<n>` for a freshly added plugin     |
| `plugins[].version`| Tarball version (CI-managed; mirrors the plugin's `package.json` version)                              |
| `plugins[].description` | Short description shown by `openclaw plugins marketplace list`                                    |

### plugins/&lt;n&gt;/package.json (openclaw block)

| Field                          | Required | Description                                                                       |
| ------------------------------ | -------- | --------------------------------------------------------------------------------- |
| `openclaw.extensions`          | Yes      | Array of entry paths. For tarball-distributed plugins: `["./dist/index.js"]`.     |
| `openclaw.runtimeExtensions`   | Yes      | Same shape as `extensions`; what OpenClaw loads at runtime. Same path is fine.    |
| `peerDependencies.openclaw`    | Yes      | `"*"` is fine. npm auto-installs this for local builds so type imports resolve.   |
| `scripts.build`                | Yes      | Compiles TypeScript to `dist/`. e.g. `"tsc"` or `"tsc -p tsconfig.build.json"`.   |
| `scripts.prepack`              | Yes      | Invokes `build` so `npm pack` rebuilds before packing.                            |
| `files`                        | Yes      | Whitelist for npm pack. Must include `dist/**` and `openclaw.plugin.json`.        |
| `devDependencies`              | Yes      | Must include `typescript` and `@types/node` for fresh-clone builds.               |

### plugins/&lt;n&gt;/openclaw.plugin.json

| Field          | Required    | Description                                                       |
| -------------- | ----------- | ----------------------------------------------------------------- |
| `id`           | Yes         | Unique kebab-case identifier. Must match `marketplace.json` name. |
| `version`      | Recommended | Bump on every change so `openclaw plugins update` triggers.       |
| `pluginApi`    | Yes         | Currently `"1.0"`.                                                |
| `configSchema` | Yes         | JSON Schema for plugin config. Use `{ "type": "object" }` if none.|

---

## Troubleshooting

**`package install requires compiled runtime output for TypeScript entry`** — the plugin's tarball is missing `dist/`. Cause is usually a stale `package.json` that lists `index.ts` in `files` or doesn't declare `runtimeExtensions`. Fix the upstream package.json (see "Adding a New Plugin" checklist), pull the subtree, and let CI rebuild.

**`extension entry not found: ./index.ts`** at install — `openclaw.extensions` still points at a `.ts` source path. Switch it to the same `./dist/index.js` as `runtimeExtensions`.

**Install scanner blocks the plugin (`dangerous code patterns: ...`)** — the install scanner flags `process.env` access combined with HTTP send. For trusted internal plugins, install with `--dangerously-force-unsafe-install`. Reviewing the flagged code first is recommended.

**`openclaw plugins update <id>` reports "already at <version>"** — the `version` field in `marketplace.json` (or the tarball) didn't change. Bump the version in `plugins/<n>/package.json` and `plugins/<n>/openclaw.plugin.json`, push, and let CI republish.

**CI rebuild produced a stale tarball** — verify locally:

```bash
node scripts/build-plugin-tarballs.mjs --only <plugin-id>
tar -tzf tarballs-staged/<pkg-name>-<version>.tgz | head
```

`package/dist/index.js` and `package/openclaw.plugin.json` must be present. If not, the plugin's `prepack`/`build` scripts didn't run; check `package.json`.

**`git subtree pull` fails with "not our ref"** — the split history reaches back through a removed prior subtree. Workaround: clone the upstream into `/tmp`, apply the change manually, push a feature branch.

**`git subtree pull` fails with "working tree has modifications"** — even though `git status` looks clean, the previous merge hasn't fully settled. Run pulls sequentially as separate shell invocations rather than in a `for` loop.

**Plugin installed but tools unavailable** — confirm enabled and gateway restarted:

```bash
openclaw plugins list --verbose
openclaw plugins enable <plugin-id>
openclaw gateway restart
openclaw plugins doctor
```
