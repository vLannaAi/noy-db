import type { Readable, Writable } from 'node:stream'

export interface PromptStreams {
  input?: Readable & { setRawMode?: (mode: boolean) => void }
  output?: Writable
}

/**
 * Read a line from `input` without echoing the plaintext; emit one `•` per
 * character to `output`. Returns the typed string (Enter terminates).
 * Never logs/persists the value.
 */
export function promptMasked(question: string, streams: PromptStreams = {}): Promise<string> {
  const input = (streams.input ?? process.stdin) as Readable & { setRawMode?: (m: boolean) => void }
  const output = streams.output ?? process.stdout
  return new Promise<string>((resolve, reject) => {
    output.write(question)
    input.setRawMode?.(true)
    let buf = ''
    const onData = (chunk: Buffer | string) => {
      const s = chunk.toString()
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') {
          output.write('\n')
          input.setRawMode?.(false)
          input.removeListener('data', onData)
          resolve(buf)
          return
        }
        if (ch === '\x03') { // Ctrl-C — abort
          output.write('\n')
          input.setRawMode?.(false)
          input.removeListener('data', onData)
          reject(new Error('aborted'))
          return
        }
        if (ch === '\x7f' || ch === '\x08') { // DEL / Backspace
          if (buf.length > 0) { buf = buf.slice(0, -1); output.write('\b \b') }
          continue
        }
        buf += ch
        output.write('•')
      }
    }
    input.on('data', onData)
  })
}
