/**
 * A preload for the real bin entry, used by run-as.test.ts: `bun --preload
 * <this file> src/bin/warpline.ts consume`. Each claude-code try's deadline is
 * 500 ms instead of `CLAUDE_TIMEOUT_MS`, and nothing else changes, the kill
 * grace included. The bin entry, the dispatcher, the pass and the child's
 * spawn all run as shipped.
 */
import { spyOn } from 'bun:test'
import * as cc from '../../claude-code.js'

// Read BEFORE `spyOn`: afterwards the namespace property is the mock.
const real = cc.renderClaudeCode
spyOn(cc, 'renderClaudeCode').mockImplementation((o: Parameters<typeof cc.renderClaudeCode>[0]) =>
  real({ ...o, timeoutMs: 500 }),
)
