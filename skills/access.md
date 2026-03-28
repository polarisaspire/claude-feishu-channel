---
name: feishu-access
version: 1.0.0
description: "飞书 Channel 插件访问控制：配对新用户、修改 DM 策略、查看或移除白名单。用法：pair <code> | policy <pairing|allowlist|disabled> | list | remove <open_id>"
---

# feishu-access

管理飞书 Channel 插件的访问控制。状态文件：`~/.claude/channels/feishu/access.json`

## pair \<code\>

将待配对用户加入白名单。

步骤：
1. 读取 `~/.claude/channels/feishu/access.json`
2. 在 `pending` 中查找 key 等于 `<code>` 的条目
3. 若不存在 → 告知"配对码无效或已过期"
4. 若 `expiresAt` < 当前时间戳（毫秒）→ 告知"配对码已过期"
5. 若有效：
   - 将条目的 `openId` 追加到 `allowFrom`（如已存在则跳过）
   - 从 `pending` 中删除该条目
   - 保存文件
   - 回复"✅ 配对成功，用户已加入白名单"

## policy \<pairing|allowlist|disabled\>

修改 DM 访问策略：
- `pairing`：未知用户收到配对码提示（默认）
- `allowlist`：仅白名单用户可发消息
- `disabled`：忽略所有 DM

步骤：读取文件 → 修改 `dmPolicy` → 保存 → 确认变更

## list

显示当前配置摘要：
- `dmPolicy` 当前值
- `allowFrom` 中的所有 open_id
- `pending` 中未过期的配对码（含过期时间）

## remove \<open_id\>

从白名单移除用户：
1. 从 `allowFrom` 移除该 open_id
2. 从 `chatIds` 移除对应条目
3. 保存文件
4. 确认移除
