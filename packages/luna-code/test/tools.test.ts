import { describe, it, expect } from 'bun:test'
import { normalizeToolName, parseToolArgs, normalizeToolCall, coerceTextToolCall, makeToolCall } from '../src/tools'
import type { ToolCall } from '../src/types'

describe('normalizeToolName', () => {
  it('accepts known tools', () => {
    expect(normalizeToolName('read_file')).toBe('read_file')
    expect(normalizeToolName('write_file')).toBe('write_file')
    expect(normalizeToolName('edit_file')).toBe('edit_file')
    expect(normalizeToolName('bash')).toBe('bash')
    expect(normalizeToolName('glob')).toBe('glob')
    expect(normalizeToolName('search')).toBe('search')
    expect(normalizeToolName('grep')).toBe('grep')
  })

  it('rejects unknown tools', () => {
    expect(normalizeToolName('unknown_tool')).toBeNull()
    expect(normalizeToolName('')).toBeNull()
  })
})

describe('parseToolArgs', () => {
  it('parses valid JSON', () => {
    expect(parseToolArgs('{"path": "foo.ts"}')).toEqual({ path: 'foo.ts' })
  })

  it('returns null for invalid JSON', () => {
    expect(parseToolArgs('not json')).toBeNull()
  })

  it('returns null for arrays', () => {
    expect(parseToolArgs('["a", "b"]')).toBeNull()
  })
})

describe('normalizeToolCall', () => {
  it('normalizes a valid tool call', () => {
    const tc: ToolCall = { id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }
    const result = normalizeToolCall(tc)
    expect(result).not.toBeNull()
    expect(result!.function.name).toBe('bash')
  })

  it('returns null for unknown tool', () => {
    const tc: ToolCall = { id: 'call_1', type: 'function', function: { name: 'unknown', arguments: '{}' } }
    expect(normalizeToolCall(tc)).toBeNull()
  })

  it('returns null for invalid args', () => {
    const tc: ToolCall = { id: 'call_1', type: 'function', function: { name: 'bash', arguments: 'not json' } }
    expect(normalizeToolCall(tc)).toBeNull()
  })
})

describe('coerceTextToolCall', () => {
  it('extracts tool call from JSON block', () => {
    const content = '```json\n{"name": "read_file", "arguments": {"path": "foo.ts"}}\n```'
    const result = coerceTextToolCall(content)
    expect(result).not.toBeUndefined()
    expect(result![0].function.name).toBe('read_file')
  })

  it('extracts bash command from object', () => {
    const content = '```\n{"command": "ls -la", "description": "list files"}\n```'
    const result = coerceTextToolCall(content)
    expect(result).not.toBeUndefined()
    expect(result![0].function.name).toBe('bash')
  })

  it('returns undefined for plain text', () => {
    expect(coerceTextToolCall('hello world')).toBeUndefined()
  })
})

describe('makeToolCall', () => {
  it('creates a valid tool call', () => {
    const tc = makeToolCall('read_file', { path: 'test.ts' })
    expect(tc).not.toBeNull()
    expect(tc!.function.name).toBe('read_file')
    expect(JSON.parse(tc!.function.arguments)).toEqual({ path: 'test.ts' })
  })

  it('returns null for unknown tool', () => {
    expect(makeToolCall('unknown', {})).toBeNull()
  })
})
