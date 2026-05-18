import { createCliRenderer, Box, ScrollBox, TextRenderable, TextareaRenderable, StyledText, fg, bg, MarkdownRenderable } from "@opentui/core"
import type { TextChunk, Renderable } from "@opentui/core"
import { theme, syntaxStyle, log } from './config'
import { agents, activeAgent, activeId, switchAgent, createNewAgent, closeCurrentAgent, switchToNextAgent, switchToPrevAgent, scanAgents, saveConversation, storeEmitter } from './store'
import { sendMessage } from './daemon'

function makeDebouncedUpdate(fn: () => void, delay = 50) {
  let scheduled = false
  return function schedule() {
    if (scheduled) return
    scheduled = true
    setTimeout(() => {
      scheduled = false
      fn()
    }, delay)
  }
}

const scheduleConversationUpdate = makeDebouncedUpdate(() => {
  updateConversation()
})

const scheduleStatusUpdate = makeDebouncedUpdate(() => {
  updateBoxTitle()
  updateTabs()
})

export const renderer = await createCliRenderer({ exitOnCtrlC: true })

let tabAreaInstance: Renderable | null = null
let conversationBoxInstance: Renderable | null = null
let activityBoxInstance: Renderable | null = null
let tabsBoxInstance: Renderable | null = null
let sidebarCollapsed = false

// ── UI components ─────────────────────────────────────────

export const markdownConversation = new MarkdownRenderable(renderer, {
  id: 'conversation-content',
  syntaxStyle,
  fg: theme.fg,
  content: '',
})

export const activityText = new TextRenderable(renderer, {
  id: 'activity-content',
  fg: theme.fg,
  content: '',
})

export const tabArea = Box({ id: 'tab-area', flexDirection: 'column', gap: 1, width: 24 })

export const collapseBtn = new TextRenderable(renderer, {
  id: 'collapse-btn',
  content: new StyledText([fg(theme.comment)(' ▶ ')]),
  selectable: false,
})
collapseBtn.onMouseDown = (ev: { button: number }) => {
  if (ev.button === 0) toggleSidebar()
}

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

export const input = new TextareaRenderable(renderer, {
  id: 'main-input',
  placeholder: "Ask the agent to do something...",
  backgroundColor: theme.bgHighlight,
  focusedBackgroundColor: theme.bgHighlight,
  textColor: theme.fg,
  cursorColor: theme.blue,
  wrapMode: "word",
  maxHeight: 5,
  paddingTop: 1,
  keyBindings: [
    { name: "return", action: "submit" },
    { name: "linefeed", action: "submit" },
    { name: "return", shift: true, action: "newline" },
  ],
  onSubmit: handleSubmit,
})

// Boxes (created early, added to layout later)
export const conversationBox = Box(
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
  } as any,
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
) as any

export const activityBox = Box(
  {
    id: 'activity-box',
    visible: false,
    width: 0,
    borderStyle: "rounded",
    borderColor: theme.border,
    backgroundColor: theme.bg,
    title: "Activity",
    titleColor: theme.purple,
    padding: 1,
    gap: 1,
  } as any,
  ScrollBox(
    {
      flexGrow: 1,
      stickyScroll: true,
      stickyStart: "bottom",
      scrollY: true,
    },
    activityText,
  ),
) as any

export const tabsBox = Box(
  {
    id: 'tabs-box',
    width: 24,
    flexDirection: "column",
    gap: 1,
    paddingTop: 1,
    paddingLeft: 1,
  },
  collapseBtn,
  tabArea,
)

export function updateBoxTitle() {
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

export function toggleLatestThought(index?: number) {
  try {
    const a = activeAgent()
    if (!a) return
    if (typeof index === 'number') {
      const msg = a.messages[index]
      if (msg && msg.role === 'assistant' && msg.reasoning) {
        msg.thinkingExpanded = !msg.thinkingExpanded
        saveConversation(a.id, a.messages)
        updateConversation()
      }
      return
    }
    const latestAssistantMsg = [...a.messages].reverse().find(m => m.role === 'assistant' && m.reasoning)
    if (latestAssistantMsg) {
      latestAssistantMsg.thinkingExpanded = !latestAssistantMsg.thinkingExpanded
      saveConversation(a.id, a.messages)
      updateConversation()
    }
  } catch (e) { log('toggleLatestThought error', e) }
}

export function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed
  try {
    const tb = tabsBoxInstance as unknown as { width: number }
    if (tb) {
      tb.width = sidebarCollapsed ? 3 : 24
    }
    collapseBtn.content = new StyledText([
      sidebarCollapsed ? fg(theme.blue)(' ◀ ') : fg(theme.comment)(' ▶ ')
    ])
  } catch (e) { log('toggleSidebar error', e) }
}

export function updateConversation() {
  try {
    const a = activeAgent()
    if (!a || a.messages.length === 0) {
      markdownConversation.content = ''
      return
    }
    const parts: string[] = []
    for (let i = 0; i < a.messages.length; i++) {
      const msg = a.messages[i]
      if (parts.length > 0) parts.push('\n\n')
      if (msg.role === 'user') {
        parts.push(`> ${msg.content.replace(/\n/g, '\n> ')}`)
      } else if (msg.role === 'assistant') {
        const messageParts: string[] = []
        if (msg.reasoning && msg.reasoning.trim()) {
          const isStreaming = a.isBusy && i === a.messages.length - 1
          if (isStreaming || msg.thinkingExpanded) {
            messageParts.push(`> [!NOTE]\n> **Thinking Process:**\n> ${msg.reasoning.trim().replace(/\n/g, '\n> ')}`)
          } else {
            messageParts.push(`> **[Thinking Process collapsed. Press Ctrl+T or click button below to expand]**`)
          }
        }
        if (msg.content) {
          if (messageParts.length > 0) messageParts.push('\n\n')
          messageParts.push(msg.content)
        }
        parts.push(messageParts.join(''))
      } else if (msg.role === 'system') {
        if (msg.error) {
          parts.push(`*error: ${msg.content}*`)
        } else {
          parts.push(`*system: ${msg.content}*`)
        }
      } else {
        parts.push(msg.content)
      }
    }
    markdownConversation.content = parts.join('')
  } catch (e) { log('updateConversation error', e) }
}

export function updateActivity() {
  try {
    const a = activeAgent()
    const hasDiffs = a ? a.diffLines.length > 0 : false
    if (activityBoxInstance) {
      (activityBoxInstance as unknown as { visible: boolean; width: number }).visible = hasDiffs;
      (activityBoxInstance as unknown as { visible: boolean; width: number }).width = hasDiffs ? 35 : 0
    }
    activityText.content = hasDiffs && a ? a.diffLines.join('\n') : ''
  } catch (e) { log('updateActivity error', e) }
}

export function updateTabs() {
  try {
    const ta = (tabAreaInstance ?? tabArea) as unknown as { add(child: unknown): void; remove(id: string): unknown; getChildren(): { id: string }[] }
    if (tabAreaInstance) {
      for (const child of ta.getChildren()) ta.remove(child.id)
    }
    const ids = scanAgents()
    for (const id of ids) {
      const a = agents.get(id)
      if (!a) continue
      const isActive = id === activeId
      const dotChar = a.isRunning ? '●' : '○'
      const label = ` ${dotChar} ${a.meta.name.padEnd(15).slice(0, 15)} `
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
        content: new StyledText([fg(theme.comment)(`${'─'.repeat(21)}`)]),
        selectable: false,
      }))
    }
    const newBtn = new TextRenderable(renderer, { id: 'tab-new', content: new StyledText([fg(theme.green)('  + new agent')]), selectable: false })
    newBtn.onMouseDown = (ev: { button: number }) => { if (ev.button === 0) createNewAgent() }
    ta.add(newBtn)
  } catch (e) { log('updateTabs error', e) }
}

export function handleSlashCommand(value: string): boolean {
  if (value === '/debug') {
    const a = activeAgent()
    const lines = [
      '=== Conversation ===',
      ...(a?.messages.map(m => `${m.role}: ${m.content}${m.reasoning ? `\nreasoning: ${m.reasoning}` : ''}`) ?? []),
      '',
      '=== Activity ===',
      ...(a?.diffLines ?? []),
    ]
    const p = require('node:child_process')
    p.execSync('pbcopy', { input: lines.join('\n') })
    const prev = input.placeholder
    input.placeholder = "Copied!"
    setTimeout(() => { input.placeholder = prev }, 1500)
    return true
  }
  if (value === '/thought' || value === '/t') {
    toggleLatestThought()
    return true
  }
  if (value.startsWith('/thought ') || value.startsWith('/t ')) {
    const parts = value.split(' ')
    const idx = parseInt(parts[1], 10)
    if (!isNaN(idx)) {
      toggleLatestThought(idx)
    }
    return true
  }
  return false
}

// ── Keyboard / Input bindings ──────────────────────────────────
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
  if (event.ctrl && event.name === "b") {
    event.preventDefault()
    toggleSidebar()
    return
  }
  if (event.ctrl && event.name === "t") {
    event.preventDefault()
    toggleLatestThought()
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

// ── Observers for Store Events ──────────────────────────────────
storeEmitter.on('update', () => {
  scheduleConversationUpdate()
})

storeEmitter.on('switch', () => {
  markdownConversation.streaming = false
  updateConversation()
  updateActivity()
  updateBoxTitle()
  updateTabs()
  input.focus()
})

storeEmitter.on('name-updated', () => {
  // Name changes are infrequent; update immediately
  updateBoxTitle()
  updateTabs()
})

storeEmitter.on('activity-updated', () => {
  updateActivity()
})

storeEmitter.on('health-checked', () => {
  scheduleStatusUpdate()
})

storeEmitter.on('stream-start', () => {
  if (!markdownConversation.streaming) markdownConversation.streaming = true
})

storeEmitter.on('stream-end', () => {
  markdownConversation.streaming = false
  scheduleConversationUpdate()
})

storeEmitter.on('focus-input', () => {
  input.focus()
})

// ── Layout rendering ────────────────────────────────────────────
export function bootUI() {
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

  const foundTabArea = renderer.root.findDescendantById('tab-area')
  if (foundTabArea) tabAreaInstance = foundTabArea
  const foundTabsBox = renderer.root.findDescendantById('tabs-box')
  if (foundTabsBox) tabsBoxInstance = foundTabsBox
  const foundConvBox = renderer.root.findDescendantById('conversation-box')
  if (foundConvBox) conversationBoxInstance = foundConvBox
  const foundActivityBox = renderer.root.findDescendantById('activity-box')
  if (foundActivityBox) activityBoxInstance = foundActivityBox

  input.focus()

  updateBoxTitle()
  updateConversation()
  updateActivity()
  updateTabs()
}
