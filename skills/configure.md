---
name: feishu-configure
version: 1.0.0
description: "配置飞书 Channel 插件凭证（App ID 和 App Secret）。用法：/feishu-configure <app_id> <app_secret>"
---

# feishu-configure

配置飞书 Channel 插件的应用凭证。

## 用法

```
/feishu-configure <app_id> <app_secret>
```

## 步骤

当传入 `<app_id>` 和 `<app_secret>` 时：

1. 创建目录（如不存在）：
   ```bash
   mkdir -p ~/.claude/channels/feishu
   ```

2. 写入凭证文件 `~/.claude/channels/feishu/.env`：
   ```
   FEISHU_APP_ID=<app_id>
   FEISHU_APP_SECRET=<app_secret>
   ```

3. 限制文件权限（Mac/Linux）：
   ```bash
   chmod 600 ~/.claude/channels/feishu/.env
   ```

4. 确认完成："✅ 飞书配置完成。用以下命令启动：`claude --dangerously-load-development-channels server:feishu`"

若参数不完整，提示用户提供 App ID（格式：cli_xxx）和 App Secret（来自飞书开放平台 → 凭证与基础信息）。
