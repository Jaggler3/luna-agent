import { spawn } from 'node:child_process'
import { createCliRenderer, Box, ScrollBox, TextRenderable, TextareaRenderable, StyledText, fg, bg, MarkdownRenderable, DiffRenderable, pathToFiletype } from "@opentui/core"
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

const scheduleActivityUpdate = makeDebouncedUpdate(() => {
  void updateActivity()
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
let activityListInstance: any = null
let activityRefreshTimer: ReturnType<typeof setInterval> | null = null
let activityUpdateSeq = 0
let latestGitSnapshot: GitActivitySnapshot | null = null
let lastRenderedSnapshotKey: string | null = null

// ── UI components ─────────────────────────────────────────

const MSG_BG = {
  user: '#20283a',
  assistant: theme.bg,
  thoughts: '#1e1d2e',
  system: '#1e2030',
  error: '#2a1520',
} as const

type MessageRole = keyof typeof MSG_BG
type BodyMode = 'text' | 'markdown'
type MessageBlock = {
  key: string
  boxId: string
  role: MessageRole
  mode: BodyMode
  content: string
  body: TextRenderable | MarkdownRenderable
  box: any
}

const conversationBlocks: MessageBlock[] = []

export const conversationList = Box({
  id: 'conversation-list',
  flexDirection: 'column',
  gap: 1,
  width: '100%',
} as any) as any

let conversationListInstance: any = null

type GitFileChange = {
  key: string
  path: string
  status: string
  sections: GitDiffSection[]
}

type GitDiffSection = {
  label: string
  diff: string
  filetype: string
}

type GitActivityBlock = {
  key: string
  boxId: string
  path: string
  status: string
  sections: GitDiffSection[]
  expanded: boolean
  header: TextRenderable
  body: any
  box: any
}

const activityBlocks: GitActivityBlock[] = []

function makeRenderableId(prefix: string, key: string): string {
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  }
  const safeKey = key
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `${prefix}-${safeKey || 'item'}-${hash.toString(36)}`
}

export const activityList = Box({
  id: 'activity-list',
  flexDirection: 'column',
  gap: 1,
  width: '100%',
} as any) as any

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
    title: "",
    titleColor: theme.green,
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
    activityList,
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

function gitCwd(): string {
  return process.env.LUNA_CWD ?? process.cwd()
}

type GitCommandResult = {
  exitCode: number | null
  stdout: string
  stderr: string
}

function runGit(args: string[]): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', gitCwd(), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', () => {
      resolve({ exitCode: null, stdout, stderr })
    })
    child.on('close', (exitCode: number | null) => {
      resolve({ exitCode, stdout, stderr })
    })
  })
}

function isGitRepo(result: GitCommandResult): boolean {
  return result.exitCode === 0 && result.stdout.trim() === 'true'
}

async function getGitBranchLabel(): Promise<string | null> {
  const [branchResult, headResult] = await Promise.all([
    runGit(['branch', '--show-current']),
    runGit(['rev-parse', '--short', 'HEAD']),
  ])
  const branch = branchResult.stdout.trim()
  if (branch) return branch
  const detached = headResult.stdout.trim()
  return detached ? `HEAD:${detached}` : 'HEAD'
}

function parseGitStatus(raw: string): GitFileChange[] {
  if (!raw) return []
  const records = raw.split('\0').filter(Boolean)
  const changes: GitFileChange[] = []
  for (const record of records) {
    const status = record.slice(0, 2)
    const path = record.slice(3)
    if (!path) continue
    changes.push({
      key: path,
      path,
      status,
      sections: [],
    })
  }
  return changes
}

async function buildGitFileDiffSections(path: string, status: string): Promise<GitDiffSection[]> {
  const sections: GitDiffSection[] = []
  const filetype = pathToFiletype(path) ?? 'text'
  const staged = status[0] && status[0] !== ' ' && status[0] !== '?'
  const unstaged = status[1] && status[1] !== ' '
  const untracked = status === '??'

  if (staged) {
    const stagedDiff = await runGit(['diff', '--cached', '--no-color', '--', path])
    if (stagedDiff.stdout) sections.push({ label: 'staged', diff: stagedDiff.stdout, filetype })
  }
  if (untracked) {
    const added = await runGit(['diff', '--no-index', '--no-color', '--', '/dev/null', path])
    if (added.stdout) sections.push({ label: 'untracked', diff: added.stdout, filetype })
  } else if (unstaged) {
    const workingDiff = await runGit(['diff', '--no-color', '--', path])
    if (workingDiff.stdout) sections.push({ label: 'working tree', diff: workingDiff.stdout, filetype })
  }

  return sections
}

function makeActivityHeader(change: GitFileChange, expanded: boolean): StyledText {
  const arrow = expanded ? '▼' : '▶'
  const status = change.status.trim()
  const statusStyle = getGitStatusStyle(status)
  const chunks: TextChunk[] = [fg(theme.green)(` ${arrow} `), fg(theme.fg)(change.path)]
  if (status) chunks.push(fg(statusStyle)(` [${status}]`))
  return new StyledText(chunks)
}

function getGitStatusStyle(status: string): string {
  if (status === '??') return theme.yellow
  if (status.includes('D')) return theme.red
  if (status.includes('A')) return theme.green
  if (status.includes('M')) return theme.yellow
  if (status.includes('R')) return theme.blue
  if (status.includes('C')) return theme.cyan
  if (status.includes('U')) return theme.red
  return theme.comment
}

function commonIndentPrefix(a: string, b: string): string {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return a.slice(0, i)
}

function dedentUnifiedDiffForDisplay(diff: string): string {
  const lines = diff.replace(/\r\n/g, '\n').split('\n')
  const output: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.startsWith('@@ ')) {
      output.push(line)
      continue
    }

    let hunkEnd = i + 1
    while (hunkEnd < lines.length && !lines[hunkEnd].startsWith('@@ ')) {
      hunkEnd++
    }

    const hunkLines = lines.slice(i + 1, hunkEnd)
    let indent: string | null = null
    for (const hunkLine of hunkLines) {
      const marker = hunkLine[0]
      if (marker !== ' ' && marker !== '+' && marker !== '-') continue
      const content = hunkLine.slice(1)
      if (!content.trim()) continue
      const leadingWhitespace = content.match(/^[ \t]+/)?.[0] ?? ''
      if (!leadingWhitespace) continue
      indent = indent === null ? leadingWhitespace : commonIndentPrefix(indent, leadingWhitespace)
      if (!indent) break
    }

    output.push(line)
    for (const hunkLine of hunkLines) {
      if (!indent) {
        output.push(hunkLine)
        continue
      }

      const marker = hunkLine[0]
      if (marker !== ' ' && marker !== '+' && marker !== '-') {
        output.push(hunkLine)
        continue
      }

      const content = hunkLine.slice(1)
      output.push(`${marker}${content.startsWith(indent) ? content.slice(indent.length) : content}`)
    }

    i = hunkEnd - 1
  }

  return output.join('\n')
}

function makeDiffRenderable(change: GitFileChange, section: GitDiffSection, sectionIndex: number) {
  const diff = new DiffRenderable(renderer, {
    id: `${makeRenderableId('activity-diff', `${change.key}-${sectionIndex}`)}-diff`,
    diff: dedentUnifiedDiffForDisplay(section.diff),
    view: 'unified',
    filetype: section.filetype,
    syntaxStyle,
    fg: theme.fg,
    wrapMode: 'none',
    syncScroll: true,
    showLineNumbers: true,
    addedBg: '#153025',
    removedBg: '#30171d',
    contextBg: 'transparent',
    addedSignColor: theme.green,
    removedSignColor: theme.red,
    lineNumberFg: theme.comment,
  } as any)

  const getScrollableCode = () => (diff as any).leftCodeRenderable ?? (diff as any).rightCodeRenderable
  const scrollHorizontally = (delta: number) => {
    const code = getScrollableCode()
    if (!code) return false
    code.scrollX = Math.max(0, code.scrollX + delta)
    code.requestRender?.()
    diff.requestRender()
    return true
  }
  const handleScroll = (ev: any) => {
    const direction = ev?.scroll?.direction
    if (!direction) return
    const delta = ev?.scroll?.delta ?? 1
    const horizontalDelta =
      direction === 'left' || (direction === 'up' && ev?.modifiers?.shift) ? -delta
      : direction === 'right' || (direction === 'down' && ev?.modifiers?.shift) ? delta
      : direction === 'up' ? -delta
      : direction === 'down' ? delta
      : 0
    if (horizontalDelta === 0) return

    if (scrollHorizontally(horizontalDelta)) {
      ev?.preventDefault?.()
      ev?.stopPropagation?.()
    }
  }

  diff.onMouseScroll = handleScroll
  const code = getScrollableCode()
  if (code) code.onMouseScroll = handleScroll

  return diff
}

function makeActivitySectionBlock(change: GitFileChange, section: GitDiffSection, sectionIndex: number) {
  const label = new TextRenderable(renderer, {
    id: `${makeRenderableId('activity-section', `${change.key}-${sectionIndex}`)}-label`,
    content: new StyledText([
      fg(theme.comment)(`  ${section.label}`),
    ]),
    selectable: false,
  })
  const diff = makeDiffRenderable(change, section, sectionIndex)
  return Box(
    {
      flexDirection: 'column',
      backgroundColor: theme.bgHighlight,
      paddingX: 1,
      paddingTop: 1,
      paddingBottom: 1,
      gap: 1,
      width: '100%',
    } as any,
    label,
    diff,
  ) as any
}

function makeActivityBlock(change: GitFileChange): GitActivityBlock {
  const boxId = makeRenderableId('activity', change.key)
  const header = new TextRenderable(renderer, {
    id: `${boxId}-header`,
    content: makeActivityHeader(change, false),
    selectable: false,
  })
  const bodyChildren = change.sections.length > 0
    ? change.sections.map((section, index) => makeActivitySectionBlock(change, section, index))
    : [
      new TextRenderable(renderer, {
        id: `${boxId}-body-empty`,
        content: '(no diff output)',
        selectable: false,
      }),
    ]
  const body = Box(
    {
      id: `${boxId}-body`,
      flexDirection: 'column',
      gap: 1,
      width: '100%',
    } as any,
    ...bodyChildren,
  ) as any
  body.visible = false
  const box = Box(
    {
      id: boxId,
      flexDirection: 'column',
      backgroundColor: theme.bg,
      paddingX: 2,
      paddingTop: 1,
      paddingBottom: 1,
      gap: 1,
      width: '100%',
    } as any,
    header,
    body,
  ) as any

  const block: GitActivityBlock = {
    key: change.key,
    boxId,
    path: change.path,
    status: change.status,
    sections: change.sections,
    expanded: false,
    header,
    body,
    box,
  }
  header.onMouseDown = (ev: { button: number }) => {
    if (ev.button === 0) toggleActivityBlock(block.key)
  }
  return block
}

function toggleActivityBlock(key: string) {
  const block = activityBlocks.find((b) => b.key === key)
  if (!block) return
  block.expanded = !block.expanded
  block.body.visible = block.expanded
  block.header.content = makeActivityHeader({ key: block.key, path: block.path, status: block.status, sections: block.sections }, block.expanded)
  block.body.requestRender()
  block.box.requestRender()
  activityBoxInstance?.requestRender?.()
  renderer.requestRender()
  updateActivity()
}

type GitActivitySnapshot = {
  insideRepo: boolean
  branchLabel: string | null
  changes: GitFileChange[]
}

async function collectGitActivity(): Promise<GitActivitySnapshot> {
  const [repoResult, statusResult] = await Promise.all([
    runGit(['rev-parse', '--is-inside-work-tree']),
    runGit(['status', '--porcelain=v1', '--no-renames', '-uall', '-z']),
  ])

  if (!isGitRepo(repoResult)) {
    return { insideRepo: false, branchLabel: null, changes: [] }
  }

  const changes = parseGitStatus(statusResult.stdout)
  const branchLabel = await getGitBranchLabel()

  if (changes.length === 0) {
    return { insideRepo: true, branchLabel, changes: [] }
  }

  const nextChanges = await Promise.all(
    changes.map(async (change) => ({
      ...change,
      sections: await buildGitFileDiffSections(change.path, change.status),
    })),
  )
  return { insideRepo: true, branchLabel, changes: nextChanges }
}

function snapshotFingerprint(snapshot: GitActivitySnapshot): string {
  if (!snapshot.insideRepo) return 'no-repo'
  const changesKey = snapshot.changes
    .map(c => `${c.key}\x00${c.status}\x00${c.sections.map(s => s.diff).join('\x01')}`)
    .join('\x02')
  return `${snapshot.branchLabel}\x02${changesKey}`
}

function activityViewFingerprint(snapshot: GitActivitySnapshot): string {
  const snapshotKey = snapshotFingerprint(snapshot)
  const expandedKey = activityBlocks
    .map(block => `${block.key}:${block.expanded ? '1' : '0'}`)
    .join('\x02')
  return `${snapshotKey}\x03${expandedKey}`
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

function makeRoleLabel(role: MessageRole): StyledText {
  if (role === 'user') return new StyledText([fg(theme.blue)('you')])
  if (role === 'assistant') return new StyledText([fg(theme.purple)('luna')])
  if (role === 'thoughts') return new StyledText([fg(theme.comment)('thinking')])
  if (role === 'error') return new StyledText([fg(theme.red)('error')])
  return new StyledText([fg(theme.comment)('system')])
}

function makeMessageBlock(desc: { key: string; role: MessageRole; mode: BodyMode; content: string }): MessageBlock {
  const boxId = `block-${desc.key}`
  const bodyId = `body-${desc.key}`
  const body = desc.mode === 'markdown'
    ? new MarkdownRenderable(renderer, {
      id: bodyId,
      syntaxStyle,
      fg: theme.fg,
      content: desc.content,
    })
    : new TextRenderable(renderer, {
      id: bodyId,
      fg: theme.fg,
      content: desc.content,
      wrapMode: 'word',
    })

  const label = new TextRenderable(renderer, {
    id: `${bodyId}-label`,
    content: makeRoleLabel(desc.role),
    selectable: false,
  })

  const box = Box({
    id: boxId,
    flexDirection: 'column',
    backgroundColor: MSG_BG[desc.role],
    paddingX: 2,
    paddingTop: 1,
    paddingBottom: 1,
    gap: 0,
    width: '100%',
  } as any, label, body) as any

  return { ...desc, boxId, body, box }
}

function setBlockContent(block: MessageBlock, content: string) {
  if (block.content === content) return
  block.content = content
  block.body.content = content
}

function clearConversationBlocks() {
  const list = (conversationListInstance ?? conversationList) as unknown as { remove(id: string): void }
  for (const block of conversationBlocks) list.remove(block.boxId)
  conversationBlocks.length = 0
}

function assistantMarkdownContent(msg: { content: string; reasoning?: string; thinkingExpanded?: boolean }, isStreaming: boolean): string {
  const parts: string[] = []
  if (msg.reasoning && msg.reasoning.trim()) {
    if (isStreaming || msg.thinkingExpanded) {
      parts.push(`> [!NOTE]\n> **Thinking Process:**\n> ${msg.reasoning.trim().replace(/\n/g, '\n> ')}`)
    }
  }
  if (msg.content) {
    if (parts.length > 0) parts.push('\n\n')
    parts.push(msg.content)
  }
  return parts.join('')
}

function assistantTextContent(msg: { content: string; reasoning?: string }): string {
  const parts: string[] = []
  if (msg.reasoning && msg.reasoning.trim()) {
    parts.push(`thinking\n${msg.reasoning.trim()}`)
  }
  if (msg.content) parts.push(msg.content)
  return parts.join('\n\n')
}

export function updateConversation() {
  try {
    const a = activeAgent()
    if (!a || a.messages.length === 0) {
      clearConversationBlocks()
      return
    }
    const desired: { key: string; role: MessageRole; mode: BodyMode; content: string }[] = []

    for (let i = 0; i < a.messages.length; i++) {
      const msg = a.messages[i]
      if (msg.role === 'user') {
        desired.push({ key: `msg-${i}-user`, role: 'user', mode: 'text', content: msg.content })
      } else if (msg.role === 'assistant') {
        const isStreaming = a.isBusy && i === a.messages.length - 1
        desired.push({
          key: `msg-${i}-assistant`,
          role: 'assistant',
          mode: isStreaming ? 'text' : 'markdown',
          content: isStreaming ? assistantTextContent(msg) : assistantMarkdownContent(msg, false),
        })
      } else if (msg.role === 'system') {
        desired.push({
          key: `msg-${i}-system`,
          role: msg.error ? 'error' : 'system',
          mode: 'text',
          content: msg.content,
        })
      }
    }

    const list = (conversationListInstance ?? conversationList) as unknown as { add(c: unknown): void; remove(id: string): void }
    const desiredKeys = new Set(desired.map((desc) => desc.key))
    for (let i = conversationBlocks.length - 1; i >= 0; i--) {
      const block = conversationBlocks[i]
      const next = desired.find((desc) => desc.key === block.key)
      if (!desiredKeys.has(block.key) || !next || next.mode !== block.mode || next.role !== block.role) {
        list.remove(block.boxId)
        conversationBlocks.splice(i, 1)
      }
    }

    const blocksByKey = new Map(conversationBlocks.map((block) => [block.key, block]))
    for (const desc of desired) {
      const block = blocksByKey.get(desc.key)
      if (block) {
        setBlockContent(block, desc.content)
      } else {
        const next = makeMessageBlock(desc)
        list.add(next.box)
        conversationBlocks.push(next)
      }
    }
  } catch (e) { log('updateConversation error', e) }
}

export function updateActivity() {
  try {
    const snapshot = latestGitSnapshot
    if (!snapshot) return

    const key = activityViewFingerprint(snapshot)
    log("updateActivity lastRenderedSnapshotKey: ", lastRenderedSnapshotKey, "new key: ", key)
    if (key === lastRenderedSnapshotKey) return
    lastRenderedSnapshotKey = key

    const { insideRepo, branchLabel, changes } = snapshot
    const previousExpanded = new Map(activityBlocks.map((block) => [block.key, block.expanded]))
    const list = (activityListInstance ?? activityList) as unknown as { add(c: unknown): void; remove(id: string): void }
    for (const block of activityBlocks) list.remove(block.boxId)
    activityBlocks.length = 0

    if (activityBoxInstance) {
      const target = activityBoxInstance as unknown as { visible: boolean; width: number; title: string }
      target.visible = insideRepo
      target.width = insideRepo ? 42 : 0
      target.title = insideRepo ? (branchLabel ?? '') : ''
    }
    if (!insideRepo) {
      return
    }

    if (changes.length === 0) {
      const emptyKey = '__clean__'
      const boxId = makeRenderableId('activity-clean', emptyKey)
      const header = new TextRenderable(renderer, {
        id: `${boxId}-header`,
        content: '▶ working tree clean',
        selectable: false,
      })
      const body = new TextRenderable(renderer, {
        id: `${boxId}-body`,
        content: 'No current changes.',
        selectable: false,
      })
      const box = Box({
        id: boxId,
        flexDirection: 'column',
        backgroundColor: theme.bg,
        paddingX: 2,
        paddingTop: 1,
        paddingBottom: 1,
        gap: 1,
        width: '100%',
      } as any, header, body) as any
      body.visible = false
      const block: GitActivityBlock = {
        key: emptyKey,
        boxId,
        path: 'working tree clean',
        status: '',
        sections: [],
        expanded: false,
        header,
        body,
        box,
      }
      header.onMouseDown = (ev: { button: number }) => { if (ev.button === 0) toggleActivityBlock(emptyKey) }
      list.add(block.box)
      activityBlocks.push(block)
      return
    }

    for (const change of changes) {
      const next = makeActivityBlock(change)
      next.expanded = previousExpanded.get(next.key) ?? false
      next.body.visible = next.expanded
      next.header.content = makeActivityHeader(change, next.expanded)
      list.add(next.box)
      activityBlocks.push(next)
    }
  } catch (e) { log('updateActivity error', String(e), (e as any)?.stack ?? '') }
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
  clearConversationBlocks()
  updateConversation()
  void updateActivity()
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
  scheduleActivityUpdate()
})

storeEmitter.on('health-checked', () => {
  scheduleStatusUpdate()
})

storeEmitter.on('stream-start', () => {
  scheduleConversationUpdate()
})

storeEmitter.on('stream-end', () => {
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
  const foundConvList = renderer.root.findDescendantById('conversation-list')
  if (foundConvList) conversationListInstance = foundConvList
  const foundActivityList = renderer.root.findDescendantById('activity-list')
  if (foundActivityList) activityListInstance = foundActivityList

  input.focus()

  updateBoxTitle()
  updateConversation()
  void updateActivity()
  updateTabs()

  if (!activityRefreshTimer) {
    const poll = async () => {
      latestGitSnapshot = await collectGitActivity()
      updateActivity()
    }
    void poll()
    activityRefreshTimer = setInterval(() => { void poll() }, 1000)
  }

}
