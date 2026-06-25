import { storeEmitter } from '../store'
import { collectGitActivity as collectGitActivitySnapshot } from '../git-activity'
import { box, makeDebouncedUpdate } from './helpers'
import {
  renderer, S, copyToast,
  conversationBox, activityBox, tabsBox,
  input, syncTabsMascotVisibility, scheduleTabsMascotBlink,
  syncCopyToastPosition, gitCwd,
  clearConversationBlocks,
} from './shared'
import { updateConversation, updateActivity } from './updaters'
import { updateBoxTitle, updateTabs } from './shared'
import { bindKeyboard, initInputHandlers } from './commands'

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

// ── Store Observers ────────────────────────────────────
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

// ── Boot ───────────────────────────────────────────────
export function bootUI() {
  renderer.root.add(
    box(
      {
        flexDirection: "row",
        width: "100%",
        height: "100%",
        backgroundColor: "#1a1b26",
      },
      conversationBox,
      activityBox,
      tabsBox,
    ),
  )
  renderer.root.add(copyToast)

  const foundTabArea = renderer.root.findDescendantById('tab-area')
  if (foundTabArea) S.tabAreaInstance = foundTabArea
  const foundTabsBox = renderer.root.findDescendantById('tabs-box')
  if (foundTabsBox) S.tabsBoxInstance = foundTabsBox
  const foundConvBox = renderer.root.findDescendantById('conversation-box')
  if (foundConvBox) S.conversationBoxInstance = foundConvBox
  const foundSlashCommandHelp = renderer.root.findDescendantById('slash-command-help')
  if (foundSlashCommandHelp) S.slashCommandHelpInstance = foundSlashCommandHelp
  const foundActivityBox = renderer.root.findDescendantById('activity-box')
  if (foundActivityBox) S.activityBoxInstance = foundActivityBox
  const foundConvList = renderer.root.findDescendantById('conversation-list')
  if (foundConvList) S.conversationListInstance = foundConvList
  const foundActivityList = renderer.root.findDescendantById('activity-list')
  if (foundActivityList) S.activityListInstance = foundActivityList
  const foundCopyToast = renderer.root.findDescendantById('copy-toast')
  if (foundCopyToast) S.copyToastInstance = foundCopyToast
  syncCopyToastPosition()

  initInputHandlers()
  bindKeyboard()
  input.focus()

  updateBoxTitle()
  updateConversation()
  void updateActivity()
  updateTabs()
  syncTabsMascotVisibility()
  scheduleTabsMascotBlink()

  if (!S.activityRefreshTimer) {
    const poll = async () => {
      S.latestGitSnapshot = await collectGitActivitySnapshot(gitCwd())
      updateActivity()
    }
    void poll()
    S.activityRefreshTimer = setInterval(() => { void poll() }, 1000)
  }
}
