import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { executeTool } from '../src/tools'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

let tempDir: string

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'luna-test-'))
  process.env.LUNA_CWD = tempDir
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
  delete process.env.LUNA_CWD
})

describe('executeTool', () => {
  it('handles read_file and write_file', async () => {
    const writeCall = {
      id: '1',
      type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ path: 'foo.txt', content: 'hello world' }) },
    }
    const writeResult = await executeTool(writeCall)
    expect(writeResult).toBe('written foo.txt')

    const readCall = {
      id: '2',
      type: 'function',
      function: { name: 'read_file', arguments: JSON.stringify({ path: 'foo.txt' }) },
    }
    const readResult = await executeTool(readCall)
    expect(readResult).toBe('hello world')
  })

  it('handles edit_file', async () => {
    // create file first
    const initCall = {
      id: '3',
      type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ path: 'bar.txt', content: 'abc 123' }) },
    }
    await executeTool(initCall)
    const editCall = {
      id: '4',
      type: 'function',
      function: { name: 'edit_file', arguments: JSON.stringify({ path: 'bar.txt', oldString: '123', newString: '456' }) },
    }
    const editResult = await executeTool(editCall)
    expect(editResult).toBe('edited bar.txt')
    const readCall = {
      id: '5',
      type: 'function',
      function: { name: 'read_file', arguments: JSON.stringify({ path: 'bar.txt' }) },
    }
    const finalContent = await executeTool(readCall)
    expect(finalContent).toBe('abc 456')
  })

  it('handles bash command', async () => {
    const bashCall = {
      id: '6',
      type: 'function',
      function: { name: 'bash', arguments: JSON.stringify({ command: 'echo hello', description: 'test' }) },
    }
    const result = await executeTool(bashCall)
    // exec adds a trailing newline
    expect(result.trim()).toBe('hello')
  })

  it('handles glob', async () => {
    // create two files
    const aWrite = { id: '7', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: '' }) } };
    await executeTool(aWrite);
    const bWrite = { id: '8', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'b.md', content: '' }) } };
    await executeTool(bWrite);
    const globCall = {
      id: '9',
      type: 'function',
      function: { name: 'glob', arguments: JSON.stringify({ pattern: '**/*.txt' }) },
    }
    const result = await executeTool(globCall)
    expect(result.split('\n')).toContain('a.txt')
    expect(result).not.toContain('b.md')
  })
})
