import { runGit, type GitCommandResult } from './git-activity'

export async function commitAllChanges(cwd: string, name: string, body: string): Promise<GitCommandResult> {
  const addResult = await runGit(cwd, ['add', '-A'])
  if (addResult.exitCode !== 0) return addResult

  const commitArgs = ['commit', '-m', name]
  if (body) commitArgs.push('-m', body)
  return runGit(cwd, commitArgs)
}

export function pushChanges(cwd: string): Promise<GitCommandResult> {
  return runGit(cwd, ['push'])
}
