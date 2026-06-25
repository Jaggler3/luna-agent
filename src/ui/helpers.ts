export function makeDebouncedUpdate(fn: () => void, delay = 50) {
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

export function convertBracketSyntax(text: string): string {
  return text
    .replace(/\(\(([^)]+)\)\)/g, '**$1**')
    .replace(/\[\[([^\]]+)\]\]/g, '`$1`')
    .replace(/\{\{([^}]+)\}\}/g, '*$1*')
}

import { Box } from "@opentui/core"
import type { ProxiedVNode } from "@opentui/core"

export function box(config: Record<string, unknown>, ...children: unknown[]): ProxiedVNode<any> {
  return Box(config as any, ...children) as any
}

export function makeRenderableId(prefix: string, key: string): string {
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  }
  const safeKey = key
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `${prefix}-${safeKey || 'item'}-${hash.toString(36)}`
}
