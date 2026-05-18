import { existsSync, unlinkSync } from 'node:fs'
import { connect } from 'luna-gateway'
import type { Connection } from 'luna-gateway'
import { log } from './config'
import { agents, activeAgent, saveMeta, saveConversation, socketPath, storeEmitter } from './store'
import type { AgentData } from './types'

// A braille breathing animation spinner for loading state
export class BrailleBreathe {
  private frame = 0
  private readonly levels = [0x00, 0x40, 0x44, 0x46, 0x4e, 0x5e, 0x7e, 0x7f, 0xff]
  step(): string {
    const t = this.frame++ / 20
    let line = ''
    for (let i = 0; i < 9; i++) {
      const d = Math.abs(i - 4) / 4
      const breathe = (Math.sin(t * Math.PI * 2) + 1) / 2
      const intensity = breathe * (1 - d * 0.5)
      const idx = Math.min(Math.floor(intensity * (this.levels.length - 1)), this.levels.length - 1)
      line += String.fromCharCode(0x2800 + this.levels[idx])
    }
    return line
  }
  free() { }
}

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
  const entrypoint = 'src/agent.ts'
  const sockPath = socketPath(id)
  
  const meta = agents.get(id)?.meta ?? { name: 'agent', pid: null, createdAt: new Date().toISOString() }
  try { unlinkSync(sockPath) } catch { }

  const conn = connect({
    agentId: id,
    entrypoint,
    transport: 'socket',
    socketPath: sockPath,
  })
  log('connect() returned, child.pid:', conn.child?.pid)

  if (conn.child?.pid) {
    meta.pid = conn.child.pid
    saveMeta(id, meta)
    log('saved pid', meta.pid)
  }

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
  if (a.conn) {
    try { a.conn.kill() } catch { }
    a.conn = null
  }
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
  const MODEL = process.env.LUNA_MODEL ?? 'gpt-oss:20b-cloud'
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
      if (name) {
        a.meta.name = name
        saveMeta(a.id, a.meta)
        storeEmitter.emit('name-updated')
      }
    })
  }

  const agentMsg = { role: 'assistant' as const, content: '', reasoning: '', thinkingExpanded: true }
  a.messages.push(agentMsg)
  storeEmitter.emit('update')

  a.conn.send(contextPrompt)
  log('sendMessage sent with context')

  const anim = new BrailleBreathe()
  a.anim = anim
  a.animTimer = setInterval(() => {
    if (agentMsg) {
      agentMsg.content = anim.step()
      storeEmitter.emit('update')
    }
  }, 80)

  a.timeout = setTimeout(() => {
    log('sendMessage timeout')
    if (a.animTimer) { clearInterval(a.animTimer); a.animTimer = null }
    anim.free()
    storeEmitter.emit('stream-end')
    a.messages.push({ role: 'system', content: 'timed out waiting for agent', error: true })
    saveConversation(a.id, a.messages)
    a.isBusy = false
    storeEmitter.emit('update')
    storeEmitter.emit('focus-input')
  }, 120_000)

  const iter = a.conn.receive()
  try {
    while (true) {
      const result = await iter.next()
      if (result.done) {
        log('sendMessage receive loop done (connection closed)')
        break
      }
      const msg = result.value
      switch (msg.type) {
        case 'token': {
          if (a.animTimer) {
            clearInterval(a.animTimer); a.animTimer = null
            anim.free()
            agentMsg.content = ''
          }
          storeEmitter.emit('stream-start')
          agentMsg.content += msg.content as string
          storeEmitter.emit('update')
          break
        }
        case 'reasoning': {
          if (a.animTimer) {
            clearInterval(a.animTimer); a.animTimer = null
            anim.free()
            agentMsg.content = ''
          }
          storeEmitter.emit('stream-start')
          agentMsg.reasoning += msg.content as string
          storeEmitter.emit('update')
          break
        }
        case 'tool_call': {
          const name = msg.name as string
          const diff = msg.diff as string | undefined
          const args = msg.args as string
          let parsed: any = {}
          try { parsed = JSON.parse(args) } catch { }

          if ((name === 'write_file' || name === 'edit_file') && diff) {
            const path = parsed.path || ''
            a.diffLines.push(`✎ ${path}\n---\n${diff}`)
            storeEmitter.emit('activity-updated')
          }
          break
        }
        case 'done':
          log('sendMessage done')
          if (a.animTimer) { clearInterval(a.animTimer); a.animTimer = null }
          anim.free()
          storeEmitter.emit('stream-end')
          agentMsg.thinkingExpanded = false
          saveConversation(a.id, a.messages)
          storeEmitter.emit('update')
          return
        case 'error':
          log('sendMessage agent error:', msg.error)
          if (a.animTimer) { clearInterval(a.animTimer); a.animTimer = null }
          anim.free()
          storeEmitter.emit('stream-end')
          a.messages.push({ role: 'system', content: msg.error as string, error: true })
          saveConversation(a.id, a.messages)
          storeEmitter.emit('update')
          return
      }
    }
    // receive loop ended without done/error — show error
    storeEmitter.emit('stream-end')
    a.messages.push({ role: 'system', content: 'connection to agent lost', error: true })
    saveConversation(a.id, a.messages)
    storeEmitter.emit('update')
  } catch (err) {
    log('sendMessage exception:', err)
    storeEmitter.emit('stream-end')
    a.messages.push({ role: 'system', content: String(err), error: true })
    saveConversation(a.id, a.messages)
    storeEmitter.emit('update')
  } finally {
    if (a.animTimer) { clearInterval(a.animTimer); a.animTimer = null }
    anim.free()
    if (a.timeout) { clearTimeout(a.timeout); a.timeout = null }
    a.isBusy = false
    storeEmitter.emit('update')
    storeEmitter.emit('focus-input')
  }
}
