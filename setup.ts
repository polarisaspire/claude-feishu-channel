#!/usr/bin/env bun
/**
 * 飞书 Channel 插件安装脚本
 * 用法：bun setup.ts
 *
 * 自动完成：
 *   1. 安装飞书官方 lark-cli（npm install -g @larksuite/cli）
 *   2. 安装飞书官方 lark-cli skills（npx skills add larksuite/cli）
 *   3. 配置应用凭证（lark-cli config init --new）
 *   4. 登录授权（lark-cli auth login --recommend）
 *   5. 验证登录状态（lark-cli auth status）
 *   6. 将本插件 skills 复制到 ~/.claude/skills/
 *   7. 输出根据当前目录生成的 MCP 配置
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { spawnSync } from 'node:child_process'

const PLUGIN_DIR = import.meta.dir
const CLAUDE_DIR = path.join(os.homedir(), '.claude')
const SKILLS_DIR = path.join(CLAUDE_DIR, 'skills')

// ─── 1. 安装 lark-cli CLI ─────────────────────────────────────────────────────

console.log('📦 正在安装飞书官方 lark-cli...')

const cliInstall = spawnSync('npm', ['install', '-g', '@larksuite/cli'], {
  stdio: 'inherit',
  shell: true,
})

if (cliInstall.status === 0) {
  console.log('✅ lark-cli 安装完成')
} else {
  console.warn('⚠️  lark-cli 安装失败，请手动运行：npm install -g @larksuite/cli')
}

console.log('')

// ─── 2. 安装官方 lark-cli skills ─────────────────────────────────────────────

console.log('📦 正在安装飞书官方 lark-cli skills...')

const larkInstall = spawnSync('npx', ['skills', 'add', 'larksuite/cli', '-y', '-g'], {
  stdio: 'inherit',
  shell: true,
})

if (larkInstall.status === 0) {
  console.log('✅ lark-cli skills 安装完成')
} else {
  console.warn('⚠️  lark-cli skills 安装失败（可能是网络问题或 npx 未安装）')
  console.warn('   手动安装：npx skills add larksuite/cli -y -g')
}

console.log('')

// ─── 3. 配置应用凭证 ──────────────────────────────────────────────────────────

console.log('🔑 配置飞书应用凭证（lark-cli config init --new）')
console.log('   命令会输出授权链接，请在浏览器中完成配置...')
console.log('')

const configInit = spawnSync('lark-cli', ['config', 'init', '--new'], {
  stdio: 'inherit',
  shell: true,
})

if (configInit.status !== 0) {
  console.warn('⚠️  config init 未正常退出，如已在飞书开放平台完成配置可忽略')
  console.warn('   手动运行：lark-cli config init --new')
}

console.log('')

// ─── 4. 登录授权 ──────────────────────────────────────────────────────────────

console.log('🔐 登录授权（lark-cli auth login --recommend）')
console.log('   命令会输出授权链接，请在浏览器中完成授权...')
console.log('')

const authLogin = spawnSync('lark-cli', ['auth', 'login', '--recommend'], {
  stdio: 'inherit',
  shell: true,
})

if (authLogin.status !== 0) {
  console.warn('⚠️  auth login 未正常退出，如已在浏览器完成授权可忽略')
  console.warn('   手动运行：lark-cli auth login --recommend')
}

console.log('')

// ─── 5. 验证登录状态 ──────────────────────────────────────────────────────────

console.log('✔️  验证登录状态（lark-cli auth status）')
console.log('')

const authStatus = spawnSync('lark-cli', ['auth', 'status'], {
  stdio: 'inherit',
  shell: true,
})

if (authStatus.status !== 0) {
  console.warn('⚠️  auth status 检查失败，请手动运行：lark-cli auth status')
}

console.log('')

// ─── 6. 安装本插件 skills ─────────────────────────────────────────────────────

const skills: Array<{ src: string; dest: string; cmd: string }> = [
  {
    src:  path.join(PLUGIN_DIR, 'skills', 'access.md'),
    dest: path.join(SKILLS_DIR, 'feishu-access', 'SKILL.md'),
    cmd:  '/feishu-access',
  },
  {
    src:  path.join(PLUGIN_DIR, 'skills', 'configure.md'),
    dest: path.join(SKILLS_DIR, 'feishu-configure', 'SKILL.md'),
    cmd:  '/feishu-configure',
  },
]

let skillsOk = true
for (const { src, dest, cmd } of skills) {
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
    console.log(`✅ skill 已安装：${cmd}  →  ${dest}`)
  } catch (e) {
    console.error(`❌ skill 安装失败 (${cmd}): ${e}`)
    skillsOk = false
  }
}

// ─── 7. 生成 MCP 配置 ─────────────────────────────────────────────────────────

const serverPath = path.join(PLUGIN_DIR, 'server.ts').replace(/\\/g, '/')

const mcpConfig = JSON.stringify(
  { mcpServers: { feishu: { command: 'bun', args: [serverPath] } } },
  null,
  2,
)

// 若 ~/.claude.json 已存在且有 feishu 条目，自动更新路径
const globalJson = path.join(os.homedir(), '.claude.json')
let globalUpdated = false
try {
  const existing = JSON.parse(fs.readFileSync(globalJson, 'utf8'))
  if (existing?.mcpServers?.feishu) {
    existing.mcpServers.feishu = { command: 'bun', args: [serverPath] }
    fs.writeFileSync(globalJson, JSON.stringify(existing, null, 2))
    console.log(`\n✅ ~/.claude.json 已更新（feishu server 路径已同步）`)
    globalUpdated = true
  }
} catch { /* 文件不存在或解析失败，跳过 */ }

// ─── 8. 输出后续步骤 ──────────────────────────────────────────────────────────

console.log('')

if (!globalUpdated) {
  console.log('📋 将以下配置加入 ~/.claude.json（全局）或项目的 .mcp.json：')
  console.log('')
  console.log(mcpConfig)
  console.log('')
}

console.log('🔑 配置凭证（只需一次）：')
console.log('   1. 在飞书开放平台获取 App ID 和 App Secret')
console.log('   2. 在 Claude Code 中运行：/feishu-configure <app_id> <app_secret>')
console.log('')
console.log('🚀 启动 Claude Code（带飞书 Channel）：')
console.log('   claude --dangerously-load-development-channels server:feishu')
console.log('')

if (skillsOk) {
  console.log('📌 可用 skill 命令：')
  console.log('   /feishu-configure <app_id> <app_secret>        配置凭证')
  console.log('   /feishu-access pair <code>                     完成配对')
  console.log('   /feishu-access list                            查看白名单')
  console.log('   /feishu-access policy <pairing|allowlist|disabled>')
  console.log('   /feishu-access remove <open_id>                移除用户')
  console.log('')
  console.log('   以及所有官方 lark-cli skills（/lark-im, /lark-doc 等）')
}
