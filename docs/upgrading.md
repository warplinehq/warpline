---
title: Upgrading
diataxis: how-to
---

# Upgrading

What changes between published versions that you have to act on. Each section
names the versions it moves between, says what breaks, and gives the steps.
Read every section between the version you run and the one you install.

## 0.5.1 → 0.6.0

### Plugin names follow one rule (breaking)

A plugin directory name must match `^[a-z][a-z0-9-]{0,63}$`: lowercase letters,
digits and hyphens, a leading letter, at most 64 characters. Its manifest
`name` must equal the directory name, and each `dependencies` entry must follow
the same rule. The rule is published as `PLUGIN_NAME` and `isPluginName` from
`warpline/schemas/plugin-name`.

On 0.5.1 all of these loaded, and on 0.6.0 none does:

- a directory with an uppercase letter or an underscore, such as `Mailer` or
  `issue_render`;
- a directory name over 64 characters;
- a manifest whose `name` differs from its directory.

Such a plugin is a load failure. It does not run, `warpline plan` names it, and
`warpline run` refuses it: a name outside the rule exits 1, and a manifest
whose name differs fails to load. `PluginManifestSchema` from
`warpline/schemas/plugin-manifest` rejects those manifests too, and
`invokePlugin` from `warpline/unstable-runtime` refuses the same names and
manifests the loader does, before it imports anything for a bad name.

To find them before you upgrade, run `warpline plan` on 0.6.0 against a copy
of your home, or check every directory under your plugin root against the
pattern above.

### Renaming a plugin to conform

Rename while no advance is running. For a plugin moving from `old` to `new`:

1. Move the directory: `<plugins>/old` to `<plugins>/new`.
2. Set `name: 'new'` in its `manifest.ts`.
3. Move its config file, if it has one: `<home>/config/old.json` to
   `<home>/config/new.json`.
4. Change `old` to `new` in the `dependencies` of every plugin that names it.
5. Re-approve it. A session grant naming `old` no longer covers `new`, and
   neither does a standing grant. Both fail closed. Issue a new standing grant
   for `new` with `warpline approve new --standing …`, and revoke the old one
   with `warpline revoke --standing <grant-id>`.
6. Re-deny it, if you had denied it. A `denials` entry is keyed by the old
   name and is lost by the rename: run `warpline deny new` again.

State keyed by the old name stays behind and nothing reads it. `plugin_runs`
no longer covers the plugin, so it runs once more on the next advance that
admits it. History is not rewritten: the audit store and the run logs keep the
old name, and they stay readable, because what they carry follows a looser rule
than what the loader admits.
