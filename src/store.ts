import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, unlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { AGENTS_DIR, log } from './config'
import type { AgentMeta, AgentData } from './types'

export const storeEmitter = new EventEmitter()

export const agents = new Map<string, AgentData>()
export let activeId: string | null = null

export function setActiveId(id: string | null) {
  activeId = id
}

export function activeAgent(): AgentData | null {
  return activeId ? agents.get(activeId) ?? null : null
}

export function metaPath(id: string): string { return join(AGENTS_DIR, id, 'meta.json') }
export function conversationPath(id: string): string { return join(AGENTS_DIR, id, 'conversation.jsonl') }
export function socketPath(id: string): string { return join(AGENTS_DIR, id, 'socket.sock') }

export function loadMeta(id: string): AgentMeta | null {
  try {
    return JSON.parse(readFileSync(metaPath(id), 'utf-8')) as AgentMeta
  } catch { return null }
}

export function saveMeta(id: string, meta: AgentMeta) {
  writeFileSync(metaPath(id), JSON.stringify(meta))
}

export function loadConversation(id: string): { messages: any[] } | null {
  try {
    const data = JSON.parse(readFileSync(conversationPath(id), 'utf-8'))
    return { messages: data.messages ?? [] }
  } catch { return null }
}

export function saveConversation(id: string, messages: any[]) {
  const meta = loadMeta(id)
  writeFileSync(conversationPath(id), JSON.stringify({ name: meta?.name ?? 'agent', messages }))
}

export function scanAgents(): string[] {
  if (!existsSync(AGENTS_DIR)) return []
  try {
    return readdirSync(AGENTS_DIR).filter((name) => {
      try { return statSync(join(AGENTS_DIR, name)).isDirectory() }
      catch { return false }
    }).sort()
  } catch { return [] }
}

export function switchAgent(id: string) {
  if (id === activeId) return
  log('switchAgent', id)
  activeId = id
  storeEmitter.emit('switch', id)
}

export function createNewAgent(): string {
  const id = crypto.randomUUID()
  const dir = join(AGENTS_DIR, id)
  mkdirSync(dir, { recursive: true })
  const meta: AgentMeta = { name: 'agent', pid: null, createdAt: new Date().toISOString() }
  saveMeta(id, meta)
  const data: AgentData = {
    id, meta,
    messages: [],
    conn: null, isRunning: false, isBusy: false,
    diffLines: [],
    namingPromise: null, animTimer: null, anim: null, timeout: null,
  }
  agents.set(id, data)
  log('createNewAgent', id)
  switchAgent(id)
  return id
}

export function closeCurrentAgent() {
  const a = activeAgent()
  if (!a) { log('closeCurrentAgent: no active agent'); return }
  log('closeCurrentAgent', a.id)
  if (a.animTimer) { clearInterval(a.animTimer); a.animTimer = null }
  if (a.timeout) { clearTimeout(a.timeout); a.timeout = null }
  if (a.anim) { a.anim.free(); a.anim = null }
  if (a.conn) { try { a.conn.kill() } catch (e) { log('close conn err', e) }; a.conn = null }
  if (a.meta.pid) { try { process.kill(a.meta.pid) } catch (e) { log('close pid err', e) } }
  const sockPath = socketPath(a.id)
  try { unlinkSync(sockPath) } catch { }
  agents.delete(a.id)
  const dir = join(AGENTS_DIR, a.id)
  try { rmSync(dir, { recursive: true, force: true }) } catch (e) { log('close rm err', e) }
  const remaining = scanAgents()
  const firstLoaded = remaining.find(id => agents.has(id))
  if (firstLoaded) switchAgent(firstLoaded)
  else createNewAgent()
}

export function switchToNextAgent() {
  const ids = scanAgents()
  if (ids.length === 0) return
  const idx = activeId ? ids.indexOf(activeId) : -1
  switchAgent(ids[(idx + 1) % ids.length])
}

export function switchToPrevAgent() {
  const ids = scanAgents()
  if (ids.length === 0) return
  const idx = activeId ? ids.indexOf(activeId) : 0
  switchAgent(ids[(idx - 1 + ids.length) % ids.length])
}
