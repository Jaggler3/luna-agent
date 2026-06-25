import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect } from 'luna-gateway'
import type { Connection } from 'luna-gateway'
import { AGENT_TIMEOUT_MS, APP_ROOT, currentWorkspaceCwd, log } from '../config'
import { agents, activeAgent, saveMeta, saveConversation, socketPath, storeEmitter } from '../store'
import type { AgentData } from '../types'
import { BrailleBreathe } from './braille'

const BOILERPLATE_AGENT_SOURCE = `import { simpleRun } from 'luna-code'
import { createServer } from 'luna-gateway'

const transport = (process.env.LUNA_TRANSPORT as 'socket' | undefined) ?? 'stdio'

const server = createServer({
  agentId: process.env.AGENT_ID ?? 'agent',
  transport,
  socketPath: process.env.LUNA_SOCKET_PATH,
  handler: async (prompt, emit) => {
    await simpleRun(prompt, {
      onToolCall: (name, args, diff) => emit({ type: 'tool_call', name, args, diff }),
      onToolResult: (name, result, toolCallId) => emit({ type: 'tool_result', name, result, toolCallId }),
      onToken: (token) => emit({ type: 'token', content: token }),
      onReasoning: (chunk) => emit({ type: 'reasoning', content: chunk }),
    })
    emit({ type: 'done' })
  },
})

await server.listen()
`

export function isPidRunning(pid: number): boolean {
  try { return process.kill(pid, 0) }
  catch { return false }
}

export function checkHealth() {
  try {
    for (const [, a] of agents) {
      if (a.meta.pid) {
        const wasRunning = a.isRunning
        a.isRunning = isPidRunning(a.meta.pid)
        if (wasRunning && !a.isRunning) {
          log('agent died', a.id)
          if (a.animTimer) { clearInterval(a.animTimer); a.animTimer = null }
          a.streamFrame = ''
          if (a.anim) a.anim.free()
          if (a.timeout) { clearTimeout(a.timeout); a.timeout = null }
          if (a.conn) {
            try { a.conn.kill() } catch { }
          }
        }
      } else {
        a.isRunning = false
      }
    }
    storeEmitter.emit('health-checked')
  } catch (e) { log('checkHealth error', e) }
}

function waitForSocketFile(sockPath: string, timeout: number): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    function poll() {
      try {
        if (existsSync(sockPath)) { resolve(); return }
      } catch { }
      if (Date.now() - start > timeout) {
        reject(new Error('Agent socket did not appear'))
      } else {
        setTimeout(poll, 200)
      }
    }
    poll()
  })
}

export async function startAgent(id: string): Promise<Connection | null> {
  log('startAgent begin', id)
  const entrypoint = join(APP_ROOT, 'src', 'agent.ts')
  const sockPath = socketPath(id)
  const meta = agents.get(id)?.meta ?? { name: 'agent', pid: null, createdAt: new Date().toISOString(), cwd: currentWorkspaceCwd() }
  if (!meta.cwd) { meta.cwd = currentWorkspaceCwd(); saveMeta(id, meta) }
  try { unlinkSync(sockPath) } catch { }

  const conn = connect({
    agentId: id,
    entrypoint,
    transport: 'socket',
    socketPath: sockPath,
    spawnCwd: APP_ROOT,
    workspaceCwd: meta.cwd,
  })
  log('connect() returned, child.pid:', conn.child?.pid)

  if (conn.child?.pid) { meta.pid = conn.child.pid; saveMeta(id, meta); log('saved pid', meta.pid) }

  try {
    await waitForSocketFile(sockPath, 10000)
    log('socket file appeared', sockPath)
  } catch (e) {
    log('socket file never appeared', e)
    conn.child?.kill()
    return null
  }
  log('startAgent success', id)
  return conn
}

export async function ensureRunning(a: AgentData): Promise<void> {
  log('ensureRunning begin', a.id, 'conn:', !!a.conn, 'running:', a.isRunning)
  if (a.conn && a.isRunning) { log('ensureRunning already running'); return }
  if (a.conn) { try { a.conn.kill() } catch { }; a.conn = null }
  a.conn = await startAgent(a.id).catch((e) => { log('startAgent failed', e); return null })
  a.isRunning = a.conn !== null
  log('ensureRunning done, running:', a.isRunning)
  if (!a.conn) {
    a.messages.push({ role: 'system', content: 'failed to start agent', error: true })
    saveConversation(a.id, a.messages)
    storeEmitter.emit('update')
  }
  storeEmitter.emit('health-checked')
}

export async function deriveConversationName(prompt: string): Promise<string | null> {
  const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434'
  const MODEL = process.env.LUNA_MODEL ?? 'gpt-oss:120b-cloud'
  try {
    const res = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: 'Generate a very short title (max 15 characters, ideally 1-3 words) for this coding conversation. Respond with ONLY the title, no quotes, no punctuation.' },
          { role: 'user', content: prompt },
        ],
      }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { choices: { message: { content: string } }[] }
    return data.choices[0].message.content.trim().slice(0, 15) || null
  } catch { return null }
}

function summarizeToolArgs(name: string, args: string): string {
  let parsed: any = null
  try { parsed = JSON.parse(args) } catch { }
  if (!parsed || typeof parsed !== 'object') return args.slice(0, 240)
  switch (name) {
    case 'read_file': return String(parsed.path ?? '')
    case 'glob': return String(parsed.pattern ?? '')
    case 'grep': return `${String(parsed.pattern ?? '')}${parsed.include ? ` in ${parsed.include}` : ''}`
    case 'search': return `${String(parsed.query ?? '')} in ${String(parsed.path ?? '.')}`
    case 'bash': return String(parsed.command ?? '').slice(0, 240)
    case 'write_file':
    case 'edit_file': return String(parsed.path ?? '')
    default: return JSON.stringify(parsed).slice(0, 240)
  }
}

function summarizeToolResult(result: string): string {
  const singleLine = result.replace(/\s+/g, ' ').trim()
  return singleLine.length > 360 ? `${singleLine.slice(0, 360)}...` : singleLine
}

function appendAssistantTrace(msg: { reasoning: string }, line: string) {
  msg.reasoning = msg.reasoning ? `${msg.reasoning}\n${line}` : line
}

function clearCoercedToolPayload(msg: { content: string }) {
  const trimmed = msg.content.trim()
  if (!trimmed) return
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) msg.content = ''
}

function timeoutForAgent(a: AgentData): number {
  const timeoutMs = a.meta.timeoutMs
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : AGENT_TIMEOUT_MS
}

export async function sendMessage(text: string) {
  const a = activeAgent()
  log('sendMessage', text.slice(0, 50), 'agent:', a?.id, 'busy:', a?.isBusy)
  if (!a || a.isBusy) { log('sendMessage skipped'); return }
  a.isBusy = true
  storeEmitter.emit('update')

  await ensureRunning(a)
  if (!a.conn) {
    a.messages.push({ role: 'system', content: 'agent not available', error: true })
    saveConversation(a.id, a.messages)
    a.isBusy = false
    storeEmitter.emit('update')
    storeEmitter.emit('focus-input')
    return
  }
  log('sendMessage connection ready')

  a.messages.push({ role: 'user', content: text })
  saveConversation(a.id, a.messages)
  storeEmitter.emit('update')

  const historyMessages = a.messages.slice(-10)
  const contextPrompt = historyMessages.map(m =>
    m.role === 'user' ? `user: ${m.content}` : `assistant: ${m.content}`
  ).join('\n\n')

  if (a.meta.name === 'agent' && !a.namingPromise) {
    a.namingPromise = deriveConversationName(text).then((name) => {
      if (name) { a.meta.name = name; saveMeta(a.id, a.meta); storeEmitter.emit('name-updated') }
    })
  }

  const agentMsg = { role: 'assistant' as const, content: '', reasoning: '', thinkingExpanded: true }
  a.messages.push(agentMsg)
  storeEmitter.emit('update')

  a.conn.send(contextPrompt)
  log('sendMessage sent with context')

  const anim = new BrailleBreathe()
  a.anim = anim
  a.streamFrame = anim.step()
  a.animTimer = setInterval(() => {
    a.streamFrame = anim.step()
    storeEmitter.emit('update')
  }, 80)

  const timeoutMs = timeoutForAgent(a)
  a.timeout = setTimeout(() => {
    log('sendMessage timeout')
    if (a.animTimer) { clearInterval(a.animTimer); a.animTimer = null }
    a.streamFrame = ''
    anim.free()
    storeEmitter.emit('stream-end')
    a.messages.push({ role: 'system', content: `timed out waiting for agent after ${timeoutMs}ms`, error: true })
    saveConversation(a.id, a.messages)
    a.isBusy = false
    storeEmitter.emit('update')
    storeEmitter.emit('focus-input')
  }, timeoutMs)

  const iter = a.conn.receive()
  try {
    while (true) {
      const result = await iter.next()
      if (result.done) { log('sendMessage receive loop done (connection closed)'); break }
      const msg = result.value
      switch (msg.type) {
        case 'token': {
          storeEmitter.emit('stream-start')
          agentMsg.content += msg.content as string
          storeEmitter.emit('update')
          break
        }
        case 'reasoning': {
          storeEmitter.emit('stream-start')
          agentMsg.reasoning += msg.content as string
          storeEmitter.emit('update')
          break
        }
        case 'tool_call': {
          const name = msg.name
          const diff = msg.diff
          const args = msg.args
          let parsed: any = {}
          try { parsed = JSON.parse(args) } catch { }
          if ((name === 'write_file' || name === 'edit_file') && diff) {
            a.diffLines.push(`✎ ${parsed.path || ''}\n---\n${diff}`)
          } else {
            a.diffLines.push(`› ${name}: ${summarizeToolArgs(name, args)}`)
          }
          clearCoercedToolPayload(agentMsg)
          appendAssistantTrace(agentMsg, `tool call: ${name} ${summarizeToolArgs(name, args)}`)
          storeEmitter.emit('activity-updated')
          storeEmitter.emit('update')
          break
        }
        case 'tool_result': {
          const summary = summarizeToolResult(msg.result)
          a.diffLines.push(`‹ ${msg.name}: ${summary}`)
          appendAssistantTrace(agentMsg, `tool result: ${msg.name} ${summary}`)
          storeEmitter.emit('activity-updated')
          storeEmitter.emit('update')
          break
        }
        case 'done':
          log('sendMessage done')
          a.streamFrame = ''
          a.isBusy = false
          storeEmitter.emit('stream-end')
          agentMsg.thinkingExpanded = false
          saveConversation(a.id, a.messages)
          storeEmitter.emit('update')
          return
        case 'error':
          log('sendMessage agent error:', msg.error)
          a.streamFrame = ''
          a.isBusy = false
          storeEmitter.emit('stream-end')
          a.messages.push({ role: 'system', content: msg.error as string, error: true })
          saveConversation(a.id, a.messages)
          storeEmitter.emit('update')
          return
      }
    }
    a.streamFrame = ''
    a.isBusy = false
    storeEmitter.emit('stream-end')
    a.messages.push({ role: 'system', content: 'connection to agent lost', error: true })
    saveConversation(a.id, a.messages)
    storeEmitter.emit('update')
  } catch (err) {
    log('sendMessage exception:', err)
    a.streamFrame = ''
    a.isBusy = false
    storeEmitter.emit('stream-end')
    a.messages.push({ role: 'system', content: String(err), error: true })
    saveConversation(a.id, a.messages)
    storeEmitter.emit('update')
  } finally {
    if (a.animTimer) { clearInterval(a.animTimer); a.animTimer = null }
    a.streamFrame = ''
    anim.free()
    if (a.timeout) { clearTimeout(a.timeout); a.timeout = null }
    a.isBusy = false
    storeEmitter.emit('update')
    storeEmitter.emit('focus-input')
  }
}

export function resetActiveAgentToBoilerplate(): string | null {
  const a = activeAgent()
  if (!a) return null
  const agentPath = join(APP_ROOT, 'src', 'agent.ts')
  try { writeFileSync(agentPath, BOILERPLATE_AGENT_SOURCE, 'utf-8') } catch (err) { log('resetActiveAgentToBoilerplate write failed', err); return null }
  if (a.animTimer) { clearInterval(a.animTimer); a.animTimer = null }
  if (a.timeout) { clearTimeout(a.timeout); a.timeout = null }
  if (a.anim) { a.anim.free(); a.anim = null }
  if (a.conn) { try { a.conn.kill() } catch (e) { log('reset conn err', e) }; a.conn = null }
  if (a.meta.pid) { try { process.kill(a.meta.pid, 'SIGKILL') } catch (e) { log('reset pid err', e) }; a.meta.pid = null; saveMeta(a.id, a.meta) }
  try { unlinkSync(socketPath(a.id)) } catch { }
  a.isRunning = false
  a.isBusy = false
  a.streamFrame = ''
  storeEmitter.emit('health-checked')
  storeEmitter.emit('update')
  log('resetActiveAgentToBoilerplate', a.id)
  return a.id
}
