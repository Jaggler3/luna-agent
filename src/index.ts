import { createCliRenderer, Box, Text, Input, InputRenderableEvents, t, fg, bold } from "@opentui/core"

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
      Box(
        { flexGrow: 1, gap: 1 },
        Text({ content: t`${fg(theme.cyan)("luna")}  ${bold(fg(theme.comment)("— coding agent harness"))}` }),
        Text({ content: t`${fg(theme.comment)("Your conversation with the agent will appear here. Type a message below to get started.")}` }),
      ),
      Input({
        placeholder: "Ask the agent to do something...",
        backgroundColor: theme.bgHighlight,
        focusedBackgroundColor: theme.bgHighlight,
        textColor: theme.fg,
        cursorColor: theme.blue,
        width: 999,
      }),
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
      Text({ content: t`${fg(theme.comment)("Agent actions will appear here.")}` }),
      Text({ content: t`${fg(theme.comment)("File edits, searches, commands...")}` }),
    ),
  ),
)
