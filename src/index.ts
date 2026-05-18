#!/usr/bin/env bun

import { unlinkSync } from 'node:fs'
import { log } from './config'
import { agents, createNewAgent, switchAgent, scanAgents, loadMeta, loadConversation, socketPath, saveMeta } from './store'
import { isPidRunning, checkHealth } from './daemon'
import { bootUI } from './ui'
import type { AgentData } from './types'

log('APP START')

const cwdIndex = process.argv.indexOf('--cwd')
if (cwdIndex !== -1 && process.argv[cwdIndex + 1]) {
  process.env.LUNA_CWD = process.argv[cwdIndex + 1]
}

// ── Init existing agents ──────────────────────────────────
const existing = scanAgents()
log('existing agents:', existing.length)
for (const id of existing) {
  const meta = loadMeta(id)
  if (!meta) continue
  const conv = loadConversation(id)
  const messages = conv?.messages ?? []

  let isRunning = false
  let conn = null
  // Kill old agent processes on restart so they pick up latest luna-code changes
  if (meta.pid && isPidRunning(meta.pid)) {
    log('killing stale agent', id, 'pid:', meta.pid)
    try { process.kill(meta.pid) } catch { }
    try { unlinkSync(socketPath(id)) } catch { }
    meta.pid = null
    saveMeta(id, meta)
  }

  const data: AgentData = {
    id, meta, messages, conn, isRunning, isBusy: false,
    streamFrame: '',
    diffLines: [],
    namingPromise: null, animTimer: null, anim: null, timeout: null,
  }
  agents.set(id, data)
}

if (existing.length === 0) {
  createNewAgent()
} else {
  // Pick the first agent that was actually loaded into the map
  const firstLoaded = existing.find((id) => agents.has(id))
  if (firstLoaded) {
    switchAgent(firstLoaded)
  } else {
    createNewAgent()
  }
}

// ── Health polling / Shutdown ─────────────────────────────
const healthTimer = setInterval(checkHealth, 3000)
function cancelHealth() { clearInterval(healthTimer) }

let isCleaningUp = false
function cleanupAndExit(signal: string) {
  if (isCleaningUp) return
  isCleaningUp = true
  log('CLEANUP AND EXIT triggered by', signal)
  cancelHealth()

  for (const [id, a] of agents) {
    if (a.animTimer) {
      clearInterval(a.animTimer)
      a.animTimer = null
    }
    if (a.timeout) {
      clearTimeout(a.timeout)
      a.timeout = null
    }
    if (a.anim) {
      a.anim.free()
      a.anim = null
    }
    if (a.conn) {
      log('killing agent gateway connection', id)
      try { a.conn.kill() } catch { }
      a.conn = null
    }
    if (a.meta.pid) {
      log('killing agent process', a.meta.pid)
      try { process.kill(a.meta.pid, 'SIGKILL') } catch { }
    }
    const sockPath = socketPath(id)
    try { unlinkSync(sockPath) } catch { }
  }
  process.exit(0)
}

process.on('SIGINT', () => cleanupAndExit('SIGINT'))
process.on('SIGTERM', () => cleanupAndExit('SIGTERM'))
process.on('exit', () => {
  if (!isCleaningUp) {
    isCleaningUp = true
    for (const [id, a] of agents) {
      if (a.conn) {
        try { a.conn.kill() } catch { }
      }
      if (a.meta.pid) {
        try { process.kill(a.meta.pid, 'SIGKILL') } catch { }
      }
      const sockPath = socketPath(id)
      try { unlinkSync(sockPath) } catch { }
    }
  }
})

// Boot layout and mount views
bootUI()

log('APP READY')
