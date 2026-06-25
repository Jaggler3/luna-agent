import { createCliRenderer, Box, ScrollBox, TextRenderable, TextareaRenderable, InputRenderable, StyledText, fg, bg, MarkdownRenderable, DiffRenderable } from "@opentui/core"
import type { TextChunk } from "@opentui/core"
import { theme, syntaxStyle, log } from '../config'
import { currentWorkspaceCwd } from '../config'
import type { GitDiffSection, GitFileChange } from '../git-activity'
import { activityViewFingerprint as gitActivityViewFingerprint, collectGitActivity as collectGitActivitySnapshot } from '../git-activity'
import type { GitActivitySnapshot } from '../git-activity'
import { dedentUnifiedDiffForDisplay } from '../diff-display'
import { generateCommitDraft } from '../commit-message'
import { commitAllChanges, pushChanges as gitPushChanges } from '../git-actions'
import { MSG_BG, type MessageRole, type MessageBlock, type GitActivityBlock, type BodyMode } from './types'
import { makeRenderableId } from './helpers'
import { activeAgent, agents, activeId, scanAgents, switchAgent, createNewAgent, closeCurrentAgent, switchToNextAgent, switchToPrevAgent, storeEmitter } from '../store'

export const renderer = await createCliRenderer({ exitOnCtrlC: true })

// ── All mutable state in one object for cross-module reassignment ──
export const S = {
  tabAreaInstance: null as any,
  conversationBoxInstance: null as any,
  activityBoxInstance: null as any,
  tabsBoxInstance: null as any,
  sidebarCollapsed: false,
  tabsMascotEyesOpen: true,
  tabsMascotBlinkTimer: null as ReturnType<typeof setTimeout> | null,
  tabsMascotBlinkResetTimer: null as ReturnType<typeof setTimeout> | null,
  activityListInstance: null as any,
  activityRefreshTimer: null as ReturnType<typeof setInterval> | null,
  latestGitSnapshot: null as GitActivitySnapshot | null,
  lastRenderedSnapshotKey: null as string | null,
  commitNameInput: null as InputRenderable | null,
  commitBodyInput: null as TextareaRenderable | null,
  slashCommandHelpInstance: null as any,
  copyToastInstance: null as any,
  copyToastTimer: null as ReturnType<typeof setTimeout> | null,
  conversationListInstance: null as any,
}

export const conversationBlocks: MessageBlock[] = []
export const activityBlocks: GitActivityBlock[] = []

export const conversationList = Box({
  id: 'conversation-list',
  flexDirection: 'column',
  gap: 1,
  width: '100%',
} as any) as any

export const activityList = Box({
  id: 'activity-list',
  flexDirection: 'column',
  gap: 1,
  width: '100%',
} as any) as any

export const tabArea = Box({ id: 'tab-area', flexDirection: 'column', gap: 1, width: 24 })

const tabsSpacer = Box({
  id: 'tabs-spacer',
  flexGrow: 1,
  width: '100%',
} as any)

function makeTabsMascotContent(eyesOpen: boolean): StyledText {
  const eye = eyesOpen ? 'o' : '-'
  return new StyledText([
    fg(theme.comment)(`      )
   /\\     /\\
  /. \\___/. \\
  \\  ${eye}  ${eye}   /
   \\___-___/`),
  ])
}

const tabsMascotText = new TextRenderable(renderer, {
  id: 'tabs-mascot-text',
  content: makeTabsMascotContent(true),
  selectable: false,
})

const tabsMascot = Box(
  {
    id: 'tabs-mascot',
    flexDirection: 'column',
    width: '100%',
    paddingTop: 1,
    paddingBottom: 1,
  } as any,
  tabsMascotText,
) as any

export function syncTabsMascotVisibility() {
  tabsMascot.visible = !S.sidebarCollapsed
}

export function scheduleTabsMascotBlink() {
  if (S.tabsMascotBlinkTimer) clearTimeout(S.tabsMascotBlinkTimer)
  const delay = 5000 + Math.floor(Math.random() * 5001)
  S.tabsMascotBlinkTimer = setTimeout(() => {
    S.tabsMascotBlinkTimer = null
    if (S.sidebarCollapsed) {
      scheduleTabsMascotBlink()
      return
    }
    S.tabsMascotEyesOpen = false
    tabsMascotText.content = makeTabsMascotContent(false)
    S.tabsBoxInstance?.requestRender?.()
    renderer.requestRender()
    if (S.tabsMascotBlinkResetTimer) clearTimeout(S.tabsMascotBlinkResetTimer)
    S.tabsMascotBlinkResetTimer = setTimeout(() => {
      S.tabsMascotBlinkResetTimer = null
      S.tabsMascotEyesOpen = true
      tabsMascotText.content = makeTabsMascotContent(true)
      S.tabsBoxInstance?.requestRender?.()
      renderer.requestRender()
      scheduleTabsMascotBlink()
    }, 120)
  }, delay)
}

export const collapseBtn = new TextRenderable(renderer, {
  id: 'collapse-btn',
  content: new StyledText([fg(theme.comment)(' ▶ ')]),
  selectable: false,
})

collapseBtn.onMouseDown = (ev: { button: number }) => {
  if (ev.button === 0) toggleSidebar()
}

const copyToastText = new TextRenderable(renderer, {
  id: 'copy-toast-text',
  content: new StyledText([fg(theme.green)(' Copied! ')]),
  selectable: false,
})

export const copyToast = Box(
  {
    id: 'copy-toast',
    position: 'absolute',
    top: 1,
    right: 28,
    width: 13,
    height: 3,
    zIndex: 100,
    visible: false,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.bgHighlight,
    borderStyle: 'rounded',
    borderColor: theme.green,
  } as any,
  copyToastText,
) as any

export function syncCopyToastPosition() {
  const toast = S.copyToastInstance ?? copyToast
  toast.right = S.sidebarCollapsed ? 6 : 28
}

export function showCopiedToast() {
  const toast = S.copyToastInstance ?? copyToast
  syncCopyToastPosition()
  toast.visible = true
  toast.requestRender?.()
  renderer.requestRender()
  if (S.copyToastTimer) clearTimeout(S.copyToastTimer)
  S.copyToastTimer = setTimeout(() => {
    S.copyToastTimer = null
    toast.visible = false
    toast.requestRender?.()
    renderer.requestRender()
  }, 1000)
}

export function copyTextToClipboard(text: string): boolean {
  if (!text) return false
  const copiedWithOsc52 = renderer.copyToClipboardOSC52(text)
  if (copiedWithOsc52) return true
  try {
    const p = require('node:child_process')
    p.execSync('pbcopy', { input: text })
    return true
  } catch (e) {
    log('copy failed', e)
    return false
  }
}

export const slashCommandHelpText = new TextRenderable(renderer, {
  id: 'slash-command-help-text',
  content: '',
  selectable: false,
  wrapMode: 'word',
})

export const slashCommandHelp = Box(
  {
    id: 'slash-command-help',
    visible: false,
    height: 0,
    flexDirection: 'column',
    backgroundColor: '#1e2030',
    borderStyle: 'single',
    borderColor: theme.border,
    paddingX: 2,
    paddingTop: 1,
    paddingBottom: 1,
    width: '100%',
  } as any,
  slashCommandHelpText,
) as any

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
  onSubmit: () => {},
  onContentChange: () => {},
})

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
  slashCommandHelp,
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
  Box(
    {
      id: 'activity-content',
      flexGrow: 1,
      flexDirection: 'column',
      width: '100%',
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
    makeCommitFooter(),
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
  tabsSpacer,
  tabsMascot,
)

// ── Factory Functions ──────────────────────────────────
export function makeRoleLabel(role: MessageRole): StyledText {
  if (role === 'user') return new StyledText([fg(theme.blue)('you')])
  if (role === 'assistant') return new StyledText([fg(theme.purple)('luna')])
  if (role === 'thoughts') return new StyledText([fg(theme.comment)('thinking')])
  if (role === 'error') return new StyledText([fg(theme.red)('error')])
  return new StyledText([fg(theme.comment)('system')])
}

export function makeMessageBlock(desc: { key: string; role: MessageRole; mode: BodyMode; content: string }): MessageBlock {
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

export function setBlockContent(block: MessageBlock, content: string) {
  if (block.content === content) return
  block.content = content
  block.body.content = content
}

export function clearConversationBlocks() {
  const list = (S.conversationListInstance ?? conversationList) as unknown as { remove(id: string): void }
  for (const block of conversationBlocks) list.remove(block.boxId)
  conversationBlocks.length = 0
}

export function assistantMarkdownContent(msg: { content: string; reasoning?: string; thinkingExpanded?: boolean }, isStreaming: boolean): string {
  const parts: string[] = []
  if (msg.reasoning && msg.reasoning.trim()) {
    if (isStreaming || msg.thinkingExpanded) {
      parts.push(`> ${msg.reasoning.trim().replace(/\n/g, '\n> ')}`)
    }
  }
  if (msg.content) {
    if (parts.length > 0) parts.push('\n\n')
    parts.push(msg.content)
  }
  return parts.join('')
}

export function assistantTextContent(msg: { content: string; reasoning?: string }, streamFrame = ''): string {
  const parts: string[] = []
  if (streamFrame) parts.push(streamFrame)
  if (msg.reasoning && msg.reasoning.trim()) {
    parts.push(`~thinking~\n${msg.reasoning.trim()}`)
  }
  if (msg.content) parts.push(msg.content)
  return parts.join('\n\n')
}

export function getGitStatusStyle(status: string): string {
  if (status === '??') return theme.yellow
  if (status.includes('D')) return theme.red
  if (status.includes('A')) return theme.green
  if (status.includes('M')) return theme.yellow
  if (status.includes('R')) return theme.blue
  if (status.includes('C')) return theme.cyan
  if (status.includes('U')) return theme.red
  return theme.comment
}

export function makeActivityHeader(change: { key: string; path: string; status: string; sections: GitDiffSection[] }, expanded: boolean): StyledText {
  const arrow = expanded ? '▼' : '▶'
  const status = change.status.trim()
  const statusStyle = getGitStatusStyle(status)
  const chunks: TextChunk[] = [fg(theme.green)(` ${arrow} `), fg(theme.fg)(change.path)]
  if (status) chunks.push(fg(statusStyle)(` [${status}]`))
  return new StyledText(chunks)
}

function makeDiffRenderable(change: { key: string }, section: GitDiffSection, sectionIndex: number) {
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

function makeActivitySectionBlock(change: { key: string }, section: GitDiffSection, sectionIndex: number) {
  const label = new TextRenderable(renderer, {
    id: `${makeRenderableId('activity-section', `${change.key}-${sectionIndex}`)}-label`,
    content: new StyledText([fg(theme.comment)(`  ${section.label}`)]),
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

export function makeActivityBlock(change: GitFileChange): GitActivityBlock {
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
  return {
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
}

// ── Git Activity ───────────────────────────────────────
export function gitCwd(): string {
  return activeAgent()?.meta.cwd ?? currentWorkspaceCwd()
}

export function activityViewFingerprint(snapshot: GitActivitySnapshot): string {
  const expandedKey = activityBlocks
    .map(block => `${block.key}:${block.expanded ? '1' : '0'}`)
    .join('\x02')
  return gitActivityViewFingerprint(snapshot, expandedKey)
}

// ── Commit Footer Factory ──────────────────────────────
function makeFooterButton(id: string, label: string, color: string, onClick: () => void) {
  const button = new TextRenderable(renderer, {
    id,
    content: new StyledText([bg(theme.bgHighlight)(fg(color)(` ${label} `))]),
    selectable: false,
  })
  button.onMouseDown = (ev: { button: number }) => {
    if (ev.button === 0) onClick()
  }
  return button
}

function makeSparkleButton(onClick: () => void) {
  return makeFooterButton('commit-generate', '✨', theme.green, onClick)
}

export function makeCommitFooter() {
  S.commitNameInput = new InputRenderable(renderer, {
    id: 'commit-name-input',
    placeholder: 'Commit name',
    backgroundColor: theme.bgHighlight,
    focusedBackgroundColor: theme.bgHighlight,
    textColor: theme.fg,
    focusedTextColor: theme.fg,
    cursorColor: theme.blue,
    maxLength: 120,
    flexGrow: 1,
  })
  S.commitBodyInput = new TextareaRenderable(renderer, {
    id: 'commit-body-input',
    placeholder: 'Commit body',
    backgroundColor: theme.bgHighlight,
    focusedBackgroundColor: theme.bgHighlight,
    textColor: theme.fg,
    focusedTextColor: theme.fg,
    cursorColor: theme.blue,
    wrapMode: 'word',
    height: 4,
    minHeight: 4,
    width: '100%',
  })
  const generateButton = makeSparkleButton(() => {
    void import('./updaters').then(m => m.generateCommitSummary())
  })
  const commitButton = makeFooterButton('commit-button', 'Commit', theme.blue, () => {
    void import('./updaters').then(m => m.commitChanges())
  })
  return Box(
    {
      id: 'commit-footer',
      flexDirection: 'column',
      gap: 1,
      width: '100%',
    } as any,
    Box(
      {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 1,
        width: '100%',
      } as any,
      S.commitNameInput,
      generateButton,
    ),
    S.commitBodyInput,
    Box(
      {
        flexDirection: 'row',
        gap: 1,
        width: '100%',
      } as any,
      commitButton,
    ),
  ) as any
}

// ── Sidebar Toggle ─────────────────────────────────────
export function toggleSidebar() {
  S.sidebarCollapsed = !S.sidebarCollapsed
  try {
    const tb = S.tabsBoxInstance as unknown as { width: number }
    if (tb) tb.width = S.sidebarCollapsed ? 3 : 24
    syncTabsMascotVisibility()
    syncCopyToastPosition()
    collapseBtn.content = new StyledText([
      S.sidebarCollapsed ? fg(theme.blue)(' ◀ ') : fg(theme.comment)(' ▶ ')
    ])
    S.tabsBoxInstance?.requestRender?.()
    renderer.requestRender()
  } catch (e) { log('toggleSidebar error', e) }
}

// ── Box Title ──────────────────────────────────────────
export function updateBoxTitle() {
  try {
    const target = (S.conversationBoxInstance ?? conversationBox) as unknown as { title: string }
    const a = activeAgent()
    if (!a) { target.title = 'Conversation'; return }
    const dot = a.isRunning ? ' ●' : ' ○'
    const pid = a.meta.pid && a.isRunning ? ` (PID ${a.meta.pid})` : ''
    const cwd = a.meta.cwd ?? currentWorkspaceCwd()
    target.title = `${a.meta.name}${pid}${dot}  ${cwd}`
  } catch (e) { log('updateBoxTitle error', e) }
}

// ── Tabs ───────────────────────────────────────────────
export function updateTabs() {
  try {
    const ta = (S.tabAreaInstance ?? tabArea) as unknown as {
      add(child: unknown): void
      remove(id: string): unknown
      getChildren(): { id: string }[]
    }
    if (S.tabAreaInstance) {
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
    const newBtn = new TextRenderable(renderer, {
      id: 'tab-new',
      content: new StyledText([fg(theme.green)('  + new agent')]),
      selectable: false,
    })
    newBtn.onMouseDown = (ev: { button: number }) => { if (ev.button === 0) createNewAgent() }
    ta.add(newBtn)
  } catch (e) { log('updateTabs error', e) }
}
