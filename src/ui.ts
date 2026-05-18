import { createCliRenderer, Box, ScrollBox, TextRenderable, TextareaRenderable, StyledText, fg, bg, MarkdownRenderable } from "@opentui/core"
import type { TextChunk, Renderable } from "@opentui/core"
import { theme, syntaxStyle, log } from './config'
import { agents, activeAgent, activeId, switchAgent, createNewAgent, closeCurrentAgent, switchToNextAgent, switchToPrevAgent, scanAgents, saveConversation, storeEmitter } from './store'
import { sendMessage } from './daemon'

export const renderer = await createCliRenderer({ exitOnCtrlC: true })

let tabAreaInstance: Renderable | null = null
let conversationBoxInstance: Renderable | null = null
let activityBoxInstance: Renderable | null = null
let tabsBoxInstance: Renderable | null = null
let conversationListInstance: any = null
let sidebarCollapsed = false

// ── UI components ─────────────────────────────────────────

// Background colours for each message role
const MSG_BG = {
  user:      '#1f2335',  // slightly lighter than bg
  assistant: '#1a1b26',  // same as bg (neutral)
  thoughts:  '#1e1d2e',  // faint purple tint
  system:    '#1e2030',  // faint blue tint
  error:     '#2a1520',  // faint red tint
} as const

// Container that the ScrollBox holds – column of message blocks
export const conversationList = Box({
  id: 'conversation-list',
  flexDirection: 'column',
  gap: 1,
  width: '100%',
} as any) as any

// Track rendered message blocks so we can diff them
interface MsgBlock {
  key: string               // stable id for this block
  boxId: string
  mdId: string
  isStreaming: boolean
  md: MarkdownRenderable
  box: any
}
let _msgBlocks: MsgBlock[] = []
let _streamingMd: MarkdownRenderable | null = null

function makeMessageBox(role: 'user' | 'assistant' | 'thoughts' | 'system' | 'error', boxId: string, mdId: string, content: string, isStreaming: boolean): MsgBlock {
  const bgColor = MSG_BG[role]

  const md = new MarkdownRenderable(renderer, {
    id: mdId,
    syntaxStyle,
    fg: theme.fg,
    content,
    streaming: isStreaming,
  })

  // Label styling per role
  let labelChunks: any[] = []
  if (role === 'user') {
    labelChunks = [fg(theme.blue)('you')]
  } else if (role === 'assistant') {
    labelChunks = [fg(theme.purple)('luna')]
  } else if (role === 'thoughts') {
    labelChunks = [fg(theme.comment)('thinking')]
  } else if (role === 'error') {
    labelChunks = [fg(theme.red)('error')]
  } else {
    labelChunks = [fg(theme.comment)('system')]
  }

  const label = new TextRenderable(renderer, {
    id: `${mdId}-label`,
    content: new StyledText(labelChunks),
    selectable: false,
  })

  const box = Box({
    id: boxId,
    flexDirection: 'column',
    backgroundColor: bgColor,
    paddingX: 2,
    paddingTop: 1,
    paddingBottom: 1,
    gap: 0,
    width: '100%',
  } as any, label, md) as any

  return { key: boxId, boxId, mdId, isStreaming, md, box }
}


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
    conversationList,
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

const COMMON_EXTENSIONS = [
  'ts', 'tsx', 'js', 'jsx', 'json', 'md', 'yml', 'yaml', 'toml',
  'txt', 'rs', 'go', 'py', 'sh', 'css', 'html', 'lock', 'ini',
  'cfg', 'conf', 'log', 'env', 'gitignore', 'gitattributes'
];

const EXCLUDED_SLASH_WORDS = new Set([
  'his/her', 'him/her', 'he/she', 'and/or', 'either/or', 'yes/no',
  'true/false', 'on/off', 'in/out', 'up/down', 'left/right',
  'black/white', 'man/woman', 'boy/girl', 'read/write', 'import/export',
  'input/output', 'get/set', 'a/b', 'x/y', 'w/o'
]);

function isFilePath(path: string): boolean {
  const clean = path.trim().replace(/[/\\]+$/, '');

  if (clean.startsWith('./') || clean.startsWith('../') || clean.startsWith('.\\') || clean.startsWith('..\\')) {
    return true;
  }
  if (clean.startsWith('/') && clean.includes('/') && clean.length > 2) {
    return true;
  }
  if (/^[A-Za-z]:\\[\w\.-]+/.test(clean)) {
    return true;
  }
  if ((clean.includes('/') || clean.includes('\\')) && /\.[a-zA-Z0-9_-]+$/.test(clean)) {
    return true;
  }

  const fileName = clean.split(/[/\\]/).pop() || '';
  if (fileName.startsWith('.') && fileName.length > 1) {
    return true;
  }
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  if (COMMON_EXTENSIONS.includes(ext)) {
    return true;
  }

  return false;
}

function isDirectoryPath(path: string): boolean {
  const clean = path.trim();
  if (EXCLUDED_SLASH_WORDS.has(clean.toLowerCase())) {
    return false;
  }
  if (clean.endsWith('/') || clean.endsWith('\\')) {
    return true;
  }
  if (clean.startsWith('./') || clean.startsWith('../') || clean.startsWith('/') || clean.startsWith('~/')) {
    return true;
  }

  const segments = clean.split(/[/\\]/);
  const knownDirs = [
    'node_modules', 'packages', 'src', '.git', 'bin', 'lib', 'dist', 'build',
    '.github', 'test', 'tests', 'apps', 'components', 'utils', 'helpers',
    'config', 'public', 'assets', 'docs', 'scripts', 'server', 'client'
  ];

  if (segments.some(seg => knownDirs.includes(seg.toLowerCase()))) {
    return true;
  }
  if (segments.length >= 3) {
    return true;
  }

  return false;
}

function highlightPathsInPlainText(text: string): string {
  const urls: string[] = [];
  let placeholderText = text.replace(/https?:\/\/[^\s]+/g, (url) => {
    urls.push(url);
    return `__URL_PLACEHOLDER_${urls.length - 1}__`;
  });

  const pathRegex = /(?:\b|(?<=[\s"'\(\[]))((?:\.\.?\/|~\/|\/)[a-zA-Z0-9_\-\.\+]+(?:\/[a-zA-Z0-9_\-\.\+]+)*|(?:\.\.?\\|~\\|[a-zA-Z0-9_\-\.]+)\\[a-zA-Z0-9_\-\.\\\+]+|[a-zA-Z0-9_\-\.\+]+(?:\/[a-zA-Z0-9_\-\.\+]+)+|[a-zA-Z0-9_\-\.\+]+\.(?:ts|tsx|js|jsx|json|md|yml|yaml|toml|txt|rs|go|py|sh|css|html|lock)|\.[a-zA-Z0-9_\-]+)\b/g;

  placeholderText = placeholderText.replace(pathRegex, (match) => {
    const cleanMatch = match.trim();
    if (isFilePath(cleanMatch)) {
      return `\`📄 ${cleanMatch}\``;
    } else if (isDirectoryPath(cleanMatch)) {
      return `\`📁 ${cleanMatch}\``;
    }
    return match;
  });

  return placeholderText.replace(/__URL_PLACEHOLDER_(\d+)__/g, (_, idx) => {
    return urls[parseInt(idx, 10)];
  });
}

function preprocessMarkdown(text: string): string {
  const codeBlockParts = text.split(/(```[\s\S]*?```)/g);

  return codeBlockParts.map((part, index) => {
    if (index % 2 === 1) {
      return part;
    }

    const inlineParts = part.split(/(`[^`\n]+`)/g);

    return inlineParts.map((subPart, subIndex) => {
      if (subIndex % 2 === 1) {
        const inner = subPart.slice(1, -1).trim();
        if (isFilePath(inner)) {
          return `\`📄 ${inner}\``;
        } else if (isDirectoryPath(inner)) {
          return `\`📁 ${inner}\``;
        }
        return subPart;
      }

      return highlightPathsInPlainText(subPart);
    }).join('');
  }).join('');
}

export function updateConversation() {
  try {
    const a = activeAgent()
    const list = (conversationListInstance ?? conversationList) as unknown as { add(c: unknown): void; remove(id: string): void; getChildren(): { id: string }[] }

    if (!a || a.messages.length === 0) {
      // Clear all blocks
      for (const b of _msgBlocks) list.remove(b.boxId)
      _msgBlocks = []
      _streamingMd = null
      return
    }

    // Build desired block descriptors
    type BlockDesc = { key: string; role: 'user' | 'assistant' | 'thoughts' | 'system' | 'error'; content: string; isStreaming: boolean }
    const desired: BlockDesc[] = []

    for (let i = 0; i < a.messages.length; i++) {
      const msg = a.messages[i]

      if (!msg.preprocessedContent || msg.lastPreprocessedSource !== msg.content) {
        msg.preprocessedContent = preprocessMarkdown(msg.content)
        msg.lastPreprocessedSource = msg.content
      }

      const isLast = i === a.messages.length - 1
      const isMsgStreaming = a.isBusy && isLast

      if (msg.role === 'user') {
        desired.push({ key: `msg-${i}-user`, role: 'user', content: msg.preprocessedContent, isStreaming: false })
      } else if (msg.role === 'assistant') {
        if (msg.reasoning && msg.reasoning.trim()) {
          const showFull = isMsgStreaming || msg.thinkingExpanded
          const thoughtContent = showFull
            ? msg.reasoning.trim()
            : '_▶ thoughts (click /t to expand)_'
          desired.push({ key: `msg-${i}-thoughts`, role: 'thoughts', content: thoughtContent, isStreaming: isMsgStreaming && !msg.content })
        }
        if (msg.content) {
          desired.push({ key: `msg-${i}-assistant`, role: 'assistant', content: msg.preprocessedContent, isStreaming: isMsgStreaming })
        }
      } else if (msg.role === 'system') {
        const role = msg.error ? 'error' : 'system'
        desired.push({ key: `msg-${i}-${role}`, role, content: msg.preprocessedContent, isStreaming: false })
      }
    }

    // Diff: remove blocks no longer needed (by key)
    const desiredKeys = new Set(desired.map(d => d.key))
    const surviving: MsgBlock[] = []
    for (const b of _msgBlocks) {
      if (!desiredKeys.has(b.key)) {
        list.remove(b.boxId)
      } else {
        surviving.push(b)
      }
    }
    const survivingMap = new Map(surviving.map(b => [b.key, b]))

    // Update streaming flag on previous streaming block
    if (_streamingMd && _streamingMd.streaming) {
      _streamingMd.streaming = false
      _streamingMd = null
    }

    // Add / update blocks in order
    const newBlocks: MsgBlock[] = []
    for (const desc of desired) {
      const existing = survivingMap.get(desc.key)
      if (existing) {
        // Update content in place
        existing.md.content = desc.content
        if (desc.isStreaming) {
          existing.md.streaming = true
          _streamingMd = existing.md
        }
        newBlocks.push(existing)
      } else {
        // Create new block
        const boxId = `block-${desc.key}`
        const mdId = `md-${desc.key}`
        const block = makeMessageBox(desc.role, boxId, mdId, desc.content, desc.isStreaming)
        if (desc.isStreaming) _streamingMd = block.md
        list.add(block.box)
        newBlocks.push(block)
      }
    }

    _msgBlocks = newBlocks
  } catch (e) { log('updateConversation error', e) }
}

export function updateActivity() {
  try {
    const a = activeAgent()
    const hasDiffs = a ? a.diffLines.length > 0 : false
    if (activityBoxInstance) {
      (activityBoxInstance as unknown as { visible: boolean; width: number }).visible = hasDiffs;
      (activityBoxInstance as unknown as { visible: boolean; width: number }).width = hasDiffs ? 50 : 0;
    }
    if (hasDiffs && a) {
      const fullText = a.diffLines.join('\n')
      const lines = fullText.split('\n')
      const chunks: any[] = []
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (line.startsWith('✎')) {
          chunks.push(fg(theme.purple)(line))
        } else if (line === '---') {
          chunks.push(fg(theme.comment)(line))
        } else if (line.startsWith('+++') || line.startsWith('---')) {
          chunks.push(fg(theme.yellow)(line))
        } else if (line.startsWith('+')) {
          chunks.push(fg(theme.green)(line))
        } else if (line.startsWith('-')) {
          chunks.push(fg(theme.red)(line))
        } else if (line.startsWith('@@')) {
          chunks.push(fg(theme.cyan)(line))
        } else {
          chunks.push(fg(theme.fg)(line))
        }
        if (i < lines.length - 1) {
          chunks.push('\n')
        }
      }
      activityText.content = new StyledText(chunks)
    } else {
      activityText.content = ''
    }
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
  updateConversation()
  updateBoxTitle()
})

storeEmitter.on('switch', () => {
  // Clear all blocks when switching agents so they rebuild fresh
  const list = (conversationListInstance ?? conversationList) as unknown as { remove(id: string): void; getChildren(): { id: string }[] }
  for (const b of _msgBlocks) list.remove(b.boxId)
  _msgBlocks = []
  if (_streamingMd) { _streamingMd.streaming = false; _streamingMd = null }
  updateConversation()
  updateActivity()
  updateBoxTitle()
  updateTabs()
  input.focus()
})

storeEmitter.on('name-updated', () => {
  updateBoxTitle()
  updateTabs()
})

storeEmitter.on('activity-updated', () => {
  updateActivity()
})

storeEmitter.on('health-checked', () => {
  updateBoxTitle()
  updateTabs()
})

storeEmitter.on('stream-start', () => {
  // streaming flag is set per-block in updateConversation
})

storeEmitter.on('stream-end', () => {
  if (_streamingMd) { _streamingMd.streaming = false; _streamingMd = null }
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
  const foundConvList = renderer.root.findDescendantById('conversation-list')
  if (foundConvList) conversationListInstance = foundConvList

  input.focus()

  updateBoxTitle()
  updateConversation()
  updateActivity()
  updateTabs()
}
