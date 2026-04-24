import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { readConfig } from './ConfigStore'

interface McpConfigOptions {
  port: number
  token: string
  sessionId: string
}

function getMcpDir(): string {
  return join(app.getPath('userData'), 'mcp')
}

function getSourceBridgeCandidates(): string[] {
  return [
    join(process.cwd(), 'src', 'main', 'services', 'mcp-bridge.cjs'),
    join(__dirname, 'mcp-bridge.cjs'),
    join(process.resourcesPath, 'mcp', 'fastterminal-mcp-bridge.cjs'),
    join(process.resourcesPath, 'app.asar', 'src', 'main', 'services', 'mcp-bridge.cjs'),
  ]
}

function readBridgeSource(): string | null {
  for (const candidate of getSourceBridgeCandidates()) {
    try {
      if (existsSync(candidate)) return readFileSync(candidate, 'utf-8')
    } catch {
      // next candidate
    }
  }
  return null
}

/** Copy mcp-bridge.cjs into userData so external agents (Claude / Codex)
 *  can point to a stable absolute path that survives dev↔prod swaps. */
function ensureBridgeScript(): string | null {
  const source = readBridgeSource()
  if (!source) {
    console.warn('[FastTerminalMcp] mcp-bridge.cjs not found')
    return null
  }
  const target = join(getMcpDir(), 'fastterminal-mcp-bridge.cjs')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, source, 'utf-8')
  return target
}

function normalizeClaudeProjectPath(projectPath: string): string {
  return projectPath.replace(/\\/g, '/').replace(/\/+$/, '')
}

function getClaudeJsonPath(): string {
  return join(homedir(), '.claude.json')
}

function readClaudeJson(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(getClaudeJsonPath(), 'utf-8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function writeClaudeJson(data: Record<string, unknown>): void {
  const path = getClaudeJsonPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf-8')
}

/** Per-session --mcp-config JSON that Claude Code consumes when spawned by
 *  FastTerminal. Includes the session id so the bridge can flag self. */
export function createFastTerminalMcpConfig(options: McpConfigOptions): string | null {
  const bridgePath = ensureBridgeScript()
  if (!bridgePath) return null

  const configPath = join(getMcpDir(), `fastterminal-mcp-${options.sessionId}.json`)
  const config = {
    mcpServers: {
      fastterminal: {
        command: 'node',
        args: [bridgePath],
        env: {
          FASTTERMINAL_IDE_PORT: String(options.port),
          FASTTERMINAL_MCP_TOKEN: options.token,
          FASTTERMINAL_SESSION_ID: options.sessionId,
        },
      },
    },
  }

  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
  return configPath
}

/** Register the bridge globally in ~/.claude.json so the user doesn't have
 *  to run `claude mcp add`. We attach to every project path we know about
 *  (minimal since FastTerminal is projectless — still includes homedir for
 *  anonymous sessions). */
export function registerFastTerminalMcpInClaudeProjects(
  options: Pick<McpConfigOptions, 'port' | 'token'>,
): void {
  const bridgePath = ensureBridgeScript()
  if (!bridgePath) return

  const server = {
    type: 'stdio',
    command: 'node',
    args: [bridgePath],
    env: {
      FASTTERMINAL_IDE_PORT: String(options.port),
      FASTTERMINAL_MCP_TOKEN: options.token,
    },
  }

  const config = readConfig()
  const projectPaths = [
    ...(Array.isArray(config.projects) ? config.projects : [])
      .flatMap((p) => {
        if (!p || typeof p !== 'object') return []
        const path = (p as Record<string, unknown>).path
        return typeof path === 'string' ? [path] : []
      }),
    ...(Array.isArray(config.worktrees) ? config.worktrees : [])
      .flatMap((w) => {
        if (!w || typeof w !== 'object') return []
        const path = (w as Record<string, unknown>).path
        return typeof path === 'string' ? [path] : []
      }),
    homedir(), // fallback: anonymous sessions run from home
  ]

  const unique = [...new Set(projectPaths.map(normalizeClaudeProjectPath).filter(Boolean))]
  if (unique.length === 0) return

  const claudeJson = readClaudeJson()
  const projects = claudeJson.projects && typeof claudeJson.projects === 'object' && !Array.isArray(claudeJson.projects)
    ? claudeJson.projects as Record<string, unknown>
    : {}
  claudeJson.projects = projects

  for (const projectPath of unique) {
    const entry = projects[projectPath] && typeof projects[projectPath] === 'object' && !Array.isArray(projects[projectPath])
      ? projects[projectPath] as Record<string, unknown>
      : {}
    const mcpServers = entry.mcpServers && typeof entry.mcpServers === 'object' && !Array.isArray(entry.mcpServers)
      ? entry.mcpServers as Record<string, unknown>
      : {}
    mcpServers.fastterminal = server
    entry.mcpServers = mcpServers
    projects[projectPath] = entry
  }

  writeClaudeJson(claudeJson)
}

// ─── Codex CLI (~/.codex/config.toml) ──────────────────────────────────────

function getCodexConfigPath(): string {
  return join(homedir(), '.codex', 'config.toml')
}

function readCodexConfig(): string {
  try {
    return readFileSync(getCodexConfigPath(), 'utf-8')
  } catch {
    return ''
  }
}

function writeCodexConfig(content: string): void {
  const path = getCodexConfigPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf-8')
}

function upsertTomlSection(source: string, header: string, replacement: string): string {
  const lines = source.length ? source.split(/\r?\n/) : []
  const headerLine = `[${header}]`
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === headerLine) { start = i; break }
  }

  const replacementLines = replacement.replace(/\r\n/g, '\n').split('\n')
  if (start === -1) {
    const base = lines.length === 0 ? [] : lines[lines.length - 1] === '' ? lines : [...lines, '']
    return [...base, ...replacementLines, ''].join('\n')
  }

  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim()
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) { end = i; break }
  }
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1
  return [...lines.slice(0, start), ...replacementLines, '', ...lines.slice(end)].join('\n')
}

function removeTomlSection(source: string, header: string): string {
  const lines = source.length ? source.split(/\r?\n/) : []
  const headerLine = `[${header}]`
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === headerLine) { start = i; break }
  }
  if (start === -1) return source
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim()
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) { end = i; break }
  }
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n')
}

function tomlLiteralString(value: string): string {
  if (!value.includes("'")) return `'${value}'`
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

// ─── Sync ~/.claude/CLAUDE.md "Meta-Agent" section into ~/.codex/AGENTS.md ───
//
// Keep the fa_*/ft_* toolset explanation identical for both Claude and Codex
// without forcing the user to maintain two files. CLAUDE.md is the source of
// truth; AGENTS.md receives the section inside a managed block. Other parts
// of AGENTS.md (Git rules, etc.) stay untouched.

const MANAGED_BEGIN = '<!-- BEGIN: Meta-Agent MCP (auto-synced from ~/.claude/CLAUDE.md — do not edit by hand) -->'
const MANAGED_END = '<!-- END: Meta-Agent MCP -->'

function extractMetaAgentSection(claudeMd: string): string | null {
  const lines = claudeMd.split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('## Meta-Agent')) { start = i; break }
  }
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) { end = i; break }
  }
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1
  return lines.slice(start, end).join('\n')
}

function removeHeadingSection(target: string, headingPrefix: string): string {
  const lines = target.split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith(headingPrefix)) { start = i; break }
  }
  if (start === -1) return target
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) { end = i; break }
  }
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n')
}

function removeManagedBlock(target: string): string {
  const beginIdx = target.indexOf(MANAGED_BEGIN)
  const endIdx = target.indexOf(MANAGED_END)
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) return target
  let cut = endIdx + MANAGED_END.length
  if (target[cut] === '\n') cut += 1
  return target.slice(0, beginIdx).replace(/\n+$/, '\n') + target.slice(cut)
}

function appendManagedBlock(target: string, block: string): string {
  const managed = `${MANAGED_BEGIN}\n${block}\n${MANAGED_END}`
  const normalized = target.length === 0 ? '' : target.replace(/\n+$/, '') + '\n\n'
  return `${normalized}${managed}\n`
}

export function syncMetaAgentToCodexAgentsMd(): void {
  const claudeMdPath = join(homedir(), '.claude', 'CLAUDE.md')
  let claudeMd: string
  try {
    claudeMd = readFileSync(claudeMdPath, 'utf-8')
  } catch {
    return
  }

  const block = extractMetaAgentSection(claudeMd)
  if (!block) return

  const agentsMdPath = join(homedir(), '.codex', 'AGENTS.md')
  let agentsMd = ''
  try {
    agentsMd = readFileSync(agentsMdPath, 'utf-8')
  } catch {
    // create below
  }

  // Three-step idempotent rewrite (see FastAgentsMcpService for rationale).
  const step1 = removeManagedBlock(agentsMd)
  const step2 = removeHeadingSection(step1, '## Meta-Agent')
  const updated = appendManagedBlock(step2, block)

  if (updated !== agentsMd) {
    try {
      mkdirSync(dirname(agentsMdPath), { recursive: true })
      writeFileSync(agentsMdPath, updated, 'utf-8')
    } catch (err) {
      console.warn('[FastTerminalMcp] failed to sync ~/.codex/AGENTS.md:', err)
    }
  }
}

export function registerFastTerminalMcpInCodex(options: Pick<McpConfigOptions, 'port' | 'token'>): void {
  const bridgePath = ensureBridgeScript()
  if (!bridgePath) return

  // Baseline PORT/TOKEN live in config.toml. SESSION_ID is per-session and
  // is injected at PTY spawn time via `codex -c mcp_servers.fastterminal.env.
  // FASTTERMINAL_SESSION_ID="..."` — see PtyManager. A global config is
  // shared by every Codex instance, so only a CLI override can carry a
  // different value per Codex tab. Codex 0.121 spawns MCP servers with a
  // sealed env (no parent inheritance), so this clause is required.
  const section = [
    '[mcp_servers.fastterminal]',
    'command = "node"',
    `args = [${tomlLiteralString(bridgePath)}]`,
    `env = { FASTTERMINAL_IDE_PORT = "${options.port}", FASTTERMINAL_MCP_TOKEN = "${options.token}" }`,
  ].join('\n')

  const original = readCodexConfig()
  const cleaned = removeTomlSection(original, 'mcp_servers.fastterminal.env')
  const updated = upsertTomlSection(cleaned, 'mcp_servers.fastterminal', section)
  if (updated !== original) {
    try {
      writeCodexConfig(updated)
    } catch (err) {
      console.warn('[FastTerminalMcp] failed to update ~/.codex/config.toml:', err)
    }
  }
}
