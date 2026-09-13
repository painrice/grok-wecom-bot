# grok-wecom-bot

企业微信 Bot 桥接服务，通过 WebSocket 长连接接收消息，调用 Grok CLI (grok) 生成 AI 回复。

## 架构

```
企业微信用户 ──消息──→ 企业微信服务器 ──WebSocket──→ grok-wecom-bot ──CLI──→ Grok (grok)
                                      ←──流式回复──                        ←──AI回复──
```

## 功能特性

- WebSocket 长连接实时接收企业微信消息
- 调用 Grok CLI (grok) 生成 AI 回复
- 支持流式回复：先发送"正在思考…"，再发送最终回复
- 自动重连：断线后 2 秒自动重连
- 心跳保活：30 秒间隔维持连接

## 安装

```bash
git clone https://github.com/painrice/grok-wecom-bot.git
cd grok-wecom-bot
npm install
```

## 配置

### 环境变量

| 变量 | 说明 | 示例 |
|------|------|------|
| `WECOM_BOT_ID` | 企业微信 Bot ID | `aibckhkgWRSDnXYpGoadBV7gnUJUmSNgg0o` |
| `WECOM_BOT_SECRET` | 企业微信 Bot 密钥 | `zUnKM8B5SQLjLN3C7vvZ...` |
| `GROK_BIN` | Grok CLI 路径 | `/root/.local/bin/grok` |
| `GROK_MODEL` | Grok 使用的模型 | `grok` |
| `LONGCAT_API_KEY` | LongCat API Key | `ak_2Kw8jv4Km5Sd3SO...` |
| `NODE_ENV` | 运行环境 | `production` |

### 配置方式

**方式一：PM2 ecosystem（推荐）**

复制 `ecosystem.config.cjs.example` 为 `ecosystem.config.cjs`，填入实际值：

```javascript
module.exports = {
  apps: [{
    name: "grok-wecom",
    script: "index.cjs",
    cwd: "/path/to/grok-wecom-bot",
    env: {
      WECOM_BOT_ID: "your_bot_id",
      WECOM_BOT_SECRET: "your_bot_secret",
      GROK_BIN: "/path/to/grok",
      GROK_MODEL: "grok",
      LONGCAT_API_KEY: "your_api_key",
    }
  }]
};
```

**方式二：.env 文件**

```bash
cp .env.example .env
# 编辑 .env 填写实际值
```

## 部署

### 直接运行

```bash
node index.cjs
```

### 使用 PM2（推荐）

```bash
# 启动
pm2 start ecosystem.config.cjs

# 查看日志
pm2 logs grok-wecom

# 设置开机自启
pm2 save
pm2 startup
```

### 查看运行状态

```bash
pm2 status
pm2 describe grok-wecom
```

## 依赖

| 包名 | 说明 |
|------|------|
| `@wecom/aibot-node-sdk` | 企业微信 Bot WebSocket SDK |
| [Grok CLI](https://github.com/xai-org/grok) | xAI 命令行 AI 工具 |

## 目录结构

```
grok-wecom-bot/
├── index.cjs              # 主程序入口
├── ecosystem.config.cjs   # PM2 配置（需自行创建）
├── .env.example           # 环境变量模板
├── package.json           # 依赖配置
└── README.md              # 本文件
```

## License

ISC
