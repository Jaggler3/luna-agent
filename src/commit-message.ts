export type CommitDraft = { title: string; body: string }

type CommitMessageDraft = {
  type: string
  scope?: string | null
  description: string
  body?: string | null
}

type GitDiffSection = {
  label: string
  diff: string
}

export type CommitSnapshot = {
  changes: Array<{
    path: string
    status: string
    sections: GitDiffSection[]
  }>
}

type GenerateCommitDraftOptions = {
  log?: (...args: unknown[]) => void
}

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434'
const COMMIT_MODEL = process.env.LUNA_MODEL ?? 'gpt-oss:120b-cloud'

export async function generateCommitDraft(
  snapshot: CommitSnapshot,
  options: GenerateCommitDraftOptions = {},
): Promise<CommitDraft> {
  const generated = await generateCommitMessageWithOllama(snapshot).catch((err) => {
    options.log?.('ollama commit generation failed', String(err))
    return null
  })

  return generated ?? summarizeCommitFromSnapshot(snapshot)
}

function summarizeCommitFromSnapshot(snapshot: CommitSnapshot): CommitDraft {
  const allDiffs = snapshot.changes.flatMap((change) => change.sections.map((section) => section.diff))
  const diffText = allDiffs.join('\n')
  const diffTextLower = diffText.toLowerCase()

  let additions = 0
  let deletions = 0
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) additions++
    if (line.startsWith('-')) deletions++
  }

  const pathText = snapshot.changes.map((change) => change.path.toLowerCase()).join('\n')
  const lines = snapshot.changes.map((change) => `- ${change.path}`).slice(0, 5)
  if (snapshot.changes.length > 5) {
    lines.push(`- ...and ${snapshot.changes.length - 5} more files`)
  }

  const subject = inferCommitSubject(diffTextLower, pathText)
  const type = inferCommitType(snapshot, additions, deletions, diffTextLower)
  const scope = inferCommitScope(snapshot)
  const title = formatConventionalCommit({
    type,
    scope,
    description: subject,
  })
  const bodyParts = [
    `Files changed: ${snapshot.changes.length}`,
    `Insertions: ${additions}`,
    `Deletions: ${deletions}`,
    '',
    ...lines,
  ]
  return { title, body: bodyParts.join('\n') }
}

function inferCommitType(snapshot: CommitSnapshot, additions: number, deletions: number, diffTextLower: string): string {
  const paths = snapshot.changes.map((change) => change.path.toLowerCase())
  const hasTests = paths.some((path) => path.includes('test') || path.includes('spec'))
  const hasDocs = paths.some((path) => path.includes('readme') || path.includes('docs'))
  const hasConfig = paths.some((path) => path.includes('package.json') || path.includes('tsconfig') || path.includes('.json'))
  const hasUi = paths.some((path) => path.includes('src/ui.ts') || path.includes('ui') || path.includes('activity') || path.includes('conversation'))

  if (hasTests) return 'test'
  if (hasDocs) return 'docs'
  if (hasConfig) return 'chore'
  if (diffTextLower.includes('fix') || diffTextLower.includes('bug') || diffTextLower.includes('error')) return 'fix'
  if (additions > 0 && deletions === 0 && !hasUi) return 'feat'
  if (deletions > 0 && additions === 0) return 'refactor'
  if (hasUi || snapshot.changes.length > 3) return 'feat'
  return 'refactor'
}

function inferCommitScope(snapshot: CommitSnapshot): string | null {
  const paths = snapshot.changes.map((change) => change.path.toLowerCase())
  if (paths.some((path) => path.includes('src/ui.ts'))) return 'ui'
  if (paths.some((path) => path.includes('src/daemon.ts'))) return 'daemon'
  if (paths.some((path) => path.includes('src/store.ts'))) return 'store'
  if (paths.some((path) => path.includes('packages/luna-code'))) return 'code'
  if (paths.some((path) => path.includes('packages/luna-gateway'))) return 'gateway'

  const firstPath = snapshot.changes[0]?.path ?? ''
  const topLevel = firstPath.split('/')[0]
  if (!topLevel || topLevel === firstPath) return null
  return topLevel.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()
}

function formatConventionalCommit(draft: CommitMessageDraft): string {
  const type = draft.type.trim().toLowerCase()
  const scope = draft.scope?.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') ?? ''
  const description = draft.description.trim().replace(/[.]+$/, '').replace(/\s+/g, ' ')
  return `${type}${scope ? `(${scope})` : ''}: ${description}`
}

function buildCommitPrompt(snapshot: CommitSnapshot): string {
  const sections: string[] = []
  for (const change of snapshot.changes) {
    sections.push(`FILE: ${change.path}`)
    sections.push(`STATUS: ${change.status}`)
    for (const section of change.sections) {
      sections.push(`SECTION: ${section.label}`)
      sections.push(section.diff.slice(0, 2500))
    }
    sections.push('')
  }
  return sections.join('\n')
}

async function generateCommitMessageWithOllama(snapshot: CommitSnapshot): Promise<CommitDraft> {
  const response = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: COMMIT_MODEL,
      temperature: 0.2,
      stream: false,
      messages: [
        {
          role: 'system',
          content: [
            'You write conventional commit messages for code changes.',
            'Return JSON only with this shape:',
            '{"type":"feat|fix|refactor|docs|test|chore|build|ci|perf|style","scope":"string|null","description":"string","body":"string|null"}',
            'Rules:',
            '- type must be lowercase.',
            '- description must be imperative, concise, and without a trailing period.',
            '- Use conventional commit semantics for the type.',
            '- Include a scope when there is an obvious area, such as ui, store, daemon, code, or gateway.',
            '- body should be 1 to 4 short bullet points or null.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: `Generate a conventional commit message from this diff:\n\n${buildCommitPrompt(snapshot)}`,
        },
      ],
    }),
  })

  if (!response.ok) {
    throw new Error(`ollama error (${response.status}): ${await response.text()}`)
  }

  const data = await response.json() as {
    choices?: { message?: { content?: string | null } }[]
  }
  const raw = data.choices?.[0]?.message?.content?.trim()
  if (!raw) {
    throw new Error('ollama returned no content')
  }

  const parsed = parseCommitMessageDraft(raw)
  return {
    title: formatConventionalCommit(parsed),
    body: parsed.body?.trim() || summarizeCommitFromSnapshot(snapshot).body,
  }
}

function parseCommitMessageDraft(raw: string): CommitMessageDraft {
  const jsonText = extractJsonObject(raw)
  const parsed = JSON.parse(jsonText) as Partial<CommitMessageDraft>
  const type = typeof parsed.type === 'string' && parsed.type.trim() ? parsed.type : 'feat'
  const description = typeof parsed.description === 'string' && parsed.description.trim()
    ? parsed.description
    : 'update changes'
  const scope = typeof parsed.scope === 'string' ? parsed.scope : null
  const body = typeof parsed.body === 'string' ? parsed.body : null
  return { type, scope, description, body }
}

function extractJsonObject(raw: string): string {
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first === -1 || last === -1 || last <= first) {
    throw new Error(`invalid json: ${raw}`)
  }
  return raw.slice(first, last + 1)
}

function inferCommitSubject(diffTextLower: string, pathText: string): string {
  const candidates: Array<[RegExp, string]> = [
    [/\bcommit\b.*\bpush\b/, 'commit controls'],
    [/\bgit\b.*\bdiff\b/, 'diff view'],
    [/\bactivity\b.*\bfooter\b/, 'activity footer'],
    [/\bbutton\b.*\binput\b/, 'form controls'],
    [/\btextarea\b/, 'body field'],
    [/\binput\b/, 'name field'],
    [/\bscroll\b/, 'scroll behavior'],
    [/\blayout\b/, 'layout'],
    [/\btest\b/, 'tests'],
  ]

  for (const [pattern, subject] of candidates) {
    if (pattern.test(diffTextLower) || pattern.test(pathText)) return subject
  }

  const preferredPaths = pathText
    .split('\n')
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => path.replace(/^.*\//, '').replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '))
    .slice(0, 2)

  if (preferredPaths.length === 1) return preferredPaths[0]
  if (preferredPaths.length > 1) return preferredPaths.join(' and ')
  return 'changes'
}
