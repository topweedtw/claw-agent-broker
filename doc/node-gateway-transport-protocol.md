# Node ↔ Gateway Transport Protocol (v1 Draft)

本文件定義 `node-host-ext` 與 `gateway-ext` 之間的 **Node ↔ Gateway transport 行為**，作為 Phase 2 / Phase 3 的共同實作依據。

> 範圍：**WebSocket transport、認證、heartbeat、request/response 配對、錯誤與重連規則**。  
> 不涵蓋：Claude Code / Kiro CLI 的 stdio 協議（另見 `doc/cli-stdio-protocol.md`）。

---

## 1. 設計目標

1. Node 採 **主動外連**，不需對外開 port
2. Gateway 作為控制平面，維持 Node online/offline 狀態
3. 所有 ACP session event 以 **單一長連線 WebSocket** 傳送
4. 每筆 Gateway 主動請求都可透過 `requestId` 與回應配對
5. 連線斷線後可自動重連、重新註冊、恢復可用狀態

---

## 2. 角色與連線模型

```text
Node (client)
  -- outbound WSS -->
Gateway (server)
```

### 基本原則

- **Node 永遠是 WebSocket client**
- **Gateway 永遠是 WebSocket server**
- 一台 Node 對應一條主要長連線
- 一個 WebSocket text frame = 一個完整 JSON message
- **不使用 NDJSON over WS**；WebSocket 本身已提供 message framing
- 建議使用 `wss://`，本地開發才使用 `ws://`

---

## 3. 協議分層

Transport message 分成兩層：

### A. Transport control messages
用於：
- 握手
- challenge-response 認證
- heartbeat
- drain / shutdown / protocol error

類型前綴建議：

```text
transport/hello
transport/challenge
transport/authenticate
transport/ready
transport/ping
transport/pong
transport/error
transport/drain
```

### B. ACP session messages
用於真正的遠端 coding session 控制：

```text
session/new
session/prompt
session/output
session/end
session/error
```

---

## 4. Message Encoding Rules

### Encoding
- UTF-8 JSON text message
- 每個 WebSocket message 為一個完整 JSON object
- 所有時間欄位建議使用 ISO 8601 UTC 字串

### Base fields
所有 `session/*` 訊息應至少包含：

```text
- type: string
- nodeId: string
- sessionId: string
- requestId?: string
- ts?: string
- version?: number
```

### 關鍵規則

1. `Gateway -> Node` 的主動 request（`session/new`、`session/prompt`、`session/end`）**必須帶 `requestId`**
2. `Node -> Gateway` 的 `session/output` / `session/error` / `session/end`，若是回應某筆 request，**必須原樣回帶同一個 `requestId`**
3. 同一個 `sessionId` 在 v1 採 **single-flight**：一次只允許一個 in-flight mutating request，避免 stream 混線
4. 不同 `sessionId` 可並行

---

## 5. 握手與認證流程

### 5.1 Sequence

```text
Node                                Gateway
----                                -------
WS connect  ----------------------> accept socket
transport/hello ------------------> validate token / metadata
               <------------------ transport/challenge
transport/authenticate -----------> verify Ed25519 signature
               <------------------ transport/ready

[connection enters READY state]
```

### 5.2 `transport/hello`

Node 連上後，應立即送出 hello：

```json
{
  "type": "transport/hello",
  "protocolVersion": 1,
  "role": "node",
  "nodeId": "node-a",
  "displayName": "Mac Mini",
  "publicKey": "base64...",
  "token": "optional-if-not-sent-in-header",
  "capabilities": {
    "sessionRelay": true,
    "cli": ["claude-code", "kiro"]
  }
}
```

### 5.3 `transport/challenge`

Gateway 回送 nonce challenge：

```json
{
  "type": "transport/challenge",
  "nodeId": "node-a",
  "nonce": "base64-random-nonce",
  "algorithm": "ed25519"
}
```

### 5.4 `transport/authenticate`

Node 使用私鑰簽章回送：

```json
{
  "type": "transport/authenticate",
  "nodeId": "node-a",
  "nonce": "base64-random-nonce",
  "signature": "base64-signature"
}
```

### 5.5 `transport/ready`

通過後，Gateway 回送 ready：

```json
{
  "type": "transport/ready",
  "nodeId": "node-a",
  "heartbeatIntervalMs": 15000,
  "serverTime": "2026-04-07T06:00:00.000Z",
  "resumed": false
}
```

---

## 6. 認證規則

### 兩層認證

| 層級 | 機制 | 用途 |
|---|---|---|
| 傳輸層 | Gateway Token | 驗證 Node 是否可接入 Gateway |
| 設備層 | Ed25519 Challenge-Response | 驗證 Node 身份 |

### 建議規則

- Node **優先**透過 WebSocket upgrade header 帶 `Authorization: Bearer <token>`
- 若環境受限，可退回在 `transport/hello.token` 中帶 token
- Gateway 在 token 驗證成功後，才進行 challenge-response
- 若 Node 未配對，Gateway 應 close `1008 pairing required`

---

## 7. Session Event 行為定義

### `session/new`
- Gateway 請求 Node 建立新 session
- 必須帶 `requestId`
- Node 成功後可回送：
  - `session/output`（初始化訊息）
  - 或 `session/error`

### `session/prompt`
- Gateway 對既有 session 傳送 prompt
- 必須帶 `requestId`
- Node 應將該 prompt 對應的所有 streaming output 都用同一個 `requestId` 回送

### `session/output`
- 表示 Node 正在串流回傳 CLI 輸出
- `done=false`：仍有後續輸出
- `done=true`：此筆 request 的輸出已完成
- **注意**：`done=true` 不等於整個 session 已關閉

### `session/end`
- 可能有兩種語意：
  1. Gateway 請求 Node 關閉 session
  2. Node 回報 session 已實際結束
- 若是回應某筆 request，應保留相同 `requestId`
- 一旦 session 真正結束，Node 不應再接受同一 `sessionId` 的 `session/prompt`

### `session/error`
- 表示該 request 或 session 處理失敗
- 必須帶：
  - `code`
  - `message`
- 建議帶：
  - `retryable`
  - `details`
- 若有因果 request，必須帶該 `requestId`

---

## 8. Request Correlation Contract

### 規則

- 每筆 outbound request 都必須有唯一 `requestId`
- `requestId` 在 request-response 生命週期中不可變
- Gateway 端應以：

```text
nodeId + sessionId + requestId
```

作為 correlation key

### Resolution Matrix

| 收到事件 | 對 pending request 的效果 |
|---|---|
| `session/output(done=false)` | 保持 pending，累積 chunk |
| `session/output(done=true)` | resolve request |
| `session/end` | resolve request，並標記 session closed |
| `session/error` | reject request |
| timeout | reject request |
| connection close | reject 所有 pending requests |

---

## 9. Heartbeat / Liveness

### 建議預設
- `heartbeatIntervalMs`: `15000`
- 連續 **3 次 heartbeat** 未回應視為連線失效

### Ping/Pong message

```json
{ "type": "transport/ping", "ts": "2026-04-07T06:00:15.000Z" }
```

```json
{ "type": "transport/pong", "ts": "2026-04-07T06:00:15.010Z" }
```

### 行為
- Gateway 與 Node 任一方都可發 `transport/ping`
- 收到 `transport/ping` 必須盡快回 `transport/pong`
- 若 heartbeat timeout，應主動 close socket 並觸發重連

---

## 10. Reconnect / Backoff

Node 斷線後應自動重連：

```text
1s -> 2s -> 4s -> 8s -> 16s -> 30s (max)
```

### 建議補充
- 加入 ±20% jitter，避免多台 Node 同時雪崩重連
- reconnect 後必須重新走：
  - `transport/hello`
  - `transport/challenge`
  - `transport/authenticate`
  - `transport/ready`

### reconnect 後不保證自動恢復
- 已經 in-flight 的 request 應由 Gateway 視為失敗或重新派送
- session 是否可 resume，留待後續版本處理

---

## 11. Close Codes 建議

| Code | 含義 | 說明 |
|---|---|---|
| `1000` | normal closure | 正常關閉 |
| `1001` | going away | 節點重啟 / Gateway 維護 |
| `1008` | pairing required / policy violation | 未配對或政策不允許 |
| `1011` | internal error | 伺服器內部錯誤 |
| `4001` | invalid token | Gateway token 無效 |
| `4002` | auth failed | Ed25519 驗證失敗 |
| `4003` | unsupported protocol version | 協議版本不相容 |
| `4004` | malformed message | JSON 或欄位格式錯誤 |
| `4005` | duplicate node connection | 相同 nodeId 已在線 |
| `4008` | heartbeat timeout | 心跳逾時 |

---

## 12. Phase 2 / Phase 3 實作邊界

### `node-host-ext` 應負責
- 建立與維持 WS 長連線
- 認證與重連
- 將 `session/*` event 轉給本機 session manager / CLI adapter
- 保留並回帶 `requestId`

### `gateway-ext` 應負責
- 接受 Node WS 連線
- 驗證 token 與 Ed25519 challenge-response
- 維護 `node-registry`
- 使用 `RequestCorrelator` 或等效機制追蹤 pending requests
- 將 Agent tool calls 轉為 `session/*` event，並把回傳 streaming 結果轉回 Agent

---

## 13. 建議實作順序

```text
Step 1: 先做 transport/hello -> challenge -> authenticate -> ready
Step 2: 做 session/new / session/prompt / session/output / session/end 基本流
Step 3: 接上 requestId / RequestCorrelator
Step 4: 補 heartbeat / reconnect / timeout
Step 5: 再接真實 Claude Code / Kiro adapter
```

---

## 14. V1 Final Decisions

本文件建議先鎖定以下 v1 決策：

1. **Node 主動外連 Gateway**
2. **單一 WebSocket 長連線**
3. **一個 WS message = 一個 JSON object**
4. **Gateway outbound request 必帶 `requestId`**
5. **Node 回傳 event 必須 mirror `requestId`**
6. **同一 `sessionId` 採 single-flight**
7. **用 `session/output(done=true)` 表示 request 輸出完成；`session/end` 表示 session 真正結束**
8. **disconnect 後 pending request 一律視為失敗，由上層決定是否重試**
