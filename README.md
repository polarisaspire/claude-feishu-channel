# Feishu Channel Plugin for Claude Code

将飞书/Lark 消息桥接到 Claude Code 会话，实现双向通信。参考 Telegram 官方插件实现。

## 功能

- 📨 接收飞书 DM / 群消息，转发给 Claude Code
- 💬 Claude 通过 `reply` 工具回复飞书
- 👍 支持 emoji 表情回应（`react` 工具）
- ✏️ 支持编辑已发送消息（`edit_message` 工具）
- 🔐 配对机制（pairing code）控制访问权限
- ⚡ 权限中继：在飞书中远程审批 Claude 的工具调用

## 前置条件

1. **安装 Bun**：`curl -fsSL https://bun.sh/install | bash`
2. **飞书开放平台**创建企业自建应用，获取 App ID 和 App Secret
3. 开启**机器人能力**
4. 配置**事件订阅** → 长连接（WebSocket）→ 添加 `im.message.receive_v1`
5. 配置权限：`im:message`、`im:message:send_as_bot`、`im:chat`

## 安装

### 1. 下载插件

将本目录放在任意位置，例如：

```
~/feishu-channel/
C:/tools/feishu-channel/
/opt/feishu-channel/
```

### 2. 安装依赖 & 初始化

```bash
cd feishu-channel
bun install
bun setup.ts
```

`setup.ts` 会自动：
- 安装**飞书官方 lark-cli skills**（`/lark-im`、`/lark-doc`、`/lark-base` 等，命令列表随官方更新）
- 将本插件 skills 复制到 `~/.claude/skills/`（安装 `/feishu-access` 和 `/feishu-configure` 命令）
- 输出根据当前路径生成的 MCP 配置

### 3. 注册 MCP server

将 `setup.ts` 输出的配置加入 `~/.claude.json`（全局）：

```json
{
  "mcpServers": {
    "feishu": {
      "command": "bun",
      "args": ["/your/path/to/feishu-channel/server.ts"]
    }
  }
}
```

> 路径以 `setup.ts` 的实际输出为准，不要手动填写。

### 4. 配置凭证

在任意 Claude Code session 中运行：

```
/feishu-configure cli_your_app_id your_app_secret
```

### 5. 启动 Claude Code

```bash
claude --dangerously-load-development-channels server:feishu
```

### 6. 配对飞书账号

在飞书中 DM 机器人任意消息，机器人会回复配对码。
在 Claude Code session 中运行：

```
/feishu-access pair <配对码>
```

## Skill 命令

skills 安装位置：`~/.claude/skills/feishu-access/` 和 `~/.claude/skills/feishu-configure/`

| 命令 | 说明 |
|------|------|
| `/feishu-configure <app_id> <app_secret>` | 配置应用凭证 |
| `/feishu-access pair <code>` | 批准配对请求 |
| `/feishu-access policy pairing\|allowlist\|disabled` | 修改 DM 策略 |
| `/feishu-access list` | 查看当前配置 |
| `/feishu-access remove <open_id>` | 移除用户 |

`bun setup.ts` 同时会安装[飞书官方 lark-cli skills](https://github.com/larksuite/cli)，含 `/lark-im`（收发消息）、`/lark-doc`（云文档）、`/lark-base`（多维表格）、`/lark-calendar`（日历）等命令，无需单独安装。可运行以下命令查看当前可用命令列表：

```bash
npx skills list -g
```

## 群聊支持

群聊默认关闭。编辑 `~/.claude/channels/feishu/access.json`：

```json
{
  "groups": {
    "oc_your_chat_id": {
      "policy": "allowlist",
      "allowFrom": ["ou_your_open_id"]
    }
  }
}
```

## 权限中继

Claude 需要执行需审批的工具时，会通过飞书 DM 发送提示。在飞书中回复：

```
yes abcde    ← 允许
no abcde     ← 拒绝
```

## 状态文件

| 文件 | 说明 |
|------|------|
| `~/.claude/channels/feishu/.env` | App ID 和 App Secret |
| `~/.claude/channels/feishu/access.json` | 访问控制配置 |

## 环境变量

| 变量 | 说明 |
|------|------|
| `FEISHU_APP_ID` | 应用 ID（必须） |
| `FEISHU_APP_SECRET` | 应用密钥（必须） |
| `FEISHU_STATE_DIR` | 状态目录（默认 `~/.claude/channels/feishu`） |
