#!/usr/bin/env bun
/**
 * 飞书 Channel 插件安装脚本
 * 用法：bun setup.ts
 *
 * 自动完成：
 *   1. 将 skills 复制到 ~/.claude/skills/
 *   2. 输出根据当前目录生成的 MCP 配置
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const PLUGIN_DIR  = import.meta.dir
const CLAUDE_DIR  = path.join(os.homedir(), '.claude')
const SKILLS_DIR  = path.join(CLAUDE_DIR, 'skills')

// ─── 安装 skills ─────────────────────────────────────────────────────────────

const skills: Array<{ src: string; dest: string; name: string }> = [
  {
    src:  path.join(PLUGIN_DIR, 'skills', 'access.md'),
    dest: path.join(SKILLS_DIR, 'feishu-access', 'SKILL.md'),
    name: 'feishu-access',
  },
  {
    src:  path.join(PLUGIN_DIR, 'skills', 'configure.md'),
    dest: path.join(SKILLS_DIR, 'feishu-configure', 'SKILL.md'),
    name: 'feishu-configure',
  },
]

let skillsOk = true
for (const { src, dest, name } of skills) {
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
    console.log(`✅ skill 已安装：/feishu-${name.split('-')[1]}  →  ${dest}`)
  } catch (e) {
    console.error(`❌ skill 安装失败 (${name}): ${e}`)
    skillsOk = false
  }
}

// ─── 生成 MCP 配置 ────────────────────────────────────────────────────────────

// 统一用正斜杠，Windows 和 Unix 都兼容
const serverPath = path.join(PLUGIN_DIR, 'server.ts').replace(/\\/g, '/')

const mcpConfig = JSON.stringify(
  { mcpServers: { feishu: { command: 'bun', args: [serverPath] } } },
  null,
  2,
)

// ─── 检测 ~/.claude.json ──────────────────────────────────────────────────────

const globalJson = path.join(os.homedir(), '.claude.json')
let globalExists = false
try {
  const existing = JSON.parse(fs.readFileSync(globalJson, 'utf8'))
  if (existing?.mcpServers?.feishu) {
    // 更新路径
    existing.mcpServers.feishu = { command: 'bun', args: [serverPath] }
    fs.writeFileSync(globalJson, JSON.stringify(existing, null, 2))
    console.log(`✅ ~/.claude.json 已更新（feishu server 路径已同步）`)
    globalExists = true
  }
} catch { /* 文件不存在或解析失败，跳过 */ }

// ─── 输出结果 ─────────────────────────────────────────────────────────────────

console.log('')
if (!globalExists) {
  console.log('📋 将以下配置加入 ~/.claude.json（全局）或项目的 .mcp.json：')
  console.log('')
  console.log(mcpConfig)
  console.log('')
}

console.log('🔑 配置凭证（只需一次）：')
console.log('   1. 在飞书开放平台获取 App ID 和 App Secret')
console.log('   2. 运行：/feishu-configure <app_id> <app_secret>')
console.log('')
console.log('🚀 启动 Claude Code：')
console.log('   claude --dangerously-load-development-channels server:feishu')
console.log('')
if (skillsOk) {
  console.log('📌 可用 skill 命令：')
  console.log('   /feishu-configure <app_id> <app_secret>   配置凭证')
  console.log('   /feishu-access pair <code>                完成配对')
  console.log('   /feishu-access list                       查看白名单')
  console.log('   /feishu-access policy <pairing|allowlist|disabled>')
  console.log('   /feishu-access remove <open_id>           移除用户')
}
