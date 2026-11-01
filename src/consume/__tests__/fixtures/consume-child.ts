/**
 * One consumer in its own process, for the cases that need a second pid: a
 * dead holder, and a kill at a chosen point. Consumers in one process share a
 * pid, so their holders never read as gone.
 *
 * It runs one pass over every plugin with its own env as the parent env, and
 * exits with the pass's exit code. The pass is imported from the source tree,
 * so a mutation in shipped code reaches this process too.
 *
 * `CONSUME_CHILD_MODE`:
 * - `plain`: the pass as shipped.
 * - `kill-after-write`: the first `atomicWriteText` (the Judgment) completes,
 *   then the process SIGKILLs itself, before the record is marked.
 *
 * The parent spawns it with an explicit env holding `WARPLINE_HOME`, `PATH`
 * and the mode, so it writes only inside that home.
 */
import { spyOn } from 'bun:test'
import * as fsAtomic from '../../../lib/fs-atomic.js'
import { consumePass, exitCodeFor } from '../../pass.js'

const mode = process.env.CONSUME_CHILD_MODE
if (mode === 'kill-after-write') {
  const write = fsAtomic.atomicWriteText
  spyOn(fsAtomic, 'atomicWriteText').mockImplementation(async (path: string, content: string) => {
    await write(path, content)
    process.kill(process.pid, 'SIGKILL')
  })
} else if (mode !== 'plain') {
  process.stderr.write('CONSUME_CHILD_MODE is not plain or kill-after-write\n')
  process.exit(2)
}

const result = await consumePass({ plugins: null, parentEnv: process.env })
process.stdout.write(JSON.stringify(result))
process.exit(exitCodeFor(result))
