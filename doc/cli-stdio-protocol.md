# CLI stdio 協議參考文件

本文件說明 **Claude Code** 與 **Kiro CLI** 透過 stdin/stdout 進行程式化通訊的協議格式，作為 `node-host-ext` 中 CLI Adapter 開發的技術依據。

---

## 一、Claude Code — stream-json 協議

### 概述

Claude Code CLI 支援 `--input-format stream-json` + `--output-format stream-json` 模式，以 **NDJSON（Newline-Delimited JSON）** 格式進行雙向通訊。每行 stdout 輸出為一個獨立且完整的 JSON 物件。

- **官方文件**：[Programmatic usage](https://docs.anthropic.com/en/docs/claude-code/headless)
- **CLI Reference**：[CLI flags](https://docs.anthropic.com/en/docs/claude-code/cli-reference)

---

### 啟動方式

```bash
# 基本 headless 模式（單次執行）
claude -p "你的 prompt" --output-format stream-json

# 雙向互動模式（適合 session 管理）
claude -p --input-format stream-json --output-format stream-json

# 加入 --verbose 與 --include-partial-messages 可取得完整 streaming
claude -p "prompt" \
  --output-format stream-json \
  --verbose \
  --include-partial-messages

# bare 模式（加速啟動，跳過 ~/.claude 設定載入）
claude --bare -p "prompt" \
  --output-format stream-json \
  --allowedTools "Bash,Read,Edit"
```

---

### stdout 輸出事件格式

所有輸出皆為 NDJSON，每行一個 JSON 物件，透過 `type` 欄位區分種類。

#### 1. `assistant` — Claude 回應文字

```json
{
  "type": "assistant",
  "content": [
    {
      "type": "text",
      "text": "這是 Claude 的回應內容..."
    }
  ]
}
```

#### 2. `stream_event` — Streaming 增量更新

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "delta": {
      "type": "text_delta",
      "text": "部分輸出文字"
    }
  }
}
```

> 使用 jq 取出純文字 stream：
> ```bash
> claude -p "prompt" --output-format stream-json --verbose --include-partial-messages \
>   | jq -rj 'select(.type == "stream_event" and .event.delta.type? == "text_delta") | .event.delta.text'
> ```

#### 3. `result` — 執行結果（最後一條訊息）

```json
{
  "type": "result",
  "result": "最終完整回應文字",
  "session_id": "uuid-session-id",
  "cost_usd": 0.0023,
  "duration_ms": 3450,
  "num_turns": 1
}
```

#### 4. `system` — 系統訊息（初始化、錯誤、重試）

```json
{
  "type": "system",
  "subtype": "api_retry",
  "attempt": 1,
  "max_retries": 3,
  "retry_delay_ms": 1000,
  "error_status": "rate_limit"
}
```

`error_status` 可能值：`authentication_failed` | `billing_error` | `rate_limit` | `invalid_request` | `server_error` | `max_output_tokens` | `unknown`

#### 5. `user` — 使用者輸入回聲

```json
{
  "type": "user",
  "content": "傳入的 prompt 文字"
}
```

---

### stdin 輸入格式（`--input-format stream-json`）

每行一個 JSON 物件，以 `\n` 結尾，必須 flush buffer。

```json
{ "type": "user", "content": "請幫我分析這段程式碼" }
```

關閉 stdin（`EOF`）代表通知 CLI 完成工作並退出。

---

### Session 管理

```bash
# 第一次執行，取得 session_id
session_id=$(claude -p "開始 code review" --output-format json | jq -r '.session_id')

# 繼續同一個 session
claude -p "繼續處理資料庫查詢" --resume "$session_id"

# 或使用 --continue 繼續最近一次 session
claude -p "產生問題摘要" --continue
```

---

### 工具授權（CLI Adapter 必要設定）

```bash
# 自動核准指定工具（不需使用者互動）
claude -p "prompt" --allowedTools "Bash,Read,Edit,Write"

# 允許特定 git 指令（glob 語法）
claude -p "prompt" --allowedTools "Bash(git diff *),Bash(git log *),Read"

# 完全跳過 permission 檢查（headless 環境用）
claude --allow-dangerously-skip-permissions -p "prompt"
```

---

### 工作目錄設定

```bash
# 指定工作目錄（--add-dir 或 cd）
cd /path/to/project && claude -p "prompt"
```

---

## 二、Kiro CLI — ACP（Agent Client Protocol）

### 概述

Kiro CLI 實作了 **ACP（Agent Client Protocol）** 標準，使用 **JSON-RPC 2.0 over stdio** 進行通訊。

- **ACP 官方規格**：[agentclientprotocol.com](https://agentclientprotocol.com)
- **Kiro docs**：[kiro.dev](https://kiro.dev)

---

### 啟動方式

```bash
# 啟動 Kiro ACP 模式
kiro-cli acp

# 指定特定 agent
kiro-cli acp --agent <agent-name>
```

Kiro CLI 以 **subprocess** 方式啟動，父行程透過 stdin/stdout 與其通訊。

---

### ACP 通訊流程

```
Client (node-host-ext)          Kiro CLI (subprocess)
        │                               │
        │ ── initialize ──────────────> │  建立連線，交換能力
        │ <── result (capabilities) ─── │
        │                               │
        │ ── session/new ─────────────> │  建立新 session
        │ <── result (sessionId) ─────  │
        │                               │
        │ ── session/prompt ──────────> │  傳送使用者 prompt
        │ <── session/update (stream) ─ │  streaming 回傳（多次）
        │ <── result (stop_reason) ──── │  prompt turn 結束
        │                               │
        │ ── session/cancel ──────────> │  （可選）中斷執行
```

---

### 訊息格式（JSON-RPC 2.0）

#### `initialize` — 初始化連線

**Request：**
```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientInfo": {
      "name": "claw-agent-broker",
      "version": "0.1.0"
    }
  }
}
```

**Response：**
```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "result": {
    "protocolVersion": 1,
    "agentCapabilities": {
      "loadSession": true,
      "mcpCapabilities": {
        "http": true,
        "sse": false
      }
    }
  }
}
```

---

#### `session/new` — 建立新 Session

**Request：**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session/new",
  "params": {
    "cwd": "/home/user/project",
    "mcpServers": []
  }
}
```

**Response：**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "sessionId": "sess_abc123def456"
  }
}
```

---

#### `session/load` — 恢復既有 Session

**Request：**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/load",
  "params": {
    "sessionId": "sess_789xyz",
    "cwd": "/home/user/project",
    "mcpServers": []
  }
}
```

**Response：**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": null
}
```

---

#### `session/prompt` — 傳送 Prompt

**Request：**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/prompt",
  "params": {
    "sessionId": "sess_abc123def456",
    "message": {
      "role": "user",
      "content": "幫我 refactor auth.ts，使用 dependency injection"
    }
  }
}
```

**（過程中的 Notification — streaming 輸出）：**
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_abc123def456",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "content": {
        "type": "text",
        "text": "好的，我來分析 auth.ts 的現有結構..."
      }
    }
  }
}
```

**Response（prompt turn 結束）：**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "stopReason": "end_turn"
  }
}
```

---

#### `session/cancel` — 中斷執行（Notification）

```json
{
  "jsonrpc": "2.0",
  "method": "session/cancel",
  "params": {
    "sessionId": "sess_abc123def456"
  }
}
```

> Notification 不需要 `id`，也不會有 Response。

---

### `session/update` 的 sessionUpdate 類型

| sessionUpdate 值 | 說明 |
|------------------|------|
| `agent_message_chunk` | Agent 回應文字 chunk（streaming）|
| `user_message_chunk` | 使用者訊息 chunk（載入 session 時回放）|
| `tool_call` | Agent 呼叫工具 |
| `tool_result` | 工具執行結果 |
| `agent_plan` | Agent 執行計畫更新 |
| `mode_change` | Session 模式切換 |

---

### Kiro 擴充方法（`_kiro.dev/` 前綴）

Kiro 在標準 ACP 之上加入了自訂擴充，使用 `_kiro.dev/` 前綴：

| 方法名稱 | 說明 |
|----------|------|
| `_kiro.dev/metadata` | 使用量與額度追蹤通知 |
| `_kiro.dev/permission_request` | 工具執行授權請求 |
| `_kiro.dev/mcp_config` | MCP Server 設定 |

---

## 三、CLI Adapter 實作要點

### Claude Code Adapter

```typescript
// 啟動 Claude Code process
const proc = spawn('claude', [
  '--bare',
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--allow-dangerously-skip-permissions',
  '--allowedTools', 'Bash,Read,Edit,Write,Glob',
], {
  cwd: workdir,
  env: { ...process.env, ANTHROPIC_API_KEY: '...' },
  stdio: ['pipe', 'pipe', 'pipe'],
})

// 送出 prompt（每行一個 JSON + \n）
proc.stdin.write(JSON.stringify({ type: 'user', content: prompt }) + '\n')

// 讀取 stdout streaming
let buffer = ''
proc.stdout.on('data', (chunk) => {
  buffer += chunk.toString()
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    const event = JSON.parse(line)
    handleClaudeEvent(event)
  }
})

// 結束 session
proc.stdin.end()
```

### Kiro CLI Adapter

```typescript
// 啟動 Kiro ACP process
const proc = spawn('kiro-cli', ['acp'], {
  cwd: workdir,
  stdio: ['pipe', 'pipe', 'pipe'],
})

let requestId = 0
const send = (method: string, params: object, expectResponse = true) => {
  const msg: any = { jsonrpc: '2.0', method, params }
  if (expectResponse) msg.id = ++requestId
  proc.stdin.write(JSON.stringify(msg) + '\n')
  return msg.id
}

// 初始化
send('initialize', { protocolVersion: 1, clientInfo: { name: 'claw-agent-broker', version: '0.1.0' } })
// 等待 response 後建立 session
send('session/new', { cwd: workdir, mcpServers: [] })
// 等待 sessionId 後送出 prompt
send('session/prompt', { sessionId, message: { role: 'user', content: prompt } })
```

---

## 四、兩者差異對照

| 比較項目 | Claude Code | Kiro CLI |
|----------|-------------|----------|
| 協議 | 自訂 NDJSON stream | ACP（JSON-RPC 2.0）|
| 傳輸 | NDJSON over stdio | JSON-RPC over stdio |
| Session 建立 | `--resume <sessionId>` flag | `session/new` method |
| Streaming | `stream_event` 事件 | `session/update` notification |
| 取消執行 | 關閉 stdin / kill process | `session/cancel` notification |
| 工具授權 | `--allowedTools` flag | `session/request_permission` method call |
| 工作目錄 | `cwd` 環境 / `--add-dir` | `session/new.cwd` 參數 |
| 標準化程度 | Anthropic 自有格式 | 業界開放標準 ACP |

---

## 五、參考資源

- [Claude Code CLI Reference](https://docs.anthropic.com/en/docs/claude-code/cli-reference)
- [Claude Code Programmatic Usage](https://docs.anthropic.com/en/docs/claude-code/headless)
- [Agent Client Protocol 官方規格](https://agentclientprotocol.com/protocol/overview)
- [ACP Session Setup](https://agentclientprotocol.com/protocol/session-setup)
- [ACP Prompt Turn](https://agentclientprotocol.com/protocol/prompt-turn)
- [ACP Schema](https://agentclientprotocol.com/protocol/schema)
- [Kiro CLI 官方文件](https://kiro.dev)
