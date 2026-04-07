/**
 * Tests for the `create-noy-db` bin's argv parser. The parser is pure,
 * so these tests run without spawning a process.
 */

import { describe, expect, it } from 'vitest'
import { parseArgs } from '../src/bin/parse-args.js'

describe('parseArgs', () => {
  it('handles no arguments', () => {
    expect(parseArgs([])).toEqual({ options: {}, help: false })
  })

  it('parses a positional project name', () => {
    const { options } = parseArgs(['my-app'])
    expect(options.projectName).toBe('my-app')
  })

  it('parses -y as yes', () => {
    expect(parseArgs(['-y']).options.yes).toBe(true)
  })

  it('parses --yes as yes', () => {
    expect(parseArgs(['--yes']).options.yes).toBe(true)
  })

  it('parses --adapter browser', () => {
    expect(parseArgs(['--adapter', 'browser']).options.adapter).toBe('browser')
  })

  it('parses --adapter file', () => {
    expect(parseArgs(['--adapter', 'file']).options.adapter).toBe('file')
  })

  it('parses --adapter memory', () => {
    expect(parseArgs(['--adapter', 'memory']).options.adapter).toBe('memory')
  })

  it('rejects an unknown adapter', () => {
    expect(() => parseArgs(['--adapter', 's3'])).toThrow(/browser, file, memory/)
  })

  it('rejects a missing --adapter value', () => {
    expect(() => parseArgs(['--adapter'])).toThrow(/browser, file, memory/)
  })

  it('parses --no-sample-data', () => {
    expect(parseArgs(['--no-sample-data']).options.sampleData).toBe(false)
  })

  it('parses --help', () => {
    expect(parseArgs(['--help']).help).toBe(true)
  })

  it('parses -h', () => {
    expect(parseArgs(['-h']).help).toBe(true)
  })

  it('combines positional name and flags', () => {
    const { options } = parseArgs(['my-app', '--yes', '--adapter', 'file', '--no-sample-data'])
    expect(options.projectName).toBe('my-app')
    expect(options.yes).toBe(true)
    expect(options.adapter).toBe('file')
    expect(options.sampleData).toBe(false)
  })

  it('rejects unknown flags', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown option/)
  })

  it('rejects a second positional argument', () => {
    expect(() => parseArgs(['one', 'two'])).toThrow(/positional/)
  })
})
