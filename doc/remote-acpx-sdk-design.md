# Remote ACPX SDK Design

## Overview

`remote-acpx-sdk` 是 `claw-agent-broker` 的共享協議層元件，目的是為 **Gateway** 與 **Remote Node** 提供一致的遠端 ACP event 定義、序列化規則、錯誤模型，以及最小可用的 transport client API。

它負責：

- 定義遠端 session 控制事件
- 提供 JSON-over-WebSocket 的編解碼
- 統一 Gateway 與 Node 對 event 的理解
- 作為 `gateway-ext`、`node-host-ext`、`remote-acpx-plugin` 的共同基礎

它不負責：

- CLI adapter（Claude / Kiro）
- session manager
- Gateway router business logic
- auth / pairing policy 本身

---

## Goals

1. 提供穩定的遠端 ACP event contract
2. 降低 Gateway / Node 之間的協議漂移
3. 提供最小可用的 TypeScript SDK
4. 讓後續模組可安全收發與驗證 remote ACP events

## Non-Goals

以下內容 **不屬於** `remote-acpx-sdk` 的責任範圍：

- Claude Code / Kiro CLI 的 stdio adapter
- child process lifecycle 管理
- Gateway routing business logic
- Node registry / session registry
- 配對、認證、權限策略本身
- daemon 或高階 reconnect orchestration

---

## Package Layout

```text
packages/remote-acpx-sdk/
  src/
    index.ts
    types.ts
    events.ts
    errors.ts
    client.ts
    correlation.ts
```

### Module responsibilities

- `types.ts`：所有 remote ACP event 型別定義
- `events.ts`：event serialize / parse / validate helpers
- `errors.ts`：transport / protocol / validation error classes
- `client.ts`：最小可用 WebSocket client wrapper
- `correlation.ts`：`requestId` 生成、matching、pending request tracking、timeout/cancel helpers
- `index.ts`：公開 API 匯出

---

## Event Transport Model

- **Transport**: WebSocket
- **Payload format**: JSON
- **Message model**: one WebSocket message = one event object

```text
Gateway
  -- send event -->
Node
  -- send event -->
Gateway
```

---

## Base Event Contract

所有 event 應共享一個基本 envelope：

```text
BaseEvent
- type: string
- sessionId: string
- nodeId: string
- requestId?: string
- ts?: string
- version?: number
```

說明：

- `type`: event 種類
- `sessionId`: 遠端 session 識別碼
- `nodeId`: 目標或來源 Node
- `requestId`: 用於追蹤 request/response 關聯；建議所有由 Gateway 主動發出的 request event 都必帶，且 Node 回傳的 `session/output` / `session/error` / `session/end` 應原樣回帶
- `ts`: event 建立時間
- `version`: 協議版本，可作為未來擴充用途

---

## Core Events (v1)

### `session/new`

在指定 Node 上建立新的 coding CLI session。

```text
type: "session/new"
sessionId: string
nodeId: string
cli: "claude-code" | "kiro" | string
workdir: string
env?: Record<string, string>
initialPrompt?: string
```

### `session/prompt`

對既有 session 傳送新的 prompt。

```text
type: "session/prompt"
sessionId: string
nodeId: string
prompt: string
```

### `session/output`

Node 將 CLI 輸出以 streaming 形式回傳。

```text
type: "session/output"
sessionId: string
nodeId: string
chunk: string
done: boolean
stream?: "stdout" | "stderr"
```

### `session/end`

要求結束 session，或回報 session 已結束。

```text
type: "session/end"
sessionId: string
nodeId: string
exitCode?: number
reason?: string
```

### `session/error`

用來承載 protocol、transport、execution error。

```text
type: "session/error"
sessionId: string
nodeId: string
code: string
message: string
retryable?: boolean
details?: unknown
```

---

## Suggested Type Model

```text
RemoteAcpxEvent =
  | SessionNewEvent
  | SessionPromptEvent
  | SessionOutputEvent
  | SessionEndEvent
  | SessionErrorEvent
```

建議使用 discriminated union，讓上層可根據 `type` 安全分流。

---

## Serialization Rules

`events.ts` 應提供：

- `serializeEvent(event)`：將 event 轉成 JSON string
- `parseEvent(raw)`：將 raw input 解析成 `RemoteAcpxEvent`
- `isRemoteAcpxEvent(value)`：驗證是否為合法事件物件
- 各事件的 type guard，例如：
  - `isSessionNewEvent()`
  - `isSessionPromptEvent()`
  - `isSessionOutputEvent()`
  - `isSessionEndEvent()`
  - `isSessionErrorEvent()`

### Validation Rules

至少要驗證：

1. `type` 是否存在且為已知值
2. `sessionId` 是否存在
3. `nodeId` 是否存在
4. 各事件必要欄位是否齊全
5. 欄位型別是否正確

對非法 payload：

- 不應直接崩潰
- 應回傳 `ValidationError` 或 `ProtocolError`

---

## Error Model

`errors.ts` 建議定義：

- `RemoteAcpxError`：所有 SDK error 的基底類別
- `ConnectionError`：WebSocket 連線失敗或非預期中斷
- `TimeoutError`：等待回應超時
- `NodeOfflineError`：目標 Node 不在線或不可用
- `ProtocolError`：收到未知 event type 或違反協議格式
- `ValidationError`：收到欄位缺失或型別不符的 payload

---

## Correlation Helpers (v1.1)

除了基本 event contract，SDK 也應提供 request/response 配對能力，避免同一個 `sessionId` 內多個 prompt 並行時發生 stream 混線。

### Recommended helper surface

```text
createRequestId(prefix?)
ensureRequestId(event)
withRequestId(event, requestId?)
getCorrelationKey(event)
matchesRequest(event, selector)
RequestCorrelator
  - track(request, { timeoutMs? })
  - handle(event)
  - has(requestId)
  - getPending(requestId)
  - clear(reason?)
```

### Expected behavior

- 每筆 outbound request 在送出前都應有唯一 `requestId`
- `RequestCorrelator.track()` 會建立 pending request handle
- `session/output` 會依相同 `requestId` 聚合 streaming chunks
- `session/output(done=true)` 或 `session/end` 會 resolve 該 request
- `session/error` 會 reject 該 request
- timeout / cancel / clear 都應能安全結束 pending request

## Client API (v1)

`client.ts` 應維持 thin wrapper，避免過早封裝商業邏輯。

### Suggested public API

```text
RemoteAcpxClient
- connect()
- send(event)
- on(eventName, handler)
- close()
```

### Event listeners

建議至少支援：

- `open`
- `message`
- `error`
- `close`

---

## Example Message Flow

```text
1. Gateway 建立連線
2. Gateway 發送 `session/new`
3. Node 收到事件後建立本機 CLI session
4. Node 回送多個 `session/output`
5. Gateway 發送 `session/prompt`
6. Node 繼續回送 `session/output`
7. Gateway 或 Node 發送 `session/end`
8. Session 關閉
```

---

## Engineering Boundary

### SDK 負責

- 協議型別
- message codec
- runtime validation
- shared client abstraction

### Node / Gateway 負責

- session lifecycle
- process spawn / kill
- auth / pairing
- reconnect backoff
- routing / registry
- CLI-specific protocol translation

---

## v1 / v2 Scope Split

### v1

- 基本 event 定義
- serialize / parse / validate
- 基本 error classes
- 最小 WebSocket client

### v2

- heartbeat / ping-pong
- request correlation helper
- built-in retry strategy
- auth-aware transport helper
- richer session metadata
- observability / tracing hooks

---

## Verification Plan

開始實作後，至少驗證：

1. 每種 event 都能 round-trip serialize / parse
2. 非法 payload 會正確丟出 validation error
3. `session/new -> session/output -> session/end` smoke flow 可跑通
4. Gateway 與 Node 對同一事件 contract 的理解一致

---

## Open Questions

1. `requestId` 是否在 v1 強制要求
2. `session/end` 是否同時作為 request 與 final notification
3. `session/output` 是否需要 chunk sequence number
4. 是否要在 v1 加入 `session/ready`
5. auth metadata 是否完全留在 transport layer

---

## Recommended Next Step

文件定稿後，再開始建立：

```text
packages/remote-acpx-sdk/src/types.ts
packages/remote-acpx-sdk/src/events.ts
packages/remote-acpx-sdk/src/errors.ts
packages/remote-acpx-sdk/src/client.ts
packages/remote-acpx-sdk/src/index.ts
```
