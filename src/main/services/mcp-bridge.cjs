#!/usr/bin/env node
// FastTerminal MCP bridge — runs as a child process under any MCP-capable
// agent (Claude Code, etc.). Exposes a small "Meta-Agent" toolset that lets
// the agent inspect, drive, and spawn other FastTerminal sessions.
//
// All tools proxy to the OrchestratorService HTTP server in the FastTerminal
// main process. Auth uses a per-launch random Bearer token.
//
// Required env (injected by FastTerminal when it spawns the PTY):
//   FASTTERMINAL_IDE_PORT   – orchestrator HTTP port (loopback)
//   FASTTERMINAL_MCP_TOKEN  – random per-launch Bearer token
// Optional:
//   FASTTERMINAL_SESSION_ID – this agent's own session id (used to flag
//                             `is_self` so the agent doesn't accidentally
//                             drive itself).

const http = require('http')
const readline = require('readline')

const PORT = parseInt(process.env.FASTTERMINAL_IDE_PORT || '0', 10)
const TOKEN = process.env.FASTTERMINAL_MCP_TOKEN || ''
const SELF_SESSION_ID = process.env.FASTTERMINAL_SESSION_ID || ''
const CONNECTED = Boolean(PORT && TOKEN)

// If the bridge is spawned outside a FastTerminal PTY (no orchestrator env),
// we still speak MCP — we just advertise zero tools. This keeps
// `claude mcp list` health checks green even when the user configures the
// bridge globally and then opens a plain shell. Inside FastTerminal, the
// env vars are present and the full toolset activates.

// ─── HTTP helper ────────────────────────────────────────────────────────────

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null
    const headers = {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json',
    }
    if (SELF_SESSION_ID) {
      headers['X-FastTerminal-Session-Id'] = SELF_SESSION_ID
    }
    if (payload) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(payload)
    }
    const req = http.request(
      { host: '127.0.0.1', port: PORT, method, path, headers },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          try {
            const parsed = data ? JSON.parse(data) : {}
            if (res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${parsed.error || data || 'unknown error'}`))
            } else {
              resolve(parsed)
            }
          } catch (err) {
            reject(new Error(`Bad JSON from FastTerminal: ${err.message}`))
          }
        })
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

// ─── Tool definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'ft_list_sessions',
    description:
      'List every FastTerminal session currently in the workspace, including its id, name, type, status, working directory, pane, and whether the calling agent owns it. Use this first whenever you need to find a session to read or write to.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'ft_read_session',
    description:
      'Read recent terminal output from a FastTerminal session. ANSI escape sequences are stripped. Use this to inspect what another session (or worker agent) has produced.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Renderer session id, exactly as returned by ft_list_sessions.',
        },
        lines: {
          type: 'integer',
          description: 'How many trailing lines to return (default 200, min 1, max 2000).',
          minimum: 1,
          maximum: 2000,
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'ft_write_session',
    description:
      'Send input to a FastTerminal session as if the user typed it. By default a trailing Enter is appended. Use this to dispatch a prompt to a worker agent or run a shell command in another terminal. Refuses to operate on the calling agent\'s own session.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        input: {
          type: 'string',
          description: 'Text to send. Up to 16 KiB.',
        },
        press_enter: {
          type: 'boolean',
          description: 'If true (default), appends a carriage return.',
        },
      },
      required: ['session_id', 'input'],
    },
  },
  {
    name: 'ft_create_session',
    description:
      'Create a new FastTerminal session in the active pane. Use this to spawn a worker agent (claude-code / codex / opencode) or a plain terminal for a follow-up task.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['terminal', 'claude-code', 'claude-code-yolo', 'codex', 'codex-yolo', 'opencode'],
          description: 'Session type. "terminal" = plain shell.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory (absolute path). Optional — falls back to the active project / home dir.',
        },
        project_id: {
          type: 'string',
          description: 'Optional FastTerminal project id to attach the session to.',
        },
        worktree_id: {
          type: 'string',
          description: 'Optional FastTerminal worktree id (overrides cwd resolution).',
        },
        name: {
          type: 'string',
          description: 'Display name for the new tab.',
        },
        initial_input: {
          type: 'string',
          description: 'Optional first line to type into the new session once it boots.',
        },
      },
      required: ['type'],
    },
  },
  {
    name: 'ft_wait_for_idle',
    description:
      'Block until a FastTerminal session has produced no output for `idle_ms` milliseconds, or `timeout_ms` elapses. Use this as a synchronization point after dispatching work to a worker agent.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        idle_ms: {
          type: 'integer',
          description: 'Quiet period required (default 1500, min 200, max 60000).',
          minimum: 200,
          maximum: 60000,
        },
        timeout_ms: {
          type: 'integer',
          description: 'Maximum total wait (default 30000, max 300000).',
          minimum: 200,
          maximum: 300000,
        },
      },
      required: ['session_id'],
    },
  },
]

// ─── Tool dispatch ──────────────────────────────────────────────────────────

async function callTool(name, args) {
  switch (name) {
    case 'ft_list_sessions': {
      const data = await request('GET', '/ft/sessions')
      const sessions = Array.isArray(data.sessions) ? data.sessions : []
      if (sessions.length === 0) return 'No active sessions.'
      const lines = sessions.map((s) => {
        const tags = []
        if (s.isSelf) tags.push('SELF')
        if (!s.hasPty) tags.push('no-pty')
        const tagStr = tags.length ? ` [${tags.join(', ')}]` : ''
        return `- ${s.id} · ${s.name} · ${s.type} · ${s.status}${tagStr}\n    cwd: ${s.cwd || '(none)'}\n    pane: ${s.paneId || '(detached)'}`
      })
      return `${sessions.length} session(s):\n${lines.join('\n')}`
    }

    case 'ft_read_session': {
      const sessionId = String(args.session_id || '')
      if (!sessionId) throw new Error('session_id is required')
      const lines = args.lines ? `?lines=${encodeURIComponent(args.lines)}` : ''
      const data = await request('GET', `/ft/sessions/${encodeURIComponent(sessionId)}/output${lines}`)
      return typeof data.output === 'string' ? data.output : ''
    }

    case 'ft_write_session': {
      const sessionId = String(args.session_id || '')
      if (!sessionId) throw new Error('session_id is required')
      if (sessionId === SELF_SESSION_ID) {
        throw new Error('Refusing to write to the calling agent\'s own session.')
      }
      if (typeof args.input !== 'string' || !args.input) {
        throw new Error('input must be a non-empty string')
      }
      const body = { input: args.input }
      if (typeof args.press_enter === 'boolean') body.press_enter = args.press_enter
      const data = await request('POST', `/ft/sessions/${encodeURIComponent(sessionId)}/input`, body)
      return `Wrote ${data.bytesWritten ?? args.input.length} bytes to session ${sessionId}.`
    }

    case 'ft_create_session': {
      const body = {
        type: args.type,
        cwd: args.cwd || '',
        project_id: args.project_id,
        worktree_id: args.worktree_id,
        name: args.name,
        initial_input: args.initial_input,
      }
      const data = await request('POST', '/ft/sessions', body)
      if (!data.ok || !data.session_id) {
        throw new Error(data.error || 'create_session failed')
      }
      return `Created session ${data.session_id} (type=${args.type}).`
    }

    case 'ft_wait_for_idle': {
      const sessionId = String(args.session_id || '')
      if (!sessionId) throw new Error('session_id is required')
      const body = {}
      if (typeof args.idle_ms === 'number') body.idle_ms = args.idle_ms
      if (typeof args.timeout_ms === 'number') body.timeout_ms = args.timeout_ms
      const data = await request('POST', `/ft/sessions/${encodeURIComponent(sessionId)}/wait_idle`, body)
      return data.idle
        ? `Idle after ${data.waitedMs}ms (quiet ${data.quietMs}ms).`
        : `Timed out after ${data.waitedMs}ms (last output ${data.quietMs}ms ago).`
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// ─── MCP JSON-RPC framing ───────────────────────────────────────────────────

function send(obj) {
  // MCP stdio transport: newline-delimited JSON (one JSON-RPC message per line).
  const json = JSON.stringify(obj)
  process.stdout.write(json + '\n')
}

const DEBUG = process.env.FASTTERMINAL_MCP_DEBUG === '1'
function debug(...args) {
  if (DEBUG) {
    try { process.stderr.write(`[mcp-bridge] ${args.join(' ')}\n`) } catch { /* ignore */ }
  }
}

debug('boot', { connected: CONNECTED, port: PORT, pid: process.pid })

let buffer = ''
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (rawLine) => {
  // Strip Windows CRLF leftovers — readline keeps the trailing \r on some Windows shells.
  const line = rawLine.replace(/\r$/, '')
  // Skip LSP-style Content-Length headers and blank separator lines.
  if (line.startsWith('Content-Length:') || line === '') return
  buffer += line
  let msg
  try {
    msg = JSON.parse(buffer)
    buffer = ''
  } catch {
    // Incomplete JSON — keep buffering until the next line completes the frame.
    return
  }
  debug('recv', msg && msg.method, 'id=' + (msg && msg.id))
  handleMessage(msg).catch((err) => {
    send({
      jsonrpc: '2.0',
      id: msg && msg.id,
      error: { code: -32603, message: err && err.message ? err.message : String(err) },
    })
  })
})

async function handleMessage(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fastterminal-meta-agent', version: '1.0.0' },
      },
    })
    return
  }
  if (method === 'notifications/initialized') return
  if (method === 'tools/list') {
    // Always advertise the full toolset so clients (Claude Code's `mcp list`
    // health check, Cursor, etc.) don't flag the server as "broken" just
    // because we temporarily aren't attached to a live FastTerminal instance.
    // tools/call enforces CONNECTED and returns a clear message otherwise.
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    return
  }
  if (method === 'tools/call') {
    if (!CONNECTED) {
      send({
        jsonrpc: '2.0', id,
        result: {
          content: [{
            type: 'text',
            text: 'FastTerminal MCP bridge is not attached to a FastTerminal session. Start Claude Code from inside a FastTerminal tab — the bridge needs FASTTERMINAL_IDE_PORT / FASTTERMINAL_MCP_TOKEN env vars that FastTerminal injects automatically.',
          }],
          isError: true,
        },
      })
      return
    }
    const toolName = params && params.name
    const toolArgs = (params && params.arguments) || {}
    try {
      const text = await callTool(toolName, toolArgs)
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } })
    } catch (err) {
      send({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true },
      })
    }
    return
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
}

process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
