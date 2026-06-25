import { createCliRenderer, Box, ScrollBox, TextRenderable, TextareaRenderable, InputRenderable, StyledText, fg, bg, MarkdownRenderable, DiffRenderable } from "@opentui/core"
import type { TextChunk } from "@opentui/core"
import { theme, syntaxStyle, log } from '../config'
import { currentWorkspaceCwd } from '../config'
import type { GitDiffSection, GitFileChange } from '../git-activity'
import { activityViewFingerprint as gitActivityViewFingerprint, collectGitActivity as collectGitActivitySnapshot } from '../git-activity'
import type { GitActivitySnapshot } from '../git-activity'
import { dedentUnifiedDiffForDisplay } from '../diff-display'
import { MSG_BG, type MessageRole, type MessageBlock, type GitActivityBlock, type BodyMode } from './types'
import { makeRenderableId } from './helpers'

export const renderer = await createCliRenderer({ exitOnCtrlC: true })

export let tabAreaInstance: any = null
export let conversationBoxInstance: any = null
export let activityBoxInstance: any = null
export let tabsBoxInstance: any = null
export let sidebarCollapsed = false
export let tabsMascotEyesOpen = true
export let tabsMascotBlinkTimer: ReturnType<typeof setTimeout> | null = null
export let tabsMascotBlinkResetTimer: ReturnType<typeof setTimeout> | null = null
export let activityListInstance: any = null
export let activityRefreshTimer: ReturnType<typeof setInterval> | null = null
export let latestGitSnapshot: GitActivitySnapshot | null = null
export let lastRenderedSnapshotKey: string | null = null
export let commitNameInput: InputRenderable | null = null
export let commitBodyInput: TextareaRenderable | null = null
export let slashCommandHelpInstance: any = null
export let copyToastInstance: any = null
export let copyToastTimer: ReturnType<typeof setTimeout> | null = null
export let conversationListInstance: any = null

export const conversationBlocks: MessageBlock[] = []
export const activityBlocks: GitActivityBlock[] = []

export function setSidebarCollapsed(v: boolean) { sidebarCollapsed = v }

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
  tabsMascot.visible = !sidebarCollapsed
}

export function scheduleTabsMascotBlink() {
  if (tabsMascotBlinkTimer) clearTimeout(tabsMascotBlinkTimer)
  const delay = 5000 + Math.floor(Math.random() * 5001)
  tabsMascotBlinkTimer = setTimeout(() => {
    tabsMascotBlinkTimer = null
    if (sidebarCollapsed) {
      scheduleTabsMascotBlink()
      return
    }
    tabsMascotEyesOpen = false
    tabsMascotText.content = makeTabsMascotContent(false)
    tabsBoxInstance?.requestRender?.()
    renderer.requestRender()
    if (tabsMascotBlinkResetTimer) clearTimeout(tabsMascotBlinkResetTimer)
    tabsMascotBlinkResetTimer = setTimeout(() => {
      tabsMascotBlinkResetTimer = null
      tabsMascotEyesOpen = true
      tabsMascotText.content = makeTabsMascotContent(true)
      tabsBoxInstance?.requestRender?.()
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
  const toast = copyToastInstance ?? copyToast
  toast.right = sidebarCollapsed ? 6 : 28
}

export function showCopiedToast() {
  const toast = copyToastInstance ?? copyToast
  syncCopyToastPosition()
  toast.visible = true
  toast.requestRender?.()
  renderer.requestRender()
  if (copyToastTimer) clearTimeout(copyToastTimer)
  copyToastTimer = setTimeout(() => {
    copyToastTimer = null
    toast.visible = false
    toast.requestRender?.()
    renderer.requestRender()
  }, 1000)
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

// ── make* functions ────────────────────────────────────

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
  const list = (conversationListInstance ?? conversationList) as unknown as { remove(id: string): void }
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
  return block
}

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
  commitNameInput = new InputRenderable(renderer, {
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
  commitBodyInput = new TextareaRenderable(renderer, {
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
  const generateButton = makeSparkleButton(() => { void generateCommitSummary() })
  const commitButton = makeFooterButton('commit-button', 'Commit', theme.blue, () => { void commitChanges() })
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
      commitNameInput,
      generateButton,
    ),
    commitBodyInput,
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

import { generateCommitDraft } from '../commit-message'
import { commitAllChanges, pushChanges as gitPushChanges } from '../git-actions'
import { collectGitActivity as collectGitActivitySnapshot } from '../git-activity'
