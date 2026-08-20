---
title: The [needs-llm] contract
diataxis: reference
---

# The `[needs-llm]` contract

Warpline's boundary doctrine (docs/doctrine.md) splits work into deterministic
code and LLM judgment. Plugins are the deterministic half. This document is
the seam between the two: how a plugin *requests* judgment work without ever
calling an LLM itself.

## The contract

A plugin that reaches the edge of what code should decide returns a
`SkillResult` shaped like this:

```jsonc
{
  "status": "skipped",
  "summary": "[needs-llm] Draft distribution posts for 2 articles. Context: <path or inline payload>",
  // ...rest of the normal SkillResult fields
}
```

Three rules, all enforced or honoured by the runtime:

1. **`status: 'skipped'` + a summary starting with `[needs-llm]`** marks the
   result as a successful *handoff*, not a failure. The runtime maps it to the
   `delegated` run status (`deriveRunStatus` in `src/runtime/invoke-plugin.ts`)
   so dashboards and anomaly checks do not paint it red.
2. **Never retried.** Retry logic acts on `retryable: true` failures; a
   delegated handoff is terminal for the plugin. Re-running the plugin later
   (TTL) re-derives the handoff if the work is still outstanding.
3. **The plugin computes everything computable before handing off.** Cadence
   defaults, file paths, dedup keys, the exact list of items needing judgment
   — all pre-resolved into the summary/context payload. The LLM gets a
   decision to make, not a scavenger hunt.

## Who consumes the handoff

A **companion skill** — a Claude Code skill (see `skills/needs-llm-template/`)
that an orchestrating Claude session runs. The loop:

1. Deterministic pass: the engine runs due plugins. The v0.1 entry point is
   programmatic — a host calls `runAdvance()`, exported from the package root.
   To see what a run *would* do without running it, `warpline plan` prints the
   same due-set read-only. Some results come back `delegated`.
2. The orchestrating session (a human-invoked Claude Code session, a scheduled
   agent, or a skill that wraps the engine) scans run artifacts / board events
   for `[needs-llm]` summaries.
3. For each, it dispatches the matching companion skill with the payload. The
   skill does the judgment work (drafting, triage, synthesis) and writes its
   output through whatever gate the host requires.
4. Side effects still go through the approval gate. An LLM drafting an email
   is judgment; SENDING it is a side effect — the draft lands somewhere a
   `sends_email`-declaring plugin (or a human) picks up under approval.

## Why not let the plugin call an LLM API?

- **Auditability** — deterministic plugins produce identical output for
  identical input; the judgment work is quarantined where it can be reviewed.
- **Economics** — the LLM half rides an operator's existing Claude Code
  session/subscription instead of metered API calls inside a cron job.
- **The boundary stays inspectable** — a plugin with no `llm_required`
  capability cannot quietly grow a model dependency; the handoff is visible in
  every run artifact.

## Naming the companion skill

Convention: the skill is named after the plugin (`content-atomiser` plugin →
`content-atomiser` skill) and documents which `[needs-llm]` payload shape it
accepts. The template in `skills/needs-llm-template/` is the starting point.
