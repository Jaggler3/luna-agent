import { createCliRenderer, Box, ScrollBox, TextRenderable, InputRenderable, InputRenderableEvents, StyledText, t, fg, bg, MarkdownRenderable, SyntaxStyle } from "@opentui/core"
import type { TextChunk } from "@opentui/core"
import { connect, connectSocket } from 'luna-gateway'
import type { Connection } from 'luna-gateway'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync, statSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'

class BrailleBreathe {
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
  free() {}
}

const cwdIndex = process.argv.indexOf('--cwd')
if (cwdIndex !== -1 && process.argv[cwdIndex + 1]) {
  process.env.LUNA_CWD = process.argv[cwdIndex + 1]
}

const theme = {
  bg: "#1a1b26",
  fg: "#a9b1d6",
  border: "#414868",
  blue: "#7aa2f7",
  purple: "#bb9af7",
  cyan: "#7dcfff",
  green: "#9ece6a",
  red: "#f7768e",
  yellow: "#e0af68",
  comment: "#565f89",
  bgHighlight: "#292e42",
}

const syntaxStyle = SyntaxStyle.fromStyles({
  'markup.heading.1': { fg: theme.blue, bold: true },
  'markup.heading.2': { fg: theme.blue, bold: true },
  'markup.heading.3': { fg: theme.blue, bold: true },
  'markup.bold': { bold: true },
  'markup.italic': { italic: true },
  'markup.strikethrough': { fg: theme.comment },
  'markup.inline.code': { fg: theme.cyan },
  'markup.code': { fg: theme.cyan },
  'markup.link': { fg: theme.blue, underline: true },
  'markup.quote': { fg: theme.comment },
  'markup.list': { fg: theme.blue },
  'markup.horizontal_rule': { fg: theme.comment },
})

const renderer = await createCliRenderer({ exitOnCtrlC: true })

const AGENTS_DIR = join(homedir(), '.luna-code', 'agents')
mkdirSync(AGENTS_DIR, { recursive: true })

interface RawMessage {
  role: 'user' | 'assistant'
  content: string
}

interface AgentMeta {
  name: string
  pid: number | null
  createdAt: string
}

interface AgentData {
  id: string
  meta: AgentMeta
  messages: RawMessage[]
  activity: string[]
  conn: Connection | null
  isRunning: boolean
  isBusy: boolean
  conversationLines: string[]
  activityLines: string[]
  currentAgentContent: string
  agentLineIndex: number
  namingPromise: Promise<void> | null
  animTimer: ReturnType<typeof setInterval> | null
  anim: BrailleBreathe | null
  timeout: ReturnType<typeof setTimeout> | null
}

function metaPath(id: string): string { return join(AGENTS_DIR, id, 'meta.json') }
function conversationPath(id: string): string { return join(AGENTS_DIR, id, 'conversation.jsonl') }
function socketPath(id: string): string { return join(AGENTS_DIR, id, 'socket.sock') }

function loadMeta(id: string): AgentMeta | null {
  try {
    return JSON.parse(readFileSync(metaPath(id), 'utf-8')) as AgentMeta
  } catch { return null }
}

function saveMeta(id: string, meta: AgentMeta) {
  writeFileSync(metaPath(id), JSON.stringify(meta))
}

function loadConversation(id: string): { messages: RawMessage[]; activity: string[] } | null {
  try {
    const data = JSON.parse(readFileSync(conversationPath(id), 'utf-8'))
    return { messages: data.messages ?? [], activity: data.activity ?? [] }
  } catch { return null }
}

function saveConversation(id: string, messages: RawMessage[], activity: string[]) {
  const meta = loadMeta(id)
  writeFileSync(conversationPath(id), JSON.stringify({ name: meta?.name ?? 'agent', messages, activity }))
}

function isPidRunning(pid: number): boolean {
  try { return process.kill(pid, 0) }
  catch { return false }
}

function scanAgents(): string[] {
  if (!existsSync(AGENTS_DIR)) return []
  try {
    return readdirSync(AGENTS_DIR).filter((name) => {
      try { return statSync(join(AGENTS_DIR, name)).isDirectory() }
      catch { return false }
    }).sort()
  } catch { return [] }
}

const agents = new Map<string, AgentData>()
let activeId: string | null = null

// ── UI components ─────────────────────────────────────────
const markdownConversation = new MarkdownRenderable(renderer, {
  id: 'conversation-content',
  syntaxStyle,
  fg: theme.fg,
  content: '',
})

const activityText = new TextRenderable(renderer, {
  id: 'activity-content',
  content: t`${fg(theme.comment)("Agent actions will appear here.")}`,
})

const tabText = new TextRenderable(renderer, {
  id: 'agent-tabs',
  content: '',
})

const activityArea = Box({ flexGrow: 1, gap: 1 })
const tabArea = Box({ flexDirection: 'column', gap: 1, width: 20 })
activityArea.add(activityText)
tabArea.add(tabText)

const input = new InputRenderable(renderer, {
  id: 'main-input',
  placeholder: "Ask the agent to do something...",
  backgroundColor: theme.bgHighlight,
  focusedBackgroundColor: theme.bgHighlight,
  textColor: theme.fg,
  cursorColor: theme.blue,
})

// Boxes (created early, added to layout later)
const conversationBox = Box(
  {
    flexDirection: "column",
    flexGrow: 1,
    borderStyle: "rounded",
    borderColor: theme.border,
    title: "Conversation",
    titleColor: theme.blue,
    padding: 1,
    gap: 1,
  },
  ScrollBox(
    {
      flexGrow: 1,
      stickyScroll: true,
      stickyStart: "bottom",
      scrollY: true,
    },
    markdownConversation,
  ),
  input,
) as unknown as { title: string }

const activityBox = Box(
  {
    width: 28,
    borderStyle: "rounded",
    borderColor: theme.border,
    backgroundColor: theme.bg,
    title: "Activity",
    titleColor: theme.purple,
    padding: 1,
    gap: 1,
  },
  activityArea,
)

const tabsBox = Box(
  {
    width: 20,
    flexDirection: "column",
    gap: 1,
    paddingTop: 2,
    paddingLeft: 1,
  },
  tabArea,
)

// ── Agent manager ─────────────────────────────────────────
function activeAgent(): AgentData | null {
  return activeId ? agents.get(activeId) ?? null : null
}

function updateBoxTitle() {
  const a = activeAgent()
  if (!a) {
    conversationBox.title = 'Conversation'
    return
  }
  const dot = a.isRunning ? ' ●' : ' ○'
  const pid = a.meta.pid && a.isRunning ? ` (PID ${a.meta.pid})` : ''
  conversationBox.title = `${a.meta.name}${pid}`
}

function updateConversation() {
  const a = activeAgent()
  if (!a) {
    markdownConversation.content = ''
    return
  }
  if (a.conversationLines.length === 0) {
    markdownConversation.content = ''
    return
  }
  const parts: string[] = []
  for (let i = 0; i < a.conversationLines.length; i++) {
    if (parts.length > 0) parts.push('\n\n')
    const line = a.conversationLines[i]
    if (line.startsWith('you: ')) {
      const content = line.slice(5)
      parts.push(`> **You:** ${content.replace(/\n/g, '\n> ')}`)
    } else if (line.startsWith('agent: ')) {
      const text = line.slice(7)
      if (!text) continue
      parts.push(text)
    } else {
      parts.push(line)
    }
  }
  markdownConversation.content = parts.join('')
}

function updateActivity() {
  const a = activeAgent()
  activityText.content = a ? a.activityLines.join('\n') : ''
}

function updateTabs() {
  const chunks: TextChunk[] = []
  const ids = scanAgents()
  for (const id of ids) {
    const a = agents.get(id)
    if (!a) continue
    if (chunks.length > 0) chunks.push({ __isChunk: true, text: '\n' })
    const isActive = id === activeId
    const dot = a.isRunning ? fg(theme.green)('●') : fg(theme.comment)('○')
    if (isActive) {
      chunks.push(bg(theme.bgHighlight)(` ${dot} ${fg(theme.blue)(a.meta.name.padEnd(11).slice(0, 11))} `))
    } else {
      chunks.push(fg(theme.comment)(` ${dot} ${a.meta.name.padEnd(11).slice(0, 11)} `))
    }
  }
  if (chunks.length > 0) {
    chunks.push({ __isChunk: true, text: '\n' })
    chunks.push(fg(theme.comment)(`${'─'.repeat(17)}`))
  }
  chunks.push({ __isChunk: true, text: '\n' })
  chunks.push(fg(theme.green)('  + new agent'))
  tabText.content = new StyledText(chunks)
}

function handleSlashCommand(value: string): boolean {
  if (value === '/debug') {
    const a = activeAgent()
    const lines = [
      '=== Conversation ===',
      ...(a?.conversationLines ?? []),
      '',
      '=== Activity ===',
      ...(a?.activityLines ?? []),
    ]
    execSync('pbcopy', { input: lines.join('\n') })
    const prev = input.placeholder
    input.placeholder = "Copied!"
    setTimeout(() => { input.placeholder = prev }, 1500)
    return true
  }
  return false
}

// ── Health check ──────────────────────────────────────────
function checkHealth() {
  for (const [, a] of agents) {
    if (a.meta.pid) {
      const wasRunning = a.isRunning
      a.isRunning = isPidRunning(a.meta.pid)
      if (wasRunning && !a.isRunning) {
        if (a.animTimer) { clearInterval(a.animTimer); a.animTimer = null }
        if (a.anim) a.anim.free()
        if (a.timeout) { clearTimeout(a.timeout); a.timeout = null }
        if (a.conn) {
          try { a.conn.kill() } catch {}
        }
      }
    } else {
      a.isRunning = false
    }
  }
  updateBoxTitle()
  updateTabs()
}

// ── Agent lifecycle ───────────────────────────────────────
async function startAgent(id: string): Promise<Connection | null> {
  const entrypoint = 'src/agent.ts'
  const sockPath = socketPath(id)
  const agentDir = join(AGENTS_DIR, id)
  mkdirSync(agentDir, { recursive: true })

  const meta = loadMeta(id) ?? { name: 'agent', pid: null, createdAt: new Date().toISOString() }

  try { unlinkSync(sockPath) } catch {}

  const conn = connect({
    agentId: id,
    entrypoint,
    transport: 'socket',
    socketPath: sockPath,
  })

  await new Promise<void>((resolve, reject) => {
    const maxWait = 15000
    const start = Date.now()
    function poll() {
      if (conn.child?.pid) {
        meta.pid = conn.child.pid!
        saveMeta(id, meta)
        resolve()
        return
      }
      if (Date.now() - start > maxWait) {
        reject(new Error('Agent process did not start'))
        return
      }
      setTimeout(poll, 200)
    }
    if (conn.child) {
      conn.child.on('spawn', () => {
        meta.pid = conn.child!.pid!
        saveMeta(id, meta)
      })
    }
    poll()
  })

  const sock = await connectSocket(sockPath).catch(() => null)
  if (!sock) {
    conn.child?.kill()
    return null
  }

  return sock
}

async function ensureRunning(a: AgentData): Promise<void> {
  if (a.conn && a.isRunning) return
  if (a.conn) {
    try { a.conn.kill() } catch {}
    a.conn = null
  }
  a.conn = await startAgent(a.id).catch(() => null)
  a.isRunning = a.conn !== null
  if (!a.conn) {
    a.conversationLines.push('error: failed to start agent')
    updateConversation()
  }
  updateBoxTitle()
  updateTabs()
}

async function deriveConversationName(prompt: string): Promise<string | null> {
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

async function sendMessage(text: string) {
  const a = activeAgent()
  if (!a || a.isBusy) return
  a.isBusy = true

  await ensureRunning(a)
  if (!a.conn) {
    a.conversationLines.push('error: agent not available')
    updateConversation()
    a.isBusy = false
    input.focus()
    return
  }

  a.conversationLines.push(`you: ${text}`)
  updateConversation()
  a.messages.push({ role: 'user', content: text })
  saveConversation(a.id, a.messages, a.activity)

  a.currentAgentContent = ''
  a.agentLineIndex = a.conversationLines.length
  a.conversationLines.push('agent: ')
  updateConversation()

  a.conn.send(text)

  const anim = new BrailleBreathe()
  a.anim = anim
  a.animTimer = setInterval(() => {
    a.conversationLines[a.agentLineIndex] = `agent: ${anim.step()}`
    updateConversation()
  }, 80)

  a.timeout = setTimeout(() => {
    if (a.animTimer) { clearInterval(a.animTimer); a.animTimer = null }
    anim.free()
    markdownConversation.streaming = false
    a.conversationLines.push('timed out waiting for agent')
    updateConversation()
    a.isBusy = false
    input.focus()
  }, 120_000)

  const iter = a.conn.receive()
  try {
    while (true) {
      const result = await iter.next()
      if (result.done) break
      const msg = result.value
      switch (msg.type) {
        case 'token': {
          if (a.animTimer) {
            clearInterval(a.animTimer); a.animTimer = null
            anim.free()
          }
          if (!markdownConversation.streaming) markdownConversation.streaming = true
          if (a.meta.name === 'agent' && !a.namingPromise) {
            a.namingPromise = deriveConversationName(text).then((name) => {
              if (name) {
                a.meta.name = name
                saveMeta(a.id, a.meta)
                updateBoxTitle()
                updateTabs()
              }
            })
          }
          a.currentAgentContent += msg.content as string
          a.conversationLines[a.agentLineIndex] = `agent: ${a.currentAgentContent}`
          updateConversation()
          break
        }
        case 'reasoning': {
          if (a.activityLines.length === 0 || a.activityLines[a.activityLines.length - 1] !== 'Thinking') {
            a.activityLines.push('Thinking')
          }
          updateActivity()
          break
        }
        case 'tool_call': {
          const name = msg.name as string
          const args = msg.args as string
          let label = name
          try {
            const parsed = JSON.parse(args)
            label = `${name} ${Object.values(parsed).join(' ')}`
          } catch {}
          a.activityLines.push(`→ ${label}`)
          a.activity.push(`→ ${label}`)
          updateActivity()
          break
        }
        case 'done':
          if (a.animTimer) { clearInterval(a.animTimer); a.animTimer = null }
          anim.free()
          markdownConversation.streaming = false
          a.messages.push({ role: 'assistant', content: a.currentAgentContent })
          saveConversation(a.id, a.messages, a.activity)
          return
        case 'error':
          if (a.animTimer) { clearInterval(a.animTimer); a.animTimer = null }
          anim.free()
          markdownConversation.streaming = false
          a.conversationLines.push(`error: ${msg.error as string}`)
          updateConversation()
          return
      }
    }
  } catch (err) {
    markdownConversation.streaming = false
    a.conversationLines.push(`error: ${err}`)
    updateConversation()
  } finally {
    if (a.animTimer) { clearInterval(a.animTimer); a.animTimer = null }
    anim.free()
    if (a.timeout) { clearTimeout(a.timeout); a.timeout = null }
    a.isBusy = false
    input.focus()
  }
}

function switchAgent(id: string) {
  if (id === activeId) return
  activeId = id
  if (markdownConversation.streaming) markdownConversation.streaming = false
  updateConversation()
  updateActivity()
  updateBoxTitle()
  updateTabs()
  input.focus()
}

function createNewAgent() {
  const id = crypto.randomUUID()
  const dir = join(AGENTS_DIR, id)
  mkdirSync(dir, { recursive: true })
  const meta: AgentMeta = { name: 'agent', pid: null, createdAt: new Date().toISOString() }
  saveMeta(id, meta)
  const data: AgentData = {
    id, meta,
    messages: [], activity: [],
    conn: null, isRunning: false, isBusy: false,
    conversationLines: [], activityLines: [],
    currentAgentContent: '', agentLineIndex: -1,
    namingPromise: null, animTimer: null, anim: null, timeout: null,
  }
  agents.set(id, data)
  switchAgent(id)
}

function switchToNextAgent() {
  const ids = scanAgents()
  if (ids.length === 0) return
  const idx = activeId ? ids.indexOf(activeId) : -1
  const next = (idx + 1) % ids.length
  switchAgent(ids[next])
}

function switchToPrevAgent() {
  const ids = scanAgents()
  if (ids.length === 0) return
  const idx = activeId ? ids.indexOf(activeId) : 0
  const prev = (idx - 1 + ids.length) % ids.length
  switchAgent(ids[prev])
}

// ── Init existing agents ──────────────────────────────────
const existing = scanAgents()
for (const id of existing) {
  const meta = loadMeta(id)
  if (!meta) continue
  const conv = loadConversation(id)
  const messages = conv?.messages ?? []
  const activity = conv?.activity ?? []

  let isRunning = false
  let conn: Connection | null = null
  if (meta.pid && isPidRunning(meta.pid)) {
    isRunning = true
    conn = await connectSocket(socketPath(id)).catch(() => {
      isRunning = false
      return null
    })
  }

  const conversationLines: string[] = []
  for (const msg of messages) {
    if (msg.role === 'user') conversationLines.push(`you: ${msg.content}`)
    else conversationLines.push(`agent: ${msg.content}`)
  }

  const data: AgentData = {
    id, meta, messages, activity, conn, isRunning, isBusy: false,
    conversationLines, activityLines: [...activity],
    currentAgentContent: '', agentLineIndex: -1,
    namingPromise: null, animTimer: null, anim: null, timeout: null,
  }
  agents.set(id, data)
}

if (existing.length === 0) {
  createNewAgent()
} else {
  switchAgent(existing[0])
}

// ── Input / keyboard ──────────────────────────────────────
input.on(InputRenderableEvents.ENTER, (value: string) => {
  if (value.trim() && !activeAgent()?.isBusy) {
    input.value = ''
    if (handleSlashCommand(value.trim())) return
    sendMessage(value)
  }
})

renderer.keyInput.on("keypress", (event) => {
  if (event.ctrl && event.shift && event.name === "c") {
    event.preventDefault()
    const sel = renderer.getSelection()
    if (sel) {
      const text = sel.getSelectedText()
      if (text) {
        renderer.copyToClipboardOSC52(text)
        const prev = input.placeholder
        input.placeholder = "Copied!"
        setTimeout(() => { input.placeholder = prev }, 1500)
      }
    }
    return
  }
  if (event.name === "tab") {
    event.preventDefault()
    if (event.shift) switchToPrevAgent()
    else switchToNextAgent()
    return
  }
})

input.focus()

// ── Layout ────────────────────────────────────────────────
renderer.root.add(
  Box(
    {
      flexDirection: "row",
      width: "100%",
      height: "100%",
      backgroundColor: theme.bg,
    },
    conversationBox,
    activityBox,
    tabsBox,
  ),
)

// ── Health polling ────────────────────────────────────────
const healthTimer = setInterval(checkHealth, 3000)
process.on('exit', () => clearInterval(healthTimer))
updateBoxTitle()
updateTabs()