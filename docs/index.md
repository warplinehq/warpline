---
title: Documentation
diataxis: reference
---

# warpline documentation

Everything published about warpline, in reading order. If you have never run a
plugin, start at the top and work down.

- [first-plugin.md](first-plugin.md) — **start here**: build, run and gate a plugin in ten minutes
- [doctrine.md](doctrine.md) — the deterministic/LLM boundary
- [runtime-spec.md](runtime-spec.md) — manifest fields, retry/timeout/abort semantics, run artifacts
- [board-spec.md](https://github.com/warplinehq/warpline/blob/main/docs/board-spec.md)
  — the Board: objects, Ask lifecycle, places, form, file formats. The board is a repo-only surface
  at 0.1, so this spec is not shipped in the package and the link is absolute.
- [needs-llm-contract.md](needs-llm-contract.md) — the LLM handoff protocol
- [plugin-authoring.md](plugin-authoring.md) — writing and testing plugins
- [why-the-gate-holds.md](why-the-gate-holds.md) — the long argument: why the gate holds, and the objections it has to survive
