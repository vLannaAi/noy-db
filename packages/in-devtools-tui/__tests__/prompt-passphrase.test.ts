import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import { promptMasked } from '../src/prompt-passphrase.js'

describe('promptMasked', () => {
  it('reads a line, echoes a mask char per keypress, never the plaintext', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let echoed = ''
    output.on('data', (c) => { echoed += c.toString() })
    const p = promptMasked('Passphrase: ', { input, output })
    input.write('s3cr3t')
    input.write('\r')
    const value = await p
    expect(value).toBe('s3cr3t')
    expect(echoed).toContain('Passphrase: ')
    expect(echoed).not.toContain('s3cr3t')
    expect((echoed.match(/•/g) ?? []).length).toBe(6)
  })
})
