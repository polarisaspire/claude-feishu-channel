#!/usr/bin/env bun
/**
 * Feishu Channel plugin for Claude Code
 *
 * Bridges Feishu/Lark messages into a Claude Code session via the MCP channel protocol.
 * Supports two-way chat, emoji reactions, message editing, and permission relay.
 *
 * Prerequisites:
 *   - Feishu app with Bot capability enabled
 *   - im.message.receive_v1 event subscribed via long connection (WebSocket)
 *   - FEISHU_APP_ID and FEISHU_APP_SECRET configured (via /feishu:configure)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import * as lark from '@larksuiteoapi/node-sdk'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'

// ─── Config ──────────────────────────────────────────────────────────────────

const STATE_DIR   = process.env.FEISHU_STATE_DIR ?? path.join(os.homedir(), '.claude', 'channels', 'feishu')
const ENV_FILE    = path.join(STATE_DIR, '.env')
const ACCESS_FILE = path.join(STATE_DIR, 'access.json')
const LOG_FILE    = path.join(STATE_DIR, 'channel.log')

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  process.stderr.write(line)
  try { fs.appendFileSync(LOG_FILE, line) } catch (e) {
    process.stderr.write(`[log-write-failed] ${e}\n`)
  }
}

log('=== server.ts starting ===')

loadDotEnv()

const APP_ID     = process.env.FEISHU_APP_ID     ?? die('FEISHU_APP_ID missing. Run /feishu:configure first.')
const APP_SECRET = process.env.FEISHU_APP_SECRET ?? die('FEISHU_APP_SECRET missing. Run /feishu:configure first.')

function die(msg: string): never {
  process.stderr.write(msg + '\n')
  process.exit(1)
}

function loadDotEnv() {
  try {
    if (!fs.existsSync(ENV_FILE)) return
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/)
      if (m) process.env[m[1]] = m[2].trim()
    }
  } catch { /* ignore */ }
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface GroupPolicy {
  policy: 'allowlist' | 'mention_only' | 'disabled'
  allowFrom?: string[]
}

interface PendingEntry {
  openId: string
  chatId: string   // the p2p chat_id this came from
  expiresAt: number
  replyCount: number
}

interface Access {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]                    // allowed open_ids
  chatIds: Record<string, string>        // open_id → p2p chat_id (for permission relay)
  groups: Record<string, GroupPolicy>    // group chat_id → policy
  pending: Record<string, PendingEntry>  // pairing code → entry
  ackReaction?: string                   // emoji to ack received messages, e.g. 'THUMBSUP'
}

const DEFAULT_ACCESS: Access = {
  dmPolicy: 'pairing',
  allowFrom: [],
  chatIds: {},
  groups: {},
  pending: {},
  ackReaction: 'THUMBSUP',
}

// ─── Access control ──────────────────────────────────────────────────────────

let access: Access = { ...DEFAULT_ACCESS }

function loadAccess() {
  try {
    if (fs.existsSync(ACCESS_FILE))
      access = { ...DEFAULT_ACCESS, ...JSON.parse(fs.readFileSync(ACCESS_FILE, 'utf8')) }
  } catch { /* use defaults */ }
}

function saveAccess() {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.writeFileSync(ACCESS_FILE, JSON.stringify(access, null, 2))
}

loadAccess()

// Watch for external writes from skills (e.g. /feishu:access pair)
try {
  fs.watch(STATE_DIR, (_, fname) => { if (fname === 'access.json') loadAccess() })
} catch { /* dir may not exist yet */ }

function generateCode(): string {
  // 6 chars, avoids 0/O/1/I/L for legibility
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  return Array.from(crypto.randomBytes(6)).map(b => chars[b % chars.length]).join('')
}

function purgeExpired() {
  const now = Date.now()
  for (const [code, e] of Object.entries(access.pending))
    if (e.expiresAt < now) delete access.pending[code]
}

function isDmAllowed(openId: string): boolean {
  return access.allowFrom.includes(openId)
}

function isGroupAllowed(openId: string, chatId: string): boolean {
  const g = access.groups[chatId]
  if (!g || g.policy === 'disabled') return false
  if (g.policy === 'allowlist') return g.allowFrom?.includes(openId) ?? false
  return true // mention_only — caller handles mention detection
}

// ─── Feishu REST client ──────────────────────────────────────────────────────

const feishu = new lark.Client({
  appId: APP_ID,
  appSecret: APP_SECRET,
  loggerLevel: lark.LoggerLevel.error,
})

// ─── MCP server ──────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'feishu', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},           // registers the channel notification listener
        'claude/channel/permission': {}, // opts in to permission relay
      },
      tools: {},
    },
    instructions:
      'Feishu messages arrive as <channel source="feishu" chat_id="..." open_id="..." message_id="..." chat_type="p2p|group">. ' +
      'Always reply with the reply tool using the chat_id from the tag. ' +
      'Use react to acknowledge (emoji: THUMBSUP OK CLAP LOVE THINKING WAVE). ' +
      'Use edit_message to update a prior reply (pass its message_id). ' +
      'Always reply with results when a task produces output (e.g. query results, status info). ' +
      'When the task is a pure action with no meaningful result (e.g. sending a message, adding a reaction), do NOT send a follow-up confirmation like "已发送" or "完成" — the action speaks for itself.',
  },
)

// ─── Message → Chat mapping (for edit_message to resolve chatId) ─────────────

// Tracks bot-sent message_id → chat_id so edit_message can clearProcessing
// Capped at 200 entries to avoid unbounded growth
const msgChatMap = new Map<string, string>()
const MSG_CHAT_MAP_MAX = 200

function trackMsgChat(messageId: string, chatId: string) {
  if (msgChatMap.size >= MSG_CHAT_MAP_MAX) {
    // Evict oldest entry
    msgChatMap.delete(msgChatMap.keys().next().value!)
  }
  msgChatMap.set(messageId, chatId)
}

// ─── Tool handlers ───────────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a text message to a Feishu chat',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id:  { type: 'string', description: 'Chat ID from the channel tag (oc_xxx)' },
          text:     { type: 'string', description: 'Message text (supports Feishu markdown)' },
          reply_to: { type: 'string', description: 'Optional: message_id (om_xxx) to create a thread reply' },
        },
        required: ['chat_id', 'text'],
      },
    },
    {
      name: 'react',
      description: 'Add an emoji reaction to a Feishu message',
      inputSchema: {
        type: 'object' as const,
        properties: {
          message_id: { type: 'string', description: 'Message ID (om_xxx)' },
          emoji: {
            type: 'string',
            description: 'Feishu emoji type: THUMBSUP, OK, CLAP, LOVE, THINKING, WAVE, SURPRISED, etc.',
          },
        },
        required: ['message_id', 'emoji'],
      },
    },
    {
      name: 'edit_message',
      description: 'Edit a previously sent message (bot messages only)',
      inputSchema: {
        type: 'object' as const,
        properties: {
          message_id: { type: 'string', description: 'Message ID to edit (om_xxx)' },
          text:       { type: 'string', description: 'New message content' },
        },
        required: ['message_id', 'text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  switch (req.params.name) {
    case 'reply': {
      const { chat_id, text, reply_to } = req.params.arguments as {
        chat_id: string; text: string; reply_to?: string
      }
      const chunks = chunkText(text, 4000)
      const ids: string[] = []
      for (let i = 0; i < chunks.length; i++) {
        const body: Record<string, unknown> = {
          receive_id: chat_id,
          msg_type: 'interactive',
          content: JSON.stringify(buildCard(chunks[i])),
        }
        // Thread reply: only on the first chunk, and only if reply_to is given
        if (i === 0 && reply_to) body.reply_in_thread = true
        const resp = await feishu.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: body as any,
        })
        if (resp.data?.message_id) {
          ids.push(resp.data.message_id)
          trackMsgChat(resp.data.message_id, chat_id)
        }
      }
      // Clear after API calls complete so the next inbound notification
      // isn't forwarded to Claude while it's still processing this tool call
      clearProcessing(chat_id)
      return { content: [{ type: 'text', text: `sent: ${ids.join(', ')}` }] }
    }

    case 'react': {
      const { message_id, emoji } = req.params.arguments as { message_id: string; emoji: string }
      await feishu.im.messageReaction.create({
        path: { message_id },
        data: { reaction_type: { emoji_type: emoji } },
      })
      return { content: [{ type: 'text', text: 'reacted' }] }
    }

    case 'edit_message': {
      const { message_id, text } = req.params.arguments as { message_id: string; text: string }
      // Note: Feishu only allows editing bot-sent messages within a time window
      await feishu.im.message.patch({
        path: { message_id },
        data: { msg_type: 'interactive', content: JSON.stringify(buildCard(text)) },
      } as any)
      // Resolve chatId from the message we sent, then clear processing state
      const chatId = msgChatMap.get(message_id)
      if (chatId) clearProcessing(chatId)
      return { content: [{ type: 'text', text: 'edited' }] }
    }

    default:
      throw new Error(`unknown tool: ${req.params.name}`)
  }
})

// ─── Permission relay ────────────────────────────────────────────────────────

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id:    z.string(),
    tool_name:     z.string(),
    description:   z.string(),
    input_preview: z.string(),
  }),
})

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  const msg =
    `⚡ Claude 想执行 **${params.tool_name}**\n` +
    `说明：${params.description}\n\n` +
    `回复 \`yes ${params.request_id}\` 允许，或 \`no ${params.request_id}\` 拒绝`

  for (const openId of access.allowFrom) {
    const chatId = access.chatIds[openId]
    if (!chatId) continue
    feishu.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: msg }) },
    }).catch(() => { /* ignore per-user errors */ })
  }
})

// ─── Inbound message handler ─────────────────────────────────────────────────

// Matches permission verdicts: "yes abcde" / "no abcde" (5 lowercase letters, no 'l')
const PERMISSION_RE = /^\s*(y(?:es)?|n(?:o)?)\s+([a-km-z]{5})\s*$/i

// Processing state: tracks which users Claude is currently handling
// openId → { chatId, timeoutHandle }
// Cleared when Claude calls reply/edit_message, or after PROCESSING_TTL as fallback
const PROCESSING_TTL = 3 * 60_000 // 3-minute fallback timeout
const processingUsers = new Map<string, { chatId: string; timer: ReturnType<typeof setTimeout> }>()

function setProcessing(openId: string, chatId: string) {
  const existing = processingUsers.get(openId)
  if (existing) clearTimeout(existing.timer)
  processingUsers.set(openId, {
    chatId,
    timer: setTimeout(() => processingUsers.delete(openId), PROCESSING_TTL),
  })
}

function clearProcessing(chatId: string) {
  for (const [openId, entry] of processingUsers) {
    if (entry.chatId === chatId) {
      clearTimeout(entry.timer)
      processingUsers.delete(openId)
      log(`✓ clearProcessing: ${openId}`)
      break
    }
  }
}

async function handleInbound(
  openId:   string,
  chatId:   string,
  chatType: string,  // 'p2p' | 'group'
  msgId:    string,
  text:     string,
): Promise<void> {
  // Track p2p chat_id per user for permission relay
  if (chatType === 'p2p' && openId && chatId && access.chatIds[openId] !== chatId) {
    access.chatIds[openId] = chatId
    saveAccess()
  }

  // Permission verdicts: intercept before any gate check (allowed users only)
  if (isDmAllowed(openId)) {
    const m = PERMISSION_RE.exec(text)
    if (m) {
      await mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: {
          request_id: m[2].toLowerCase(),
          behavior: m[1].toLowerCase().startsWith('y') ? 'allow' : 'deny',
        },
      })
      return
    }
  }

  // Gate: DM
  if (chatType === 'p2p') {
    if (!isDmAllowed(openId)) {
      if (access.dmPolicy !== 'pairing') return

      // Pairing flow: unknown user → generate or resend code
      purgeExpired()
      let code = Object.entries(access.pending).find(([, e]) => e.openId === openId)?.[0]

      if (!code) {
        if (Object.keys(access.pending).length >= 3) return // too many pending, ignore
        code = generateCode()
        access.pending[code] = { openId, chatId, expiresAt: Date.now() + 3_600_000, replyCount: 1 }
        saveAccess()
      } else {
        const e = access.pending[code]!
        if (e.replyCount < 2) { e.replyCount++; saveAccess() }
        else return // already sent reminder twice, stop spamming
      }

      await feishu.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({
            text: `你好！在 Claude Code 中运行以下命令完成配对：\n\n/feishu-access pair ${code}\n\n（有效期 1 小时）`,
          }),
        },
      })
      return
    }
  } else {
    // Group chat gate
    if (!isGroupAllowed(openId, chatId)) return
  }

  // Busy check: if Claude is still handling a previous message from this user, notify them
  if (processingUsers.has(openId)) {
    log(`⏳ busy: ${openId}, dropping message`)
    feishu.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: '⏳ 正在处理中，请稍候…' }),
      },
    }).catch(() => { /* ignore */ })
    return
  }

  // Mark user as processing (cleared when Claude calls reply, or after TTL)
  setProcessing(openId, chatId)

  // Ack reaction (fire-and-forget)
  if (access.ackReaction) {
    feishu.im.messageReaction.create({
      path: { message_id: msgId },
      data: { reaction_type: { emoji_type: access.ackReaction } },
    }).catch(() => { /* ignore */ })
  }

  // Forward to Claude Code
  log(`→ notify claude: ${openId} busy=${processingUsers.size} text="${text.slice(0, 60)}"`)
  try {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: text,
        meta: { chat_id: chatId, open_id: openId, message_id: msgId, chat_type: chatType },
      },
    })
    log('✓ notify sent ok')
  } catch (err) {
    log(`✗ notify failed: ${err}`)
  }
}

// ─── Start ───────────────────────────────────────────────────────────────────

// Connect to Claude Code over stdio first
await mcp.connect(new StdioServerTransport())

// Then start the Feishu WebSocket long connection
const wsClient = new lark.WSClient({
  appId: APP_ID,
  appSecret: APP_SECRET,
  loggerLevel: lark.LoggerLevel.error,
})

wsClient.start({
  eventDispatcher: new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: any) => {
      try {
        const msg    = data.message
        const sender = data.sender
        const openId   = (sender?.sender_id?.open_id ?? '').trim()
        const chatId   = (msg?.chat_id ?? '').trim()
        const chatType = msg?.chat_type ?? 'p2p'
        const msgId    = (msg?.message_id ?? '').trim()
        const msgType  = msg?.message_type ?? msg?.msg_type ?? ''

        log(`raw: msgId=${msgId} sender_type=${sender?.sender_type} msgType=${msgType} openId=${openId}`)

        if (!openId || !chatId || !msgId) return
        if (sender?.sender_type === 'app') return // ignore bot's own messages
        if (msgType !== 'text') return // only handle text for now

        let text = ''
        try { text = (JSON.parse(msg.content)?.text ?? '').trim() } catch { return }

        // Strip @mentions (common in group chats)
        text = text.replace(/@[^\s\u200b]+/g, '').trim()
        if (!text) return

        log(`← inbound: ${openId} "${text.slice(0, 60)}"`)
        await handleInbound(openId, chatId, chatType, msgId, text)
      } catch (err) {
        log(`✗ inbound error: ${err}`)
      }
    },
  }),
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Wrap markdown text in a Feishu interactive card so lark_md renders it properly */
function buildCard(content: string): object {
  return {
    config: { wide_screen_mode: true },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content },
      },
    ],
  }
}

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let rem = text
  while (rem.length > 0) {
    if (rem.length <= limit) { chunks.push(rem); break }
    // Prefer paragraph boundary, then newline, then hard cut
    let i = rem.lastIndexOf('\n\n', limit)
    if (i < limit >> 1) i = rem.lastIndexOf('\n', limit)
    if (i < limit >> 1) i = limit
    chunks.push(rem.slice(0, i))
    rem = rem.slice(i).trimStart()
  }
  return chunks
}

// ─── Graceful shutdown ───────────────────────────────────────────────────────

process.stdin.on('end', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
