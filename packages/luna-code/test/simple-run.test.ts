import { describe, it, expect, beforeEach, afterEach, vi } from 'bun:test'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'luna-simple-'))
  process.env.LUNA_CWD = tempDir
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
  delete process.env.LUNA_CWD
  vi.restoreAllMocks()
})

// Helper to create a mock streaming response compatible with callOllamaStream internals
function createMockStream(chunks: string[]) {
  let idx = 0
  return {
    getReader() {
      return {
        async read() {
          if (idx >= chunks.length) return { done: true, value: undefined as any }
          const value = new TextEncoder().encode(chunks[idx++])
          return { done: false, value }
        },
      }
    },
  }
}

describe('simpleRun integration', () => {
  it('writes a file via tool call and finishes', async () => {
    // Import after env is set so CWD is captured correctly
    const { simpleRun } = await import('../src/index')
    // Mock fetch inside ollama.ts via the exported callOllamaStream
    const firstChunk = JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'write_file', arguments: JSON.stringify({ path: 'test.txt', content: 'hello' }) } }] } }],
    })
    const secondChunk = JSON.stringify({ choices: [{ delta: { content: 'Done' } }] })
    const mockResponse = {
      ok: true,
      body: createMockStream([`data: ${firstChunk}\n`, `data: ${secondChunk}\n`, 'data: [DONE]\n']),
    } as any
    vi.spyOn(global, 'fetch').mockResolvedValue(mockResponse)
    await simpleRun('dummy prompt')
    const result = await import('node:fs').then(m => m.readFileSync(join(tempDir, 'test.txt'), 'utf-8'))
    expect(result).toBe('hello')
  })
})

