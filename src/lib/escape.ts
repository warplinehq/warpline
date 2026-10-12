/**
 * escape — the one escape for bytes a plugin wrote that reach an operator's
 * terminal.
 */

/**
 * The producer's bytes as the operator will actually read them: every control
 * character visible, nothing removed and nothing cut short.
 *
 * One copy, with two callers: `warpline approve --content`, before it records
 * a yes, and `warpline approvals show`, which prints an Ask's content and its
 * diff. A second copy would let the two drift on what reaches a terminal. The
 * rules, in order:
 *
 *   1. Escape a literal backslash to two, FIRST, so an escape this function
 *      emitted is tellable apart from a backslash the plugin authored.
 *   2. Replace every C0 control character (U+0000 through U+001F) except LF and
 *      TAB, plus DEL (U+007F), and every C1 control character (U+0080 through
 *      U+009F), with a visible `\xNN` escape. ESC renders `\x1b` and BEL
 *      renders `\x07` out of that general form rather than by a special case.
 *      Escape, never strip: stripping removes the evidence that an attack was
 *      attempted, and seeing what is actually in the bytes is the operator's
 *      whole job here.
 *   3. Never truncate, at any size. The Output schema bounds an inline body at
 *      16 KiB, and cutting would hide the tail — which is where a long batch's
 *      surprises live. A `path` Output that `approvals show` reads from its
 *      file has no size bound in this release, so a large file prints whole.
 *   4. Leave LF and TAB alone. Line and column structure is the thing being
 *      reviewed, and escaping it would make a multi-line batch unreadable.
 *
 * Rules 1 and 2 are ONE pass over the string, which is what makes "backslash
 * first" true without a second pass re-escaping its own output.
 *
 * The ceiling, stated because it is real: a body may carry plain text that
 * imitates the delimiters or the fingerprint line. Escaping cannot prevent
 * that; it prevents REPAINTING, which is what the control characters would have
 * done, and repainting is the difference between a forgery the operator can see
 * and one they cannot. The fingerprint is printed before the body, so a forged
 * copy inside it arrives after the one the runtime computed.
 */
export function escapeForOperator(body: string): string {
  // A character loop rather than a regex character class: the bounds below are
  // numbers a reader can check against the four rules above, where a class of
  // unicode escapes is a line nobody proof-reads.
  let out = ''
  for (const ch of body) {
    if (ch === '\\') {
      out += '\\\\'
      continue
    }
    const code = ch.charCodeAt(0)
    const control =
      (code < 0x20 && ch !== '\n' && ch !== '\t') ||
      code === 0x7f ||
      (code >= 0x80 && code <= 0x9f)
    out += control ? `\\x${code.toString(16).padStart(2, '0')}` : ch
  }
  return out
}
