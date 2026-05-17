import { createCliRenderer, Box, ScrollBox, TextRenderable, InputRenderable, InputRenderableEvents, StyledText, t, fg, bg, MarkdownRenderable, SyntaxStyle } from "@opentui/core"
import type { TextChunk } from "@opentui/core"
import { connect } from 'luna-gateway'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync, statSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

const agentId = crypto.randomUUID()
const conn = connect({
  agentId,
  entrypoint: 'src/agent.ts',
})

let isBusy = false
let conversationLines: string[] = []
let activityLines: string[] = []
let currentAgentContent = ''
let agentLineIndex = -1
let agentName = 'New agent'

const AGENTS_DIR = join(homedir(), '.luna-code', 'agents')
const AGENT_DIR = join(AGENTS_DIR, agentId)
const CONVERSATION_FILE = join(AGENT_DIR, 'conversation.jsonl')
mkdirSync(AGENT_DIR, { recursive: true })

interface RawMessage {
  role: 'user' | 'assistant'
  content: string
}
let rawMessages: RawMessage[] = []

function persistState() {
  const data = JSON.stringify({ name: agentName, messages: rawMessages })
  writeFileSync(CONVERSATION_FILE, data)
}

function loadState(): { name: string; messages: RawMessage[] } | null {
  try {
    const raw = readFileSync(CONVERSATION_FILE, 'utf-8')
    return JSON.parse(raw) as { name: string; messages: RawMessage[] }
  } catch {
    return null
  }
}

// Load persisted conversation
const saved = loadState()
if (saved) {
  agentName = saved.name
  rawMessages = saved.messages
  for (const msg of saved.messages) {
    if (msg.role === 'user') {
      conversationLines.push(`you: ${msg.content}`)
    } else {
      conversationLines.push(`agent: ${msg.content}`)
    }
  }
  if (conversationLines.length > 0) updateConversation()
  updateTabs()
}

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

function handleSlashCommand(value: string): boolean {
  if (value === '/debug') {
    const lines = [
      '=== Conversation ===',
      ...conversationLines,
      '',
      '=== Activity ===',
      ...activityLines,
    ]
    execSync('pbcopy', { input: lines.join('\n') })
    const prev = input.placeholder
    input.placeholder = "Copied!"
    setTimeout(() => { input.placeholder = prev }, 1500)
    return true
  }
  return false
}

input.on(InputRenderableEvents.ENTER, (value: string) => {
  if (value.trim() && !isBusy) {
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
  }
})

input.focus()

renderer.root.add(
  Box(
    {
      flexDirection: "row",
      width: "100%",
      height: "100%",
      backgroundColor: theme.bg,
    },
    Box(
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
    ),
    Box(
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
    ),
    Box(
      {
        width: 20,
        flexDirection: "column",
        gap: 1,
        paddingTop: 2,
        paddingLeft: 1,
      },
      tabArea,
    ),
  ),
)

function scanAgentDirs(): string[] {
  if (!existsSync(AGENTS_DIR)) return []
  try {
    return readdirSync(AGENTS_DIR).filter((name) => {
      try {
        return statSync(join(AGENTS_DIR, name)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

function updateTabs() {
  const chunks: TextChunk[] = []
  chunks.push(fg(theme.fg)(` ${agentName.padEnd(15).slice(0, 15)}`))
  chunks.push({ __isChunk: true, text: '\n' })
  chunks.push(fg(theme.comment)(`${'─'.repeat(17)}`))
  chunks.push({ __isChunk: true, text: '\n' })
  chunks.push(fg(theme.green)('  + new agent'))

  tabText.content = new StyledText(chunks)
}

updateTabs()

function updateConversation() {
  if (conversationLines.length === 0) {
    markdownConversation.content = ''
    return
  }
  const parts: string[] = []
  for (let i = 0; i < conversationLines.length; i++) {
    if (parts.length > 0) parts.push('\n\n')
    const line = conversationLines[i]
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
  activityText.content = activityLines.join('\n')
}

let namingPromise: Promise<void> | null = null

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
  } catch {
    return null
  }
}

async function sendMessage(text: string) {
  if (isBusy) return
  isBusy = true

  conversationLines.push(`you: ${text}`)
  updateConversation()
  rawMessages.push({ role: 'user', content: text })
  persistState()

  if (conn.child.exitCode !== null) {
    conversationLines.push(`agent exited (code ${conn.child.exitCode})`)
    updateConversation()
    isBusy = false
    input.focus()
    return
  }

  currentAgentContent = ''
  agentLineIndex = conversationLines.length
  conversationLines.push('agent: ')
  updateConversation()

  conn.send(text)

  const anim = new BrailleBreathe()
  let animTimer = setInterval(() => {
    conversationLines[agentLineIndex] = `agent: ${anim.step()}`
    updateConversation()
  }, 80)

  const timeout = setTimeout(() => {
    clearInterval(animTimer)
    anim.free()
    markdownConversation.streaming = false
    conversationLines.push('timed out waiting for agent')
    updateConversation()
    isBusy = false
    input.focus()
  }, 120_000)

  const iter = conn.receive()
  try {
    while (true) {
      const result = await iter.next()
      if (result.done) break
      const msg = result.value
      switch (msg.type) {
        case 'token': {
          if (animTimer) {
            clearInterval(animTimer)
            animTimer = null
            anim.free()
          }
          if (!markdownConversation.streaming) {
            markdownConversation.streaming = true
          }
          if (agentName === 'New agent' && !namingPromise) {
            namingPromise = deriveConversationName(text).then((name) => {
              if (name) {
                agentName = name
                updateTabs()
              }
            })
          }
          currentAgentContent += msg.content as string
          conversationLines[agentLineIndex] = `agent: ${currentAgentContent}`
          updateConversation()
          break
        }
        case 'reasoning': {
          if (activityLines.length === 0 || activityLines[activityLines.length - 1] !== 'Thinking') {
            activityLines.push('Thinking')
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
          activityLines.push(`→ ${label}`)
          updateActivity()
          break
        }
        case 'done':
          if (animTimer) {
            clearInterval(animTimer)
            anim.free()
          }
          markdownConversation.streaming = false
          rawMessages.push({ role: 'assistant', content: currentAgentContent })
          persistState()
          return
        case 'error':
          if (animTimer) {
            clearInterval(animTimer)
            anim.free()
          }
          markdownConversation.streaming = false
          conversationLines.push(`error: ${msg.error as string}`)
          updateConversation()
          return
      }
    }
  } catch (err) {
    markdownConversation.streaming = false
    conversationLines.push(`error: ${err}`)
    updateConversation()
  } finally {
    if (animTimer) {
      clearInterval(animTimer)
      anim.free()
    }
    clearTimeout(timeout)
    isBusy = false
    input.focus()
  }
}
