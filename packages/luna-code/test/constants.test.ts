import { describe, it, expect } from 'bun:test'

describe('constants', () => {
  it('exports OLLAMA_URL with default', async () => {
    const { OLLAMA_URL } = await import('../src/constants')
    expect(OLLAMA_URL).toBe('http://localhost:11434')
  })

  it('exports MODEL with default', async () => {
    const { MODEL } = await import('../src/constants')
    expect(MODEL).toBe('gpt-oss:120b-cloud')
  })
})
