import { createCliRenderer, Box, ScrollBox, TextRenderable, TextareaRenderable, StyledText, t, fg, bg, MarkdownRenderable, SyntaxStyle } from "@opentui/core"
import type { TextChunk, Renderable } from "@opentui/core"
import { connect } from 'luna-gateway'
import type { Connection } from 'luna-gateway'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync, statSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync, rmSync } from 'node:fs'

const LOG_FILE = join(homedir(), '.luna-code', 'harness.log')
function log(...args: unknown[]) {
  try {
    const line = `[${new Date().toISOString()}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`
    appendFileSync(LOG_FILE, line + '\n')
  } catch {}
}

log('APP START')

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
  'markup.quote': { fg: theme.comment, bg: theme.bgHighlight },
  'markup.list': { fg: theme.blue },
  'markup.horizontal_rule': { fg: theme.comment },
})

const renderer = await createCliRenderer({ exitOnCtrlC: true })
log('RENDERER CREATED')

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
let tabAreaInstance: Renderable | null = null
let conversationBoxInstance: Renderable | null = null

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

const activityArea = Box({ flexGrow: 1, gap: 1 })
const tabArea = Box({ id: 'tab-area', flexDirection: 'column', gap: 1, width: 20 })
activityArea.add(activityText)

function handleSubmit() {
  const value = input.plainText
  log('SUBMIT pressed, value length:', value.length)
  if (value.trim() && !activeAgent()?.isBusy) {
    input.setText('')
    if (handleSlashCommand(value.trim())) return
    sendMessage(value)
  } else {
    log('SUBMIT ignored', { trimmed: !!value.trim(), busy: activeAgent()?.isBusy })
  }
}

const input = new TextareaRenderable(renderer, {
  id: 'main-input',
  placeholder: "Ask the agent to do something...",
  backgroundColor: theme.bgHighlight,
  focusedBackgroundColor: theme.bgHighlight,
  textColor: theme.fg,
  cursorColor: theme.blue,
  wrapMode: "word",
  maxHeight: 5,
  keyBindings: [
    { name: "return", action: "submit" },
    { name: "linefeed", action: "submit" },
    { name: "return", shift: true, action: "newline" },
  ],
  onSubmit: handleSubmit,
})

// Boxes (created early, added to layout later)
const conversationBox = Box(
  {
    id: 'conversation-box',
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
  try {
    const target = (conversationBoxInstance ?? conversationBox) as unknown as { title: string }
    const a = activeAgent()
    if (!a) { target.title = 'Conversation'; return }
    const dot = a.isRunning ? ' ●' : ' ○'
    const pid = a.meta.pid && a.isRunning ? ` (PID ${a.meta.pid})` : ''
    const cwd = process.env.LUNA_CWD ?? process.cwd()
    target.title = `${a.meta.name}${pid}${dot}  ${cwd}`
  } catch (e) { log('updateBoxTitle error', e) }
}

function updateConversation() {
  try {
    const a = activeAgent()
    if (!a) { markdownConversation.content = ''; return }
    if (a.conversationLines.length === 0) { markdownConversation.content = ''; return }
    const parts: string[] = []
    for (let i = 0; i < a.conversationLines.length; i++) {
      if (parts.length > 0) parts.push('\n\n')
      const line = a.conversationLines[i]
      if (line.startsWith('you: ')) {
        parts.push(`> ${line.slice(5).replace(/\n/g, '\n> ')}`)
      } else if (line.startsWith('agent: ')) {
        const text = line.slice(7)
        if (!text) continue
        parts.push(text)
      } else {
        parts.push(line)
      }
    }
    markdownConversation.content = parts.join('')
  } catch (e) { log('updateConversation error', e) }
}

function updateActivity() {
  try {
    const a = activeAgent()
    activityText.content = a ? a.activityLines.join('\n') : ''
  } catch (e) { log('updateActivity error', e) }
}

function updateTabs() {
  try {
    const ta = (tabAreaInstance ?? tabArea) as unknown as { add(child: unknown): void; remove(id: string): unknown; getChildren(): { id: string }[] }
    // remove existing entries (only post-mount — proxy queues calls instead of executing)
    if (tabAreaInstance) {
      for (const child of ta.getChildren()) ta.remove(child.id)
    }
    const ids = scanAgents()
    for (const id of ids) {
      const a = agents.get(id)
      if (!a) continue
      const isActive = id === activeId
      const dotChar = a.isRunning ? '●' : '○'
      const label = ` ${dotChar} ${a.meta.name.padEnd(11).slice(0, 11)} `
      const chunks: TextChunk[] = isActive
        ? [bg(theme.bgHighlight)(fg(theme.blue)(label))]
        : [fg(theme.comment)(label)]
      const entry = new TextRenderable(renderer, { id: `tab-${id}`, content: new StyledText(chunks), selectable: false })
      entry.onMouseDown = (ev: { button: number }) => { if (ev.button === 0) switchAgent(id) }
      ta.add(entry)
    }
    if (ids.length > 0) {
      ta.add(new TextRenderable(renderer, {
        id: 'tab-sep',
        content: new StyledText([fg(theme.comment)(`${'─'.repeat(17)}`)]),
        selectable: false,
      }))
    }
    const newBtn = new TextRenderable(renderer, { id: 'tab-new', content: new StyledText([fg(theme.green)('  + new agent')]), selectable: false })
    newBtn.onMouseDown = (ev: { button: number }) => { if (ev.button === 0) createNewAgent() }
    ta.add(newBtn)
  } catch (e) { log('updateTabs error', e) }
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
            try { a.conn.kill() } catch {}
          }
        }
      } else {
        a.isRunning = false
      }
    }
    updateBoxTitle()
    updateTabs()
  } catch (e) { log('checkHealth error', e) }
}

// ── Agent lifecycle ───────────────────────────────────────
function waitForSocketFile(sockPath: string, timeout: number): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    function poll() {
      try {
        if (existsSync(sockPath)) { resolve(); return }
      } catch {}
      if (Date.now() - start > timeout) {
        reject(new Error('Agent socket did not appear'))
      } else {
        setTimeout(poll, 200)
      }
    }
    poll()
  })
}

async function startAgent(id: string): Promise<Connection | null> {
  log('startAgent begin', id)
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

async function ensureRunning(a: AgentData): Promise<void> {
  log('ensureRunning begin', a.id, 'conn:', !!a.conn, 'running:', a.isRunning)
  if (a.conn && a.isRunning) { log('ensureRunning already running'); return }
  if (a.conn) {
    try { a.conn.kill() } catch {}
    a.conn = null
  }
  a.conn = await startAgent(a.id).catch((e) => { log('startAgent failed', e); return null })
  a.isRunning = a.conn !== null
  log('ensureRunning done, running:', a.isRunning)
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
  log('sendMessage', text.slice(0, 50), 'agent:', a?.id, 'busy:', a?.isBusy)
  if (!a || a.isBusy) { log('sendMessage skipped'); return }
  a.isBusy = true

  await ensureRunning(a)
  if (!a.conn) {
    a.conversationLines.push('error: agent not available')
    updateConversation()
    a.isBusy = false
    input.focus()
    return
  }
  log('sendMessage connection ready')

  a.conversationLines.push(`you: ${text}`)
  updateConversation()
  a.messages.push({ role: 'user', content: text })
  saveConversation(a.id, a.messages, a.activity)

  // Include conversation history so the agent knows what "it" refers to
  const historyMessages = a.messages.slice(-10)
  const contextPrompt = historyMessages.map(m =>
    m.role === 'user' ? `user: ${m.content}` : `assistant: ${m.content}`
  ).join('\n\n')

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

  a.currentAgentContent = ''
  a.agentLineIndex = a.conversationLines.length
  a.conversationLines.push('agent: ')
  updateConversation()

  a.conn.send(contextPrompt)
  log('sendMessage sent with context')

  const anim = new BrailleBreathe()
  a.anim = anim
  a.animTimer = setInterval(() => {
    a.conversationLines[a.agentLineIndex] = `agent: ${anim.step()}`
    updateConversation()
  }, 80)

  a.timeout = setTimeout(() => {
    log('sendMessage timeout')
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
          }
          if (!markdownConversation.streaming) markdownConversation.streaming = true
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
          log('sendMessage done')
          if (a.animTimer) { clearInterval(a.animTimer); a.animTimer = null }
          anim.free()
          markdownConversation.streaming = false
          a.messages.push({ role: 'assistant', content: a.currentAgentContent })
          saveConversation(a.id, a.messages, a.activity)
          return
        case 'error':
          log('sendMessage agent error:', msg.error)
          if (a.animTimer) { clearInterval(a.animTimer); a.animTimer = null }
          anim.free()
          markdownConversation.streaming = false
          a.conversationLines.push(`error: ${msg.error as string}`)
          updateConversation()
          return
      }
    }
    // receive loop ended without done/error — show error
    markdownConversation.streaming = false
    a.conversationLines.push('error: connection to agent lost')
    updateConversation()
  } catch (err) {
    log('sendMessage exception:', err)
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
  log('switchAgent', id)
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
  log('createNewAgent', id)
  switchAgent(id)
}

function closeCurrentAgent() {
  const a = activeAgent()
  if (!a) { log('closeCurrentAgent: no active agent'); return }
  log('closeCurrentAgent', a.id)
  if (a.animTimer) { clearInterval(a.animTimer); a.animTimer = null }
  if (a.timeout) { clearTimeout(a.timeout); a.timeout = null }
  if (a.anim) { a.anim.free(); a.anim = null }
  if (a.conn) { try { a.conn.kill() } catch (e) { log('close conn err', e) }; a.conn = null }
  if (a.meta.pid) { try { process.kill(a.meta.pid) } catch (e) { log('close pid err', e) } }
  const sockPath = socketPath(a.id)
  try { unlinkSync(sockPath) } catch {}
  agents.delete(a.id)
  const dir = join(AGENTS_DIR, a.id)
  try { rmSync(dir, { recursive: true, force: true }) } catch (e) { log('close rm err', e) }
  const remaining = scanAgents()
  const firstLoaded = remaining.find(id => agents.has(id))
  if (firstLoaded) switchAgent(firstLoaded)
  else createNewAgent()
}

function switchToNextAgent() {
  const ids = scanAgents()
  if (ids.length === 0) return
  const idx = activeId ? ids.indexOf(activeId) : -1
  switchAgent(ids[(idx + 1) % ids.length])
}

function switchToPrevAgent() {
  const ids = scanAgents()
  if (ids.length === 0) return
  const idx = activeId ? ids.indexOf(activeId) : 0
  switchAgent(ids[(idx - 1 + ids.length) % ids.length])
}

// ── Init existing agents ──────────────────────────────────
const existing = scanAgents()
log('existing agents:', existing.length)
for (const id of existing) {
  const meta = loadMeta(id)
  if (!meta) continue
  const conv = loadConversation(id)
  const messages = conv?.messages ?? []
  const activity = conv?.activity ?? []

  let isRunning = false
  let conn: Connection | null = null
  // Kill old agent processes on restart so they pick up latest luna-code changes
  if (meta.pid && isPidRunning(meta.pid)) {
    log('killing stale agent', id, 'pid:', meta.pid)
    try { process.kill(meta.pid) } catch {}
    try { unlinkSync(socketPath(id)) } catch {}
    meta.pid = null
    saveMeta(id, meta)
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
  // Pick the first agent that was actually loaded into the map
  const firstLoaded = existing.find((id) => agents.has(id))
  if (firstLoaded) {
    switchAgent(firstLoaded)
  } else {
    createNewAgent()
  }
}

// ── Input / keyboard ──────────────────────────────────────
renderer.keyInput.on("keypress", (event) => {
  if (event.ctrl && event.shift && event.name === "c") {
    event.preventDefault()
    const sel = renderer.getSelection()
    if (sel) {
      const text = sel.getSelectedText()
      if (text) renderer.copyToClipboardOSC52(text)
    }
    return
  }
  if (event.name === "tab") {
    event.preventDefault()
    if (event.shift) switchToPrevAgent()
    else switchToNextAgent()
    return
  }
  if (event.ctrl && event.name === "n") {
    event.preventDefault()
    createNewAgent()
    return
  }
  if (event.ctrl && event.name === "w") {
    event.preventDefault()
    closeCurrentAgent()
    return
  }
  if (
    renderer.currentFocusedRenderable !== input
    && event.name
    && event.name.length === 1
    && !event.ctrl
    && !event.meta
  ) {
    input.focus()
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

// Get the real BoxRenderable instance for tabArea (the VNode proxy queues
// calls instead of executing them, so we need the real instance at runtime)
const foundTabArea = renderer.root.findDescendantById('tab-area')
if (foundTabArea) tabAreaInstance = foundTabArea
const foundConvBox = renderer.root.findDescendantById('conversation-box')
if (foundConvBox) conversationBoxInstance = foundConvBox

// ── Health polling ────────────────────────────────────────
const healthTimer = setInterval(checkHealth, 3000)
function cancelHealth() { clearInterval(healthTimer) }
process.on('SIGINT', () => { log('SIGINT'); cancelHealth() })
process.on('SIGTERM', () => { log('SIGTERM'); cancelHealth() })
// opentui's exitOnCtrlC destroys text buffers before the 'exit' event,
// so also guard the health check above with try-catch.
updateBoxTitle()
updateTabs()
log('APP READY')