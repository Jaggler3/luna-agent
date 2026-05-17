import { createCliRenderer, Box, Text, InputRenderable, InputRenderableEvents, t, fg } from "@opentui/core"
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

const messagesArea = Box({ flexGrow: 1, gap: 1 })
const activityArea = Box({ flexGrow: 1, gap: 1 })

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

async function sendMessage(text: string) {
  if (isBusy) return
  isBusy = true

  messagesArea.add(Text({
    content: t`${fg(theme.comment)(`you: ${text}`)}`,
  }))

  if (conn.child.exitCode !== null) {
    const err = `agent exited (code ${conn.child.exitCode})`
    messagesArea.add(Text({ content: t`${fg(theme.red)(err)}` }))
    isBusy = false
    input.focus()
    return
  }

  conn.send(text)

  const timeout = setTimeout(() => {
    messagesArea.add(Text({ content: t`${fg(theme.red)("timed out waiting for agent")}` }))
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
        activityArea.add(Text({
          content: t`${fg(theme.cyan)(`→ ${label}`)}`,
        }))
      } else if (msg.type === 'tool_result') {
        // could log result details here
      } else if (msg.response) {
        messagesArea.add(Text({
          content: t`${fg(theme.fg)(msg.response as string)}`,
        }))
        break
      } else if (msg.error) {
        messagesArea.add(Text({
          content: t`${fg(theme.red)(`error: ${msg.error}`)}`,
        }))
        break
      }
    }
  } catch (err) {
    messagesArea.add(Text({
      content: t`${fg(theme.red)(`error: ${err}`)}`,
    }))
  } finally {
    clearTimeout(timeout)
    isBusy = false
    input.focus()
  }
}
