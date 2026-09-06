/**
 * RED stub: loads, exports the two names, writes nothing.
 */
export interface ConfigureIo {
  input: NodeJS.ReadableStream & { isTTY?: boolean }
  output: NodeJS.WritableStream
}

const USAGE = 'Usage: warpline configure <plugin> [--from <json>]\n'

export async function run(_argv: string[], _io?: ConfigureIo): Promise<number> {
  process.stderr.write(USAGE)
  return 1
}

export async function writePluginConfig(
  _pluginName: string,
  _values: Record<string, unknown>,
): Promise<{ written: string[]; needed: string[]; secrets: string[] }> {
  return { written: [], needed: [], secrets: [] }
}
