---
title: Upgrading
diataxis: how-to
---

# Upgrading

What changes between published versions that you have to act on. Each section
names the versions it moves between, says what breaks, and gives the steps.
Read every section between the version you run and the one you install.

## 0.6.0 → 0.7.0

### A handoff from a plugin with no side effect is never parked (breaking)

On 0.6.0, a `[needs-llm]` handoff from a plugin under `review_gate: true`, or
declaring `autonomy_level: 'supervised'`, parked in `pending_gates` and stopped
the advance after its level, whether or not the plugin declared a side effect.
On 0.7.0, a declared handoff from a plugin with `side_effects: []` is never
parked. Its run log entry reads `completed`, `plugin_runs` reads `skipped`, and
the advance goes on. A dependent reads its Output in the same advance, before
anyone has reviewed it. `gated`, `pending_gates` and `--strict` no longer count
it.

If you relied on that park to review an effect-free handoff before its
dependents ran, put the review on the dependent instead. A dependent that
declares a side effect still needs its own approval, and its result is still
parked under the review gate. A handoff from a plugin that declares a side
effect parks as before.

### The `needs-llm` scanner reads Handoff records (breaking)

Each declared handoff an advance or `warpline run` makes is now written to
`<home>/handoffs/<run_id>.<plugin>.json`. The `needs-llm` skill in the
`warpline` Claude Code plugin globs that directory and keeps the records whose
`state` is `open`. It no longer reads `<home>/runs/`.

1. Before you upgrade, pick up every outstanding handoff with the 0.6.0 skill.
   A handoff made before the upgrade has no record, so the 0.7.0 skill doesn't
   find it.
2. Upgrade the runtime and the Claude Code plugin together.

`warpline run` still writes its `delegated` run artifact as before.

### A handoff that can't be recorded fails (breaking)

`<home>/handoffs/` must be writable. If the record can't be written, the
plugin's result is `failed` with summary `<plugin>: handoff not recorded`, its
dependents skip as `dependency_failed`, and `warpline run` reports `ok: false`.
A caller of `invokePlugin` from `warpline/unstable-runtime` that passes its own
`runsDir` gets a `handoffs/` directory beside that directory.

### `--strict` counts only gates that can still be applied

A gate past its plugin's `ttl_hours`, one a later run superseded, one whose
dependency re-ran, and one missing either run clock are no longer counted in
`pending_gates`, so `--strict` no longer exits `1` for them. `approve` already
refused each of them on 0.6.0.

### Turning on `notify`

Nothing is sent until you set `notify` in `preferences.json`. Once you do, a
bare `approve <plugin>`, `approve <plugin> --content`, `deny <plugin>` or
`renew <grant-id>` exits `1` with nothing written while an Ask it could answer
is open. Scripts that call those forms must answer with `--nonce`, `--digest`
and `--principal`, or run before `notify` is set.

### Downgrading

0.6.0 refuses a `preferences.json` that carries `notify`. Run
`warpline prefs set notify null` before you downgrade. `asks.json` and
`handoffs/` are left in place, and 0.6.0 doesn't read them.

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
