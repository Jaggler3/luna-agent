import { spawn } from 'node:child_process'
import { pathToFiletype } from '@opentui/core'

export type GitDiffSection = {
  label: string
  diff: string
  filetype: string
}

export type GitFileChange = {
  key: string
  path: string
  status: string
  sections: GitDiffSection[]
}

export type GitActivitySnapshot = {
  insideRepo: boolean
  branchLabel: string | null
  changes: GitFileChange[]
}

export type GitCommandResult = {
  exitCode: number | null
  stdout: string
  stderr: string
}

export function runGit(cwd: string, args: string[]): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', cwd, ...args], {
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

async function getGitBranchLabel(cwd: string): Promise<string | null> {
  const [branchResult, headResult] = await Promise.all([
    runGit(cwd, ['branch', '--show-current']),
    runGit(cwd, ['rev-parse', '--short', 'HEAD']),
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

async function buildGitFileDiffSections(cwd: string, path: string, status: string): Promise<GitDiffSection[]> {
  const sections: GitDiffSection[] = []
  const filetype = pathToFiletype(path) ?? 'text'
  const staged = status[0] && status[0] !== ' ' && status[0] !== '?'
  const unstaged = status[1] && status[1] !== ' '
  const untracked = status === '??'

  if (staged) {
    const stagedDiff = await runGit(cwd, ['diff', '--cached', '--no-color', '--', path])
    if (stagedDiff.stdout) sections.push({ label: 'staged', diff: stagedDiff.stdout, filetype })
  }
  if (untracked) {
    const added = await runGit(cwd, ['diff', '--no-index', '--no-color', '--', '/dev/null', path])
    if (added.stdout) sections.push({ label: 'untracked', diff: added.stdout, filetype })
  } else if (unstaged) {
    const workingDiff = await runGit(cwd, ['diff', '--no-color', '--', path])
    if (workingDiff.stdout) sections.push({ label: 'working tree', diff: workingDiff.stdout, filetype })
  }

  return sections
}

export async function collectGitActivity(cwd: string): Promise<GitActivitySnapshot> {
  const [repoResult, statusResult] = await Promise.all([
    runGit(cwd, ['rev-parse', '--is-inside-work-tree']),
    runGit(cwd, ['status', '--porcelain=v1', '--no-renames', '-uall', '-z']),
  ])

  if (!isGitRepo(repoResult)) {
    return { insideRepo: false, branchLabel: null, changes: [] }
  }

  const changes = parseGitStatus(statusResult.stdout)
  const branchLabel = await getGitBranchLabel(cwd)

  if (changes.length === 0) {
    return { insideRepo: true, branchLabel, changes: [] }
  }

  const nextChanges = await Promise.all(
    changes.map(async (change) => ({
      ...change,
      sections: await buildGitFileDiffSections(cwd, change.path, change.status),
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

export function activityViewFingerprint(snapshot: GitActivitySnapshot, expandedKeys: string): string {
  return `${snapshotFingerprint(snapshot)}\x03${expandedKeys}`
}
