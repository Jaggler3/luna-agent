import { log } from '../config'
import { activeAgent, renameActiveAgent, createNewAgent, closeCurrentAgent, switchToNextAgent, switchToPrevAgent, clearActiveConversation } from '../store'
import { sendMessage, resetActiveAgentToBoilerplate } from '../daemon'
import { toggleLatestThought, updateConversation, updateActivity } from './updaters'
import {
  renderer, S,
  conversationBox,
  input,
  clearConversationBlocks,
  copyTextToClipboard,
  showCopiedToast,
  slashCommandHelpText,
} from './shared'
import { updateBoxTitle, updateTabs, toggleSidebar, slashCommandHelp } from './shared'
import { slashCommands } from './types'

function slashCommandHelpContent(value: string): string {
  const query = value.trim()
  const matches = slashCommands.filter((item) => {
    if (query === '/') return true
    const base = item.command.split(' ')[0]
    return base.startsWith(query) || query.startsWith(base)
  })
  const visible = matches.length > 0 ? matches : slashCommands
  return visible.map((item) => `${item.command.padEnd(14)} ${item.description}`).join('\n')
}

export function updateSlashCommandHelp() {
  const value = input.plainText
  const shouldShow = value.startsWith('/') && !value.includes('\n')
  const help = S.slashCommandHelpInstance ?? slashCommandHelp
  help.visible = shouldShow
  if (shouldShow) {
    const content = slashCommandHelpContent(value)
    slashCommandHelpText.content = content
    help.height = content.split('\n').length + 4
  } else {
    help.height = 0
  }
  ;(S.conversationBoxInstance ?? conversationBox)?.requestRender?.()
  renderer.requestRender()
}

function handleSubmit() {
  const value = input.plainText
  log('SUBMIT pressed, value length:', value.length)
  if (value.trim() && !activeAgent()?.isBusy) {
    input.setText('')
    updateSlashCommandHelp()
    if (handleSlashCommand(value.trim())) return
    sendMessage(value)
  } else {
    log('SUBMIT ignored', { trimmed: !!value.trim(), busy: activeAgent()?.isBusy })
  }
}

export function handleSlashCommand(value: string): boolean {
  if (value === '/clear') {
    const clearedId = clearActiveConversation()
    if (!clearedId) return true
    clearConversationBlocks()
    updateConversation()
    updateBoxTitle()
    updateTabs()
    const prev = input.placeholder
    input.placeholder = 'Conversation cleared'
    setTimeout(() => { input.placeholder = prev }, 1500)
    return true
  }
  if (value === '/reset') {
    const resetId = resetActiveAgentToBoilerplate()
    if (!resetId) return true
    updateConversation()
    updateBoxTitle()
    updateTabs()
    const prev = input.placeholder
    input.placeholder = 'Agent reset to boilerplate'
    setTimeout(() => { input.placeholder = prev }, 1500)
    return true
  }
  if (value === '/debug') {
    const a = activeAgent()
    const lines = [
      '=== Conversation ===',
      ...(a?.messages.map(m => `${m.role}: ${m.content}${m.reasoning ? `\nreasoning: ${m.reasoning}` : ''}`) ?? []),
      '',
      '=== Activity ===',
      ...(a?.diffLines ?? []),
    ]
    if (copyTextToClipboard(lines.join('\n'))) showCopiedToast()
    return true
  }
  if (value === '/thought' || value === '/t') {
    toggleLatestThought()
    return true
  }
  if (value.startsWith('/thought ') || value.startsWith('/t ')) {
    const parts = value.split(' ')
    const idx = parseInt(parts[1], 10)
    if (!isNaN(idx)) toggleLatestThought(idx)
    return true
  }
  if(value.startsWith('/rename')) {
    const parts = value.split(' ')
    const newName = parts.slice(1).join(" ")
    if (newName) renameActiveAgent(newName)
    return true
  }
  return false
}

function copySelection(selection?: any) {
  const sel = selection ?? renderer.getSelection()
  const text = sel?.getSelectedText()
  if (!text || text.trim().length === 0) return
  if (copyTextToClipboard(text)) showCopiedToast()
}

// ── Keyboard / Selection Bindings ─────────────────────
export function bindKeyboard() {
  try {
    // @ts-expect-error
    renderer.keyInput.on("keypress", (event: any) => { 
      if (event.ctrl && event.shift && event.name === "c") {
        event.preventDefault()
        copySelection()
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
      const typedChar = event.sequence && event.sequence.length === 1 ? event.sequence : null
      if (
        renderer.currentFocusedRenderable !== input
        && typedChar
        && !event.ctrl
        && !event.meta
      ) {
        event.preventDefault()
        input.focus()
        input.insertText(typedChar)
        updateSlashCommandHelp()
      }
    })
  } catch (e) {
    log('keypress handler registration failed', String(e))
  }

  try {
    renderer.on('selection', (selection: any) => {
      copySelection(selection)
    })
  } catch (e) {
    log('selection handler registration failed', String(e))
  }
}

// ── Init ───────────────────────────────────────────────
export function initInputHandlers() {
  input.onSubmit = handleSubmit
  input.onContentChange = updateSlashCommandHelp
}
