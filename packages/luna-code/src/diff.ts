export function generateDiff(path: string, oldContent: string, newContent: string): string {
  const oldLines = oldContent ? oldContent.split(/\r?\n/) : []
  const newLines = newContent ? newContent.split(/\r?\n/) : []

  const m = oldLines.length
  const n = newLines.length

  if (m > 1000 || n > 1000) {
    return `--- a/${path}\n+++ b/${path}\n@@ -1,${m} +1,${n} @@\n[File too large to diff - showing replacement]\n- ${oldLines.slice(0, 5).join('\n- ')}\n...\n+ ${newLines.slice(0, 5).join('\n+ ')}\n...`
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => Array.from(new Int32Array(n + 1))) as number[][]
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  interface DiffItem {
    type: 'added' | 'removed' | 'unchanged'
    value: string
    oldLineNum: number
    newLineNum: number
  }

  const diffItems: DiffItem[] = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diffItems.unshift({ type: 'unchanged', value: oldLines[i - 1], oldLineNum: i, newLineNum: j })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diffItems.unshift({ type: 'added', value: newLines[j - 1], oldLineNum: -1, newLineNum: j })
      j--
    } else {
      diffItems.unshift({ type: 'removed', value: oldLines[i - 1], oldLineNum: i, newLineNum: -1 })
      i--
    }
  }

  const contextSize = 3
  const hunks: string[] = []
  let currentHunk: DiffItem[] = []

  for (let k = 0; k < diffItems.length; k++) {
    const item = diffItems[k]
    if (item.type !== 'unchanged') {
      const startIdx = Math.max(0, k - contextSize)
      if (currentHunk.length > 0) {
        const lastItemIdx = diffItems.indexOf(currentHunk[currentHunk.length - 1])
        if (startIdx <= lastItemIdx) {
          for (let idx = lastItemIdx + 1; idx <= k; idx++) currentHunk.push(diffItems[idx])
          continue
        } else {
          hunks.push(formatHunk(currentHunk))
          currentHunk = []
        }
      }
      for (let idx = startIdx; idx <= k; idx++) currentHunk.push(diffItems[idx])
    } else if (currentHunk.length > 0) {
      const lastChangeIdx = findLastChangeIdx(diffItems, currentHunk)
      const currentIdxInDiff = k
      if (currentIdxInDiff - lastChangeIdx <= contextSize) {
        currentHunk.push(item)
      } else {
        hunks.push(formatHunk(currentHunk))
        currentHunk = []
      }
    }
  }

  if (currentHunk.length > 0) hunks.push(formatHunk(currentHunk))
  if (hunks.length === 0) return ''

  return `--- a/${path}\n+++ b/${path}\n${hunks.join('\n')}`
}

function findLastChangeIdx(diffItems: any[], hunk: any[]): number {
  for (let i = hunk.length - 1; i >= 0; i--) {
    if (hunk[i].type !== 'unchanged') return diffItems.indexOf(hunk[i])
  }
  return 0
}

function formatHunk(hunk: any[]): string {
  const oldStart = hunk.find(h => h.oldLineNum !== -1)?.oldLineNum ?? 0
  const newStart = hunk.find(h => h.newLineNum !== -1)?.newLineNum ?? 0
  const oldLen = hunk.filter(h => h.type !== 'added').length
  const newLen = hunk.filter(h => h.type !== 'removed').length
  const lines = hunk.map(h => {
    if (h.type === 'added') return `+${h.value}`
    if (h.type === 'removed') return `-${h.value}`
    return ` ${h.value}`
  })
  return `@@ -${oldStart},${oldLen} +${newStart},${newLen} @@\n${lines.join('\n')}`
}
