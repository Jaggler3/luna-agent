import { TextRenderable, Box, StyledText, fg } from "@opentui/core"
import { log, theme } from '../config'
import { activeAgent, saveConversation } from '../store'
import { collectGitActivity as collectGitActivitySnapshot } from '../git-activity'
import { generateCommitDraft } from '../commit-message'
import { commitAllChanges } from '../git-actions'
import {
  renderer, S,
  conversationBlocks, activityBlocks,
  activityList, conversationList,
  makeMessageBlock, setBlockContent, clearConversationBlocks,
  assistantMarkdownContent, assistantTextContent,
  makeActivityHeader, makeActivityBlock,
  activityViewFingerprint, gitCwd,
  activityBox,
} from './shared'
import { box, makeRenderableId, convertBracketSyntax } from './helpers'

export function updateConversation() {
  try {
    const a = activeAgent()
    if (!a || a.messages.length === 0) {
      clearConversationBlocks()
      return
    }
    const desired: { key: string; role: 'user' | 'assistant' | 'system' | 'error'; mode: 'text' | 'markdown'; content: string }[] = []

    for (let i = 0; i < a.messages.length; i++) {
      const msg = a.messages[i]
      if (msg.role === 'user') {
        desired.push({ key: `msg-${i}-user`, role: 'user', mode: 'markdown', content: convertBracketSyntax(msg.content) })
      } else if (msg.role === 'assistant') {
        const isStreaming = a.isBusy && i === a.messages.length - 1
        const raw = isStreaming ? assistantTextContent(msg, a.streamFrame) : assistantMarkdownContent(msg, false)
        desired.push({
          key: `msg-${i}-assistant`,
          role: 'assistant',
          mode: isStreaming ? 'text' : 'markdown',
          content: convertBracketSyntax(raw),
        })
      } else if (msg.role === 'system') {
        desired.push({
          key: `msg-${i}-system`,
          role: msg.error ? 'error' : 'system',
          mode: 'markdown',
          content: convertBracketSyntax(msg.content),
        })
      }
    }

    const list = S.conversationListInstance ?? conversationList
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

export function toggleActivityBlock(key: string) {
  const block = activityBlocks.find((b) => b.key === key)
  if (!block) return
  block.expanded = !block.expanded
  block.body.visible = block.expanded
  block.header.content = makeActivityHeader({ key: block.key, path: block.path, status: block.status, sections: block.sections }, block.expanded)
  block.body.requestRender()
  block.box.requestRender()
  ;(S.activityBoxInstance ?? activityBox)?.requestRender?.()
  renderer.requestRender()
  updateActivity()
}

export function updateActivity() {
  try {
    const snapshot = S.latestGitSnapshot
    if (!snapshot) return

    const key = activityViewFingerprint(snapshot)
    if (key === S.lastRenderedSnapshotKey) return
    S.lastRenderedSnapshotKey = key

    const { insideRepo, branchLabel, changes } = snapshot
    const previousExpanded = new Map(activityBlocks.map((block) => [block.key, block.expanded]))
    const list = (S.activityListInstance ?? activityList) as unknown as { add(c: unknown): void; remove(id: string): void }
    for (const block of activityBlocks) list.remove(block.boxId)
    activityBlocks.length = 0

    if (S.activityBoxInstance) {
      const target = S.activityBoxInstance as unknown as { visible: boolean; width: number; title: string }
      target.visible = insideRepo
      target.width = insideRepo ? 42 : 0
      target.title = insideRepo ? (branchLabel ?? '') : ''
    }
    if (!insideRepo) return

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
      const blockBox = box({
        id: boxId,
        flexDirection: 'column',
        backgroundColor: theme.bg,
        paddingX: 2,
        paddingTop: 1,
        paddingBottom: 1,
        gap: 1,
        width: '100%',
      }, header, body)
      body.visible = false
      const block = {
        key: emptyKey,
        boxId,
        path: 'working tree clean',
        status: '',
        sections: [],
        expanded: false,
        header,
        body,
        box: blockBox,
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
  } catch (e) { log('updateActivity error', String(e), e instanceof Error ? e.stack : '') }
}

export async function generateCommitSummary() {
  const snapshot = S.latestGitSnapshot
  if (!snapshot || snapshot.changes.length === 0) {
    log('generate commit summary ignored: no git changes')
    return
  }
  const draft = await generateCommitDraft(snapshot, { log })
  if (S.commitNameInput) S.commitNameInput.value = draft.title
  if (S.commitBodyInput) S.commitBodyInput.setText(draft.body)
  S.commitNameInput?.focus()
  S.commitNameInput?.requestRender?.()
  S.commitBodyInput?.requestRender?.()
  renderer.requestRender()
}

export async function commitChanges() {
  const name = S.commitNameInput?.plainText.trim() ?? ''
  const body = S.commitBodyInput?.plainText.trim() ?? ''
  if (!name) {
    log('commit ignored: empty commit name')
    return
  }
  const commitResult = await commitAllChanges(gitCwd(), name, body)
  if (commitResult.exitCode !== 0) {
    log('git commit failed', commitResult.stderr || commitResult.stdout)
    return
  }
  if (S.commitNameInput) S.commitNameInput.value = ''
  S.commitBodyInput?.setText('')
  S.commitNameInput?.requestRender?.()
  S.commitBodyInput?.requestRender?.()
  S.latestGitSnapshot = await collectGitActivitySnapshot(gitCwd())
  updateActivity()
  log('git commit complete')
}
