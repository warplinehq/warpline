/**
 * Reading what a declared dependency last produced.
 *
 * `plugin_runs[name].last_output` already exists. The engine writes it on both
 * arms, the Board reads it to name an Output without scanning the runs
 * directory, and until now no plugin could see it at all. This module is that
 * read and nothing else, so it is worth saying plainly what it is not.
 *
 * **It is not a store.** It takes the `EngineState` as a parameter rather than
 * loading one. A module that loaded state would be a second place the answer to
 * "what did my dependency produce" comes from, and the two could disagree — the
 * run-log pruning rule applies by mtime to the runs directory and not to the
 * state document, so the disagreement would be a real one and would arrive on a
 * schedule nobody was watching.
 *
 * **It is not a freshness check.** `isPluginFresh`, next door, already answers
 * "has anything changed upstream" from `plugin_runs[dep].last_run_at`. The
 * record returned here carries no verdict about its own age and this module
 * imports nothing that could compute one. Two answers to that question is the
 * failure being refused; one of them being subtly better is not a defence.
 *
 * **It does not read the filesystem.** It is a pure function over a value the
 * caller supplies, which is also what makes it testable from a literal. Note
 * that an Output may carry a `path` rather than a `body`; resolving that path
 * is the caller's business, and doing it here is how this module would acquire
 * the disk access the sentence above rules out.
 *
 * The one thing it decides is the refusal. An undeclared name throws instead of
 * reading, so a dependency graph stays a declaration rather than a suggestion.
 */
import type { EngineState } from '../schemas/engine-state.js'
import type { PluginManifest } from '../schemas/plugin-manifest.js'
import type { OutputRecord } from '../schemas/skill-result.js'

/**
 * The Output a declared dependency last produced, or `null` if it has produced
 * none.
 *
 * `null` covers both "has never run" and "ran and produced nothing" on purpose:
 * from a reader's side those are one state, and splitting them would make the
 * caller branch on a difference it cannot act on.
 *
 * An **undeclared** name is a different matter and throws. Returning `null` for
 * it would make a typo in `manifest.dependencies` indistinguishable from a
 * dependency that has not run yet — the same value, two unrelated fixes, and
 * the wrong one is the one that looks like waiting. The message names the
 * requested dependency and the manifest field that must list it, and never the
 * state it was read against.
 */
export function readDependencyOutput(
  state: EngineState,
  manifest: PluginManifest,
  dependencyName: string,
): OutputRecord | null {
  if (!manifest.dependencies.includes(dependencyName)) {
    throw new Error(
      `Plugin '${manifest.name}' requested the Output of '${dependencyName}', which it does not ` +
        `declare: add '${dependencyName}' to manifest.dependencies, an array of plugin names, ` +
        `before reading it.`,
    )
  }

  return state.plugin_runs[dependencyName]?.last_output ?? null
}
