# `@claw-agent-broker/remote-acpx-sdk`

`remote-acpx-sdk` 是 `claw-agent-broker` 的 **遠端 ACP 共享協議層 SDK**，提供 Gateway 與 Remote Node 共用的事件型別、序列化/反序列化、驗證、連線包裝，以及 request/response 配對能力。

## 功能範圍

此套件目前提供：

- 共用的遠端 ACP event 型別
- JSON serialize / parse helpers
- runtime validation 與 type guards
- 輕量的 WebSocket client wrapper
- `requestId` / `RequestCorrelator` 配對能力

此套件目前 **不包含**：

- Claude Code / Kiro CLI adapter
- session manager
- gateway routing logic
- auth / pairing policy
- node process lifecycle 管理

---

## 目錄結構

```text
src/
  index.ts
  types.ts
  events.ts
  errors.ts
  client.ts
  correlation.ts

test/
  events.test.cjs
  client.test.cjs
  smoke.test.cjs
  correlation.test.cjs
```

---

## 模組說明

### `types.ts`
定義所有遠端 ACP 事件型別，例如：

- `SessionNewEvent`
- `SessionPromptEvent`
- `SessionOutputEvent`
- `SessionEndEvent`
- `SessionErrorEvent`

### `events.ts`
提供：

- `serializeEvent()`
- `parseEvent()`
- `assertRemoteAcpxEvent()`
- 各事件 type guards

### `errors.ts`
定義 SDK 內的錯誤類型，例如：

- `ConnectionError`
- `TimeoutError`
- `ProtocolError`
- `ValidationError`
- `NodeOfflineError`
- `RequestCorrelationError`

### `client.ts`
提供 `RemoteAcpxClient`，目前支援：

- `connect()`
- `send()`
- `on('open' | 'message' | 'error' | 'close')`
- `close()`

### `correlation.ts`
提供 request/response 配對工具：

- `createRequestId()`
- `ensureRequestId()`
- `withRequestId()`
- `getCorrelationKey()`
- `matchesRequest()`
- `RequestCorrelator`

---

## 典型使用流程

```text
Gateway 建立 request event
  -> 補上 requestId
  -> 送到 Remote Node
  -> Node 回傳 session/output / session/error / session/end
  -> SDK 依 requestId 做配對與聚合
```

---

## Request Correlation 範例

```ts
import {
  RequestCorrelator,
  createSessionPromptEvent,
  ensureRequestId,
} from './src/index.js'

const correlator = new RequestCorrelator({ timeoutMs: 30_000 })

const request = ensureRequestId(
  createSessionPromptEvent({
    sessionId: 'session-1',
    nodeId: 'node-a',
    prompt: 'continue working',
  }),
)

const pending = correlator.track(request)

// 後續收到遠端事件時：
correlator.handle({
  type: 'session/output',
  sessionId: 'session-1',
  nodeId: 'node-a',
  requestId: request.requestId,
  chunk: 'done',
  done: true,
})

const result = await pending.waitForCompletion()
console.log(result.finalEvent.type)
```

---

## 本機開發

在套件目錄下可使用：

```bash
npm install
npm run check
npm run test
npm run build
```

目前已驗證：

- TypeScript 檢查可通過
- 單元測試與 smoke test 可通過

---

## 目前狀態

**Phase 1 — SDK 與型別定義：已完成 MVP foundation**

目前已能支撐後續：

- `node-host-ext`
- `gateway-ext`
- `remote-acpx-plugin`

進一步整合時，建議優先接入真實 WebSocket transport 與 Gateway/Node event bridge。
