import { describe, it, expect } from 'bun:test'
import { generateDiff } from '../src/diff'

describe('generateDiff', () => {
  it('returns empty for identical content', () => {
    const result = generateDiff('test.ts', 'hello\nworld', 'hello\nworld')
    expect(result).toBe('')
  })

  it('detects additions', () => {
    const result = generateDiff('test.ts', 'hello', 'hello\nworld')
    expect(result).toContain('--- a/test.ts')
    expect(result).toContain('+++ b/test.ts')
    expect(result).toContain('+world')
  })

  it('detects deletions', () => {
    const result = generateDiff('test.ts', 'hello\nworld', 'hello')
    expect(result).toContain('-world')
  })

  it('handles empty old content', () => {
    const result = generateDiff('new.ts', '', 'new content')
    expect(result).toContain('+new content')
  })

  it('handles large files with truncation', () => {
    const large = Array.from({ length: 1500 }, (_, i) => `line ${i}`).join('\n')
    const modified = large + '\nnew line'
    const result = generateDiff('large.ts', large, modified)
    expect(result).toContain('[File too large to diff')
  })
})
