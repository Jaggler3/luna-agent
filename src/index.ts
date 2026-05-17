import { createCliRenderer, Box, TextRenderable, InputRenderable, InputRenderableEvents, t, fg } from "@opentui/core"
import { connect } from 'luna-gateway'

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

const conn = connect({
  agentId: crypto.randomUUID(),
  entrypoint: 'src/agent.ts',
})

let isBusy = false
let conversationLines: string[] = []
let activityLines: string[] = []

const conversationText = new TextRenderable(renderer, {
  id: 'conversation-content',
  content: t`${fg(theme.comment)("Your conversation with the agent will appear here.")}`,
})

const activityText = new TextRenderable(renderer, {
  id: 'activity-content',
  content: t`${fg(theme.comment)("Agent actions will appear here.")}`,
})

const messagesArea = Box({ flexGrow: 1, gap: 1 })
const activityArea = Box({ flexGrow: 1, gap: 1 })

messagesArea.add(conversationText)
activityArea.add(activityText)

const input = new InputRenderable(renderer, {
  id: 'main-input',
  placeholder: "Ask the agent to do something...",
  backgroundColor: theme.bgHighlight,
  focusedBackgroundColor: theme.bgHighlight,
  textColor: theme.fg,
  cursorColor: theme.blue,
  width: 999,
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
        width: 40,
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
  ),
)

function updateConversation() {
  conversationText.content = conversationLines.join('\n')
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

  conn.send(text)

  const timeout = setTimeout(() => {
    conversationLines.push('timed out waiting for agent')
    updateConversation()
    isBusy = false
    input.focus()
  }, 120_000)

  try {
    for await (const msg of conn.receive()) {
      if (msg.type === 'tool_call') {
        const name = msg.name as string
        const args = msg.args as string
        let label = name
        try {
          const parsed = JSON.parse(args)
          label = `${name} ${Object.values(parsed).join(' ')}`
        } catch {}
        activityLines.push(`→ ${label}`)
        updateActivity()
      } else if (msg.response) {
        conversationLines.push(msg.response as string)
        updateConversation()
        break
      } else if (msg.error) {
        conversationLines.push(`error: ${msg.error}`)
        updateConversation()
        break
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
