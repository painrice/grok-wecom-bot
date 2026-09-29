# grok-wecom-bot

企业微信 Bot 桥接服务，通过 **WebSocket 长连接**接收消息，调用 Grok CLI (`grok`) 生成 AI 回复。

## 架构

```
企业微信用户 ──消息──→ 企业微信服务器 ──WebSocket──→ grok-wecom-bot ──CLI──→ Grok (grok)
                                      ←──流式回复──                        ←──AI回复──
```

## 功能特性

- WebSocket 长连接实时接收企业微信消息
- 调用 Grok CLI 生成 AI 回复
- 流式进度推送：先发送「正在思考…」，超时保活，再发送最终回复
- 断线自动重连、心跳保活
- 多轮上下文（SQLite）、可选 Redis 缓存
- Prometheus 指标端点（默认 `:9090/metrics`）
- 熔断、用户级串行队列、长消息分片发送

## 前置条件

1. Node.js 16+
2. Grok CLI（`grok`）已安装并可用
3. 企业微信 aibot WebSocket 凭证：`WECOM_BOT_ID` / `WECOM_BOT_SECRET`

## 安装

```bash
git clone https://github.com/painrice/grok-wecom-bot.git
cd grok-wecom-bot
npm install
```

## 配置

所有密钥只放在本地配置中，仓库内仅提供占位符模板。

### 方式一：`.env`（推荐）

```bash
cp .env.example .env
# 编辑 .env，填入实际值
```

### 方式二：PM2

```bash
cp ecosystem.config.cjs.example ecosystem.config.cjs
# 编辑 ecosystem.config.cjs，填入实际值
```

### 环境变量

| 变量 | 说明 | 示例 |
|------|------|------|
| `WECOM_BOT_ID` | 企业微信 Bot ID | `your_bot_id_here` |
| `WECOM_BOT_SECRET` | 企业微信 Bot 密钥 | `your_bot_secret_here` |
| `GROK_BIN` | Grok CLI 路径 | `/root/.local/bin/grok` |
| `GROK_MODEL` | 模型名 | `grok` |
| `KEEPALIVE_MS` | 流式保活间隔（ms） | `25000` |
| `GROK_TIMEOUT_MS` | 单次 Grok 超时（ms） | `1800000` |
| `SEND_TIMEOUT_MS` | 发送超时（ms） | `8000` |
| `CTX_TURNS` | 上下文轮数 | `10` |
| `CTX_PER_MSG` | 单条截断长度 | `500` |
| `POOL_SIZE` | 进程池大小 | `3` |
| `METRICS_PORT` | 指标端口 | `9090` |
| `CONVERSATION_DB` | SQLite 路径（可选） | `/path/to/conversations.db` |
| `REDIS_URL` | Redis 缓存（可选） | `redis://localhost:6379` |
| `SHARED_AGENT_DIR` | 共享 Agent 目录 | `/path/to/shared` |

未设置 `CONVERSATION_DB` 时，默认写在 `SHARED_AGENT_DIR` 下的 `conversations.db`。

## 部署

### 直接运行

```bash
node index.cjs
```

### 使用 PM2（推荐）

```bash
pm2 start ecosystem.config.cjs
pm2 logs grok-wecom
pm2 save
pm2 startup
```

### 查看运行状态

```bash
pm2 status
pm2 describe grok-wecom
```

### 健康检查 / 指标

```bash
curl -s http://127.0.0.1:9090/        # ok
curl -s http://127.0.0.1:9090/metrics
```

## 目录结构

```
grok-wecom-bot/
├── index.cjs                      # 主程序入口
├── shared-memory.cjs              # SQLite 上下文 + Redis 缓存 + 插件钩子
├── ecosystem.config.cjs.example   # PM2 配置模板（复制后填真实值）
├── .env.example                   # 环境变量模板
├── package.json
└── README.md
```

`.env`、`ecosystem.config.cjs`、`node_modules/` 已在 `.gitignore` 中排除，请勿提交真实凭证。

## License

ISC
