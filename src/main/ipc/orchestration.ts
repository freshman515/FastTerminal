import { ipcMain } from 'electron'
import { execFile } from 'node:child_process'
import { access, mkdir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { IPC } from '@shared/types'
import type {
  OrchestrationCreateWorktreeRequest,
  OrchestrationCreateWorktreeResult,
} from '@shared/types'

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 15_000
const WORKTREE_TIMEOUT_MS = 30_000
const MAX_UNIQUE_ATTEMPTS = 50

function shortId(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || Date.now().toString(36)
}

function sanitizeSlug(value: string | undefined, fallback: string): string {
  const raw = (value ?? fallback).trim().toLowerCase()
  const slug = raw
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/\.\.+/g, '.')
    .slice(0, 40)
  return slug || 'agent'
}

function fallbackResult(
  request: OrchestrationCreateWorktreeRequest,
  error: unknown,
  branch: string | null = null,
): OrchestrationCreateWorktreeResult {
  const cwd = request.cwd ? resolve(request.cwd) : ''
  return {
    ok: false,
    cwd,
    path: cwd,
    branch,
    fallback: true,
    error: error instanceof Error ? error.message : String(error),
  }
}

async function git(args: string[], cwd: string, timeout = GIT_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  })
  return stdout.trim()
}

async function getCurrentBranch(repoRoot: string): Promise<string | null> {
  try {
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot)
    return branch || null
  } catch {
    return null
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot)
    return true
  } catch {
    return false
  }
}

async function createUniqueTarget(
  repoRoot: string,
  request: OrchestrationCreateWorktreeRequest,
): Promise<{ path: string; branch: string }> {
  const repoName = sanitizeSlug(basename(repoRoot), 'repo')
  const slug = sanitizeSlug(request.slug, request.workerId)
  const run = shortId(request.runId)
  const worker = shortId(request.workerId)
  const pathBase = `${repoName}-fastterminal-${slug}-${run}-${worker}`
  const branchBase = `fastterminal/${slug}-${run}`

  for (let index = 0; index < MAX_UNIQUE_ATTEMPTS; index += 1) {
    const suffix = index === 0 ? '' : `-${index + 1}`
    const path = join(dirname(repoRoot), `${pathBase}${suffix}`)
    const branch = `${branchBase}${suffix}`
    const [targetExists, targetBranchExists] = await Promise.all([
      pathExists(path),
      branchExists(repoRoot, branch),
    ])
    if (!targetExists && !targetBranchExists) {
      return { path, branch }
    }
  }

  const fallback = Date.now().toString(36)
  return {
    path: join(dirname(repoRoot), `${pathBase}-${fallback}`),
    branch: `${branchBase}-${fallback}`,
  }
}

async function createWorktree(
  request: OrchestrationCreateWorktreeRequest,
): Promise<OrchestrationCreateWorktreeResult> {
  if (!request.cwd.trim()) {
    return fallbackResult(request, new Error('No working directory was provided.'))
  }

  let fallbackBranch: string | null = null

  try {
    const inputCwd = resolve(request.cwd)
    const repoRoot = await git(['rev-parse', '--show-toplevel'], inputCwd)
    fallbackBranch = await getCurrentBranch(repoRoot)
    const target = await createUniqueTarget(repoRoot, request)

    await mkdir(dirname(target.path), { recursive: true })
    await git(['worktree', 'add', '-b', target.branch, target.path, 'HEAD'], repoRoot, WORKTREE_TIMEOUT_MS)

    return {
      ok: true,
      cwd: target.path,
      path: target.path,
      branch: target.branch,
      fallback: false,
    }
  } catch (error) {
    return fallbackResult(request, error, fallbackBranch)
  }
}

export function registerOrchestrationHandlers(): void {
  ipcMain.handle(
    IPC.ORCHESTRATION_CREATE_WORKTREE,
    async (_event, request: OrchestrationCreateWorktreeRequest) => createWorktree(request),
  )
}
