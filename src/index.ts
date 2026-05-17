import { createCliRenderer, Box, TextRenderable, InputRenderable, InputRenderableEvents, StyledText, t, fg, bg } from "@opentui/core"
import type { TextChunk } from "@opentui/core"
import { connect } from 'luna-gateway'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'

const cwdIndex = process.argv.indexOf('--cwd')
if (cwdIndex !== -1 && process.argv[cwdIndex + 1]) {
  process.env.LUNA_CWD = process.argv[cwdIndex + 1]
}

const AGENTS_DIR = join(homedir(), '.luna-code', 'agents')

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

const conversationText = new TextRenderable(renderer, {
  id: 'conversation-content',
  content: t`${fg(theme.comment)("Your conversation with the agent will appear here.")}`,
})

const activityText = new TextRenderable(renderer, {
  id: 'activity-content',
  content: t`${fg(theme.comment)("Agent actions will appear here.")}`,
})

const tabText = new TextRenderable(renderer, {
  id: 'agent-tabs',
  content: '',
})

const messagesArea = Box({ flexGrow: 1, gap: 1 })
const activityArea = Box({ flexGrow: 1, gap: 1 })
const tabArea = Box({ flexDirection: 'column', gap: 1, width: 6 })

messagesArea.add(conversationText)
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

input.on(InputRenderableEvents.ENTER, (value: string) => {
  if (value.trim() && !isBusy) {
    input.value = ''
    sendMessage(value)
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
      messagesArea,
      input,
    ),
    Box(
      {
        width: 38,
        borderStyle: "rounded",
        borderColor: theme.border,
        backgroundColor: theme.bg,
        title: "Activity Pane",
        titleColor: theme.purple,
        padding: 1,
        gap: 1,
      },
      activityArea,
    ),
    Box(
      {
        width: 6,
        flexDirection: "column",
        gap: 1,
        paddingTop: 2,
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
  const existing = scanAgentDirs()
  const all = [agentId, ...existing.filter((id) => id !== agentId)]

  for (let i = 0; i < all.length; i++) {
    if (i > 0) chunks.push({ __isChunk: true, text: '\n' })
    const abbr = all[i].slice(0, 5)
    const isActive = all[i] === agentId
    if (isActive) {
      chunks.push(bg(theme.bgHighlight)(fg(theme.blue)(` ${abbr} `)))
    } else {
      chunks.push(fg(theme.comment)(` ${abbr} `))
    }
  }

  chunks.push({ __isChunk: true, text: '\n' })
  chunks.push(fg(theme.green)('  +  '))

  tabText.content = new StyledText(chunks)
}

updateTabs()

function updateConversation() {
  const chunks: TextChunk[] = []
  for (let i = 0; i < conversationLines.length; i++) {
    if (i > 0) chunks.push({ __isChunk: true, text: '\n' })
    const line = conversationLines[i]
    if (line.startsWith('you: ')) {
      chunks.push(fg(theme.blue)(`> ${line.slice(5)}`))
    } else if (line.startsWith('agent: ')) {
      const text = line.slice(7)
      if (!text) continue
      chunks.push(fg(theme.fg)(`  ${text}`))
    } else if (line.startsWith('error:')) {
      chunks.push(fg(theme.red)(line))
    } else {
      chunks.push({ __isChunk: true, text: line })
    }
  }
  conversationText.content = new StyledText(chunks)
}

function updateActivity() {
  activityText.content = activityLines.join('\n')
}

async function sendMessage(text: string) {
  if (isBusy) return
  isBusy = true

  conversationLines.push(`you: ${text}`)
  updateConversation()

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

  const timeout = setTimeout(() => {
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
          currentAgentContent += msg.content as string
          conversationLines[agentLineIndex] = `agent: ${currentAgentContent}`
          updateConversation()
          break
        }
        case 'reasoning': {
          const chunk = msg.content as string
          if (activityLines.length === 0 || !activityLines[activityLines.length - 1].startsWith('  reasoning:')) {
            activityLines.push(`  reasoning: ${chunk}`)
          } else {
            activityLines[activityLines.length - 1] += chunk
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
          return
        case 'error':
          conversationLines.push(`error: ${msg.error as string}`)
          updateConversation()
          return
      }
    }
  } catch (err) {
    conversationLines.push(`error: ${err}`)
    updateConversation()
  } finally {
    clearTimeout(timeout)
    isBusy = false
    input.focus()
  }
}
