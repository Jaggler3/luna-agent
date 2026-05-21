function commonIndentPrefix(a: string, b: string): string {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return a.slice(0, i)
}

export function dedentUnifiedDiffForDisplay(diff: string): string {
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
