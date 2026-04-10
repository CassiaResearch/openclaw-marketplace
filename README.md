# OpenClaw Plugin Marketplace

Internal plugin registry for the team. Plugins live here as git subtrees so they can be installed directly via OpenClaw's `--marketplace` flag without going through the public ClawHub registry.

## Structure

```
openclaw-marketplace/
├── marketplace.json        ← registry index (required)
├── README.md
└── plugins/
    ├── composio/           ← subtree from yourorg/openclaw-composio-plugin
    └── another-plugin/     ← subtree from yourorg/another-plugin
```

Each plugin is a subdirectory containing at minimum an `openclaw.plugin.json` manifest. `marketplace.json` is the index OpenClaw reads to find them by name.

> **Constraint:** `marketplace.json` entries must use relative paths. OpenClaw rejects any entry pointing to an external URL or absolute path, so plugin code must physically live inside this repo.

---

## Installing a Plugin

```bash
openclaw plugins install copilotai-composio --marketplace https://github.com/CassiaResearch/openclaw-marketplace
openclaw gateway restart
```

Then set any required config:

```bash
openclaw config set plugins.entries.composio-internal.config.consumerKey "ck_..."
```

---

## Adding a Plugin from an External Repo

Use this when forking a community plugin (e.g. `ComposioHQ/openclaw-composio-plugin`).

**1. Fork the upstream repo** to your org on GitHub (e.g. `CassiaResearch/openclaw-composio-plugin`). This fork is where you'll merge upstream changes before they land here.

**2. Confirm it has `openclaw.plugin.json`** at the root. If it's npm-only with no manifest, it can't be served from a marketplace — install it directly from npm instead.

**3. Add it as a subtree** (run from the marketplace repo root, on a clean working tree):

```bash
git subtree add --prefix plugins/composio \
  https://github.com/CassiaResearch/openclaw-composio-plugin.git master --squash
```

**4. Update the plugin ID** in `plugins/composio/openclaw.plugin.json` and `plugins/composio/index.ts` to avoid clashing with the upstream npm package:

```json
{
  "id": "copilotai-composio",
  "name": "Composio (Internal)",
  "version": "1.0.0",
  ...
}
```

**5. Register it in `marketplace.json`:**

```json
{
  "name": "cassia-openclaw-marketplace",
  "version": "1.0.0",
  "owner": "Cassia Research",
  "plugins": [
    {
      "name": "copilotai-composio",
      "description": "Composio MCP integration (internal build)",
      "source": "./plugins/composio"
    }
  ]
}
```

**6. Commit and push:**

```bash
git add plugins/composio marketplace.json
git commit -m "feat: add composio plugin"
git push
```

---

## Modifying a Plugin

Edit files directly inside `plugins/<n>/` — these are regular commits in this repo and survive future subtree pulls via merge.

```bash
code plugins/composio/index.ts

# Bump the version so OpenClaw detects an update
# Then commit — always commit before running a subtree pull
git add plugins/composio
git commit -m "fix: update composio MCP endpoint"
git push

git subtree push --prefix plugins/composio https://github.com/CassiaResearch/openclaw-composio-plugin.git master
```

Team members pick up the change:

```bash
openclaw plugins update copilotai-composio
openclaw gateway restart
```

---

## Syncing Upstream Changes

When the original upstream repo ships updates, pull them into your fork first, then into here.

**1. Merge upstream into your fork** (run in `CassiaResearch/openclaw-composio-plugin`):

```bash
git remote add upstream git@github.com:ComposioHQ/openclaw-composio-plugin.git
git fetch upstream
git merge upstream/master
git push origin master
```

> `git remote add upstream` is one-time only. On future syncs just `git fetch upstream && git merge upstream/master`.

**2. Pull the fork into the marketplace** (run in this repo, on a clean working tree):

```bash
git subtree pull --prefix plugins/composio \
  git@github.com:yourorg/openclaw-composio-plugin.git master --squash
```

> ⚠️ Review `openclaw.plugin.json` after the pull — the upstream version won't have your internal `id`. Don't let it get overwritten.

**3. Bump the version and push:**

```bash
git add plugins/composio/openclaw.plugin.json
git commit -m "chore: sync composio upstream vX.Y.Z"
git push
git subtree push --prefix plugins/composio https://github.com/CassiaResearch/openclaw-composio-plugin.git master
```

---

## Removing a Plugin

Remove it from `marketplace.json`, then optionally delete the directory:

```bash
rm -rf plugins/my-old-plugin
git add -A
git commit -m "chore: remove my-old-plugin"
git push
```

Removing from `marketplace.json` stops new installs. Existing installs are unaffected until someone runs:

```bash
openclaw plugins uninstall my-old-plugin
```

---

## Reference

### marketplace.json

| Field              | Description                                                  |
| ------------------ | ------------------------------------------------------------ |
| `name`             | Marketplace identifier used in install shorthands            |
| `owner`            | GitHub org/user                                              |
| `plugins[].name`   | Name used in `openclaw plugins install <n>@...`              |
| `plugins[].source` | Relative path to the plugin directory — must start with `./` |

### openclaw.plugin.json

| Field               | Required    | Description                                                             |
| ------------------- | ----------- | ----------------------------------------------------------------------- |
| `id`                | Yes         | Unique kebab-case identifier. Don't reuse an upstream npm package name. |
| `version`           | Yes         | Semver. Bump on every change so OpenClaw detects updates.               |
| `pluginApi`         | Yes         | Currently `"1.0"`                                                       |
| `minGatewayVersion` | Recommended | Minimum gateway version required, e.g. `"2026.1.0"`                     |
| `configSchema`      | Yes         | JSON Schema for config. Use `{}` if no config needed.                   |

---

## Troubleshooting

**`plugin source not found` on install** — the `source` path in `marketplace.json` doesn't match the actual directory. Ensure it's a relative path (`./plugins/composio`) and that `openclaw.plugin.json` exists inside it.

**`incompatible pluginApi`** — run `openclaw update` to upgrade your gateway, or check if you accidentally pulled a newer manifest from upstream.

**Marketplace clone fails** — SSH credentials aren't set up. Run `gh auth login` or configure SSH access for `github.com/yourorg`.

**Changes not showing after `plugins update`** — force a cache refresh:

```bash
openclaw plugins marketplace update yourorg-openclaw-marketplace
openclaw plugins update <plugin-id>
openclaw gateway restart
```

**Plugin installed but tools unavailable** — check it's enabled and the gateway has restarted:

```bash
openclaw plugins list --verbose
openclaw plugins enable <plugin-id>
openclaw gateway restart
openclaw plugins doctor   # surfaces load errors
```

**`git subtree pull` fails with a dirty working tree** — commit or stash any uncommitted changes first. Subtree operations require a clean working directory.
