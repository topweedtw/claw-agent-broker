# Claw Agent Broker — 開發計畫

## 背景說明

本專案 `claw-agent-broker` 是一個 **自訂擴充層（Custom Extensions）**，架設在 OpenClaw Gateway 之上，實現 **跨機器遠端 ACP 任務派發**—讓 AI Agent（LLM + 🦞）能透過 Telegram/Discord 等管道發送高階指令，自動在遠端 Node（Mac Mini、Mini PC）上啟動並管理 coding CLI（Claude Code、Kiro CLI 等）。

根據 `doc/node-delegation-arch.md`，官方 `acpx plugin-sdk` 僅支援本機執行；本專案須從零實作「遠端版本」的五大元件。

---

## 元件清單與完成狀態

| # | 元件 | 類別 | 官方支援 | 完成狀態 |
|---|------|------|----------|----------|
| 1 | `remote-acpx plugin-sdk` | SDK / 型別定義 | ❌ 無 | ✅ MVP 已完成 |
| 2 | `node-host` ACP 事件轉發擴充 | Node 端 WebSocket | ✅ 基底有 | 🔴 未開發 |
| 3 | `gateway` ACP 事件路由擴充 | Gateway 端路由 | ✅ 基底有 | 🔴 未開發 |
| 4 | `remote-acpx plugin` | Agent Tool | ❌ 無 | 🔴 未開發 |
| 5 | `ACP skill` | Agent Skill | ❌ 無 | 🔴 未開發 |

> [!IMPORTANT]
> `remote-acpx-sdk`（Phase 1）已完成 MVP、測試與文件；Phase 2–5 仍待實作與整合。

---

## 架構回顧

```
User (Telegram/Discord)
        │
        ▼
OpenClaw Gateway (Control Plane)
  ├── [官方] Agent / Channel Integration / Session Mgmt
  ├── [自訂元件 3] gateway ext — 將 ACP 事件路由到遠端 Node
  └── [自訂元件 2 的反向] node-host ext — WS relay server

        │ WebSocket（Node 主動外連）
        ▼
OpenClaw Node (Mac Mini / Mini PC)
  ├── [官方] Node connection mgmt
  ├── [自訂元件 2] remote-acpx plugin-sdk — ACP 事件 send/recv
  └── coding CLI (Claude Code / Kiro)
         stdin/stdout ↔ ACP
```

---

## 詳細開發計畫

---

### Phase 1 — SDK 與型別定義（✅ 核心已完成）

#### [NEW] `packages/remote-acpx-sdk/`

**目標**：仿照官方 `acpx plugin-sdk`，定義遠端 ACP 事件的介面、型別、與工廠方法，供後續所有元件共用。

**設計文件**：詳見 `doc/remote-acpx-sdk-design.md`

**目前狀態**：✅ 已完成可用的 MVP foundation，可作為 Phase 2 / Phase 3 的共用基礎。

**已完成內容（截至 2026-04-07）**：

| 項目 | 狀態 |
|------|------|
| `types.ts` | ✅ 已完成基本事件型別與 factory helpers |
| `events.ts` | ✅ 已完成 JSON serialize / parse / validate / type guards |
| `client.ts` | ✅ 已完成基本 WS client 與 connection lifecycle |
| `errors.ts` | ✅ 已完成基礎錯誤型別 |
| `correlation.ts` | ✅ 已完成 `requestId` / `RequestCorrelator` 配對能力 |
| `test/*.test.cjs` | ✅ 已完成 smoke + lifecycle + correlation 測試 |

**驗證結果**：`npm run check` 與 `npm run test` 已通過（目前 19 tests pass, 0 fail）。

**需實作內容**：

| 項目 | 說明 |
|------|------|
| `types.ts` | ACP 事件型別：`SessionNewEvent`、`SessionPromptEvent`、`SessionOutputEvent`、`SessionEndEvent` 等 |
| `events.ts` | 事件 payload 序列化／反序列化（JSON-over-WS） |
| `client.ts` | 遠端 ACP client 介面：`connect()`, `send()`, `on()`, `close()` |
| `errors.ts` | 錯誤型別：連線失敗、逾時、Node 離線等 |
| `index.ts` | 公開 API 匯出 |

**關鍵事件定義**（基於文件推測）：

```typescript
// session/new — 在遠端 Node 建立新的 coding CLI session
interface SessionNewEvent {
  type: 'session/new'
  sessionId: string
  nodeId: string
  cli: 'claude-code' | 'kiro' | string
  workdir: string
  env?: Record<string, string>
}

// session/prompt — 向 session 傳送使用者提示
interface SessionPromptEvent {
  type: 'session/prompt'
  sessionId: string
  nodeId: string
  prompt: string
}

// session/output — Node 回傳 CLI 輸出（streaming）
interface SessionOutputEvent {
  type: 'session/output'
  sessionId: string
  nodeId: string
  chunk: string
  done: boolean
}

// session/end — 結束 session
interface SessionEndEvent {
  type: 'session/end'
  sessionId: string
  nodeId: string
  exitCode?: number
}
```

---

### Phase 2 — Node 端 ACP 轉發擴充

#### [NEW] `packages/node-host-ext/`

**目標**：在 Node 機器上，接收來自 Gateway 的 ACP 事件，並轉送給本機的 coding CLI（stdin），同時將 CLI 輸出（stdout/stderr）回傳給 Gateway。

**傳輸協議**：詳見 `doc/node-gateway-transport-protocol.md`

**需實作內容**：

| 模組 | 說明 |
|------|------|
| `ws-relay.ts` | 與 Gateway 維持 WebSocket 長連線（斷線自動重連）|
| `session-manager.ts` | 管理多個 coding CLI child process（spawn/kill/list）|
| `cli-adapter/claude-code.ts` | Claude Code 的 stdin/stdout ACP 協議 |
| `cli-adapter/kiro.ts` | Kiro CLI 的 stdin/stdout ACP 協議 |
| `event-handler.ts` | 收到 `session/new`→spawn CLI；`session/prompt`→寫 stdin；`session/end`→kill |
| `config.ts` | 讀取 `~/.openclaw/openclaw.json` 的 gateway.remote 設定 |

**重連機制**：

```
Node 啟動
  │
  ├─▶ 連線到 Gateway WS
  │     失敗 → backoff retry (1s → 2s → 4s → max 30s)
  │
  ├─▶ Ed25519 Challenge-Response 認證
  │
  └─▶ 等待 ACP 事件
        session/new    → spawn coding CLI process
        session/prompt → write to CLI stdin
        session/end    → kill CLI process
```

**Session 管理**：

- 每個 Session 對應一個獨立的 child process
- 支援同時多個 session（不同 sessionId）
- process 異常退出時主動通知 Gateway

---

### Phase 3 — Gateway 端 ACP 路由擴充

#### [NEW] `packages/gateway-ext/`

**目標**：在 Gateway 上，將 Agent 發出的 ACP tool call 路由到正確的 Node WebSocket，並將 Node 回傳的事件轉回給 Agent。

**傳輸協議**：詳見 `doc/node-gateway-transport-protocol.md`

**需實作內容**：

| 模組 | 說明 |
|------|------|
| `node-registry.ts` | 維護已連線的 Node 列表（nodeId → WS 連線）|
| `router.ts` | 根據 `nodeId` 路由 ACP 事件到對應 WS |
| `ws-server.ts` | 接受 Node 的 WS 連線（整合 Ed25519 驗證）|
| `event-bridge.ts` | Agent tool call ↔ ACP 事件雙向橋接 |
| `session-tracker.ts` | 追蹤所有進行中的 remote session |

**路由邏輯**：

```
Agent 呼叫 remote-acpx tool
  │
  ▼
gateway-ext event-bridge
  │
  ├─▶ 查詢 node-registry：nodeId 是否在線？
  │     否 → 回傳 error: "node offline"
  │
  ├─▶ 封裝 ACP 事件 → 送到 Node WS
  │
  └─▶ 等待 Node 回傳 session/output
        → streaming 回傳給 Agent
```

**Node 連線管理**：

```
Node 連線到 Gateway
  │
  ├─▶ Gateway Token 驗證（傳輸層）
  ├─▶ Ed25519 Challenge-Response（設備層）
  │
  ├─▶ 已配對 → 加入 node-registry
  └─▶ 未配對 → 1008 "pairing required"
                → 加入 pending list
```

---

### Phase 4 — Agent Tool Plugin

#### [NEW] `packages/remote-acpx-plugin/`

**目標**：實作一個 OpenClaw Plugin，提供 tool 讓 Agent (LLM) 能呼叫，操作遠端 coding CLI session。

**Tool 清單**：

| Tool 名稱 | 對應 ACP 事件 | 說明 |
|-----------|---------------|------|
| `remote_session_new` | `session/new` | 在指定 Node 上建立新的 coding CLI session |
| `remote_session_prompt` | `session/prompt` | 向指定 session 傳送提示 |
| `remote_session_list` | （本地查詢）| 列出所有進行中的遠端 session |
| `remote_session_end` | `session/end` | 結束指定 session |
| `remote_node_list` | `node.list` | 列出所有已連線的 Node |

**Tool Schema 範例**：

```json
{
  "name": "remote_session_new",
  "description": "在指定的遠端 Node 上啟動一個新的 coding CLI session",
  "parameters": {
    "nodeId": {
      "type": "string",
      "description": "目標 Node 的 ID（由 remote_node_list 取得）"
    },
    "cli": {
      "type": "string",
      "enum": ["claude-code", "kiro"],
      "description": "要啟動的 coding CLI"
    },
    "workdir": {
      "type": "string",
      "description": "工作目錄路徑（Node 上的絕對路徑）"
    },
    "initialPrompt": {
      "type": "string",
      "description": "啟動 session 後立即發送的提示（可選）"
    }
  }
}
```

**需實作內容**：

| 模組 | 說明 |
|------|------|
| `plugin.ts` | Plugin 入口，註冊所有 tool |
| `tools/session-new.ts` | `remote_session_new` 實作 |
| `tools/session-prompt.ts` | `remote_session_prompt` 實作 |
| `tools/session-list.ts` | `remote_session_list` 實作 |
| `tools/session-end.ts` | `remote_session_end` 實作 |
| `tools/node-list.ts` | `remote_node_list` 實作 |
| `gateway-client.ts` | 呼叫 gateway-ext 的 HTTP/WS API |

---

### Phase 5 — ACP Skill（Agent 行為教學）

#### [NEW] `skills/remote-acp-skill/`

**目標**：撰寫 Skill 文件（Markdown + YAML frontmatter），教導 Agent 如何使用上述 tool 管理遠端 coding CLI session。

**需實作內容**：

| 檔案 | 說明 |
|------|------|
| `SKILL.md` | 主要 Skill 指令文件 |
| `examples/start-session.md` | 範例：啟動 session、派發任務 |
| `examples/multi-node.md` | 範例：多 Node 並行派工 |
| `examples/error-handling.md` | 範例：Node 離線、session 逾時處理 |

**Skill 核心邏輯（教導 Agent）**：

```markdown
1. 收到使用者需求後，先呼叫 remote_node_list 確認有哪些 Node 在線
2. 根據使用者指定（或自動選擇）合適的 Node
3. 呼叫 remote_session_new 建立 session，指定 CLI 與 workdir
4. 使用 remote_session_prompt 傳送任務描述
5. 等待並 stream 輸出給使用者
6. 任務完成後呼叫 remote_session_end 清理 session
7. 遇到逾時或錯誤時，告知使用者並提供重試選項
```

---

## 專案結構規劃

```
claw-agent-broker/
├── doc/                          # 現有文件
│   ├── node-delegation-arch.md
│   └── nodes.md
│
├── packages/
│   ├── remote-acpx-sdk/          # [Phase 1] 共用 SDK
│   │   ├── src/
│   │   │   ├── types.ts
│   │   │   ├── events.ts
│   │   │   ├── client.ts
│   │   │   ├── errors.ts
│   │   │   ├── correlation.ts
│   │   │   └── index.ts
│   │   ├── test/
│   │   │   ├── events.test.cjs
│   │   │   ├── client.test.cjs
│   │   │   ├── smoke.test.cjs
│   │   │   └── correlation.test.cjs
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── node-host-ext/            # [Phase 2] Node 端 ACP 轉發
│   │   ├── src/
│   │   │   ├── ws-relay.ts
│   │   │   ├── session-manager.ts
│   │   │   ├── event-handler.ts
│   │   │   ├── config.ts
│   │   │   └── cli-adapter/
│   │   │       ├── claude-code.ts
│   │   │       └── kiro.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── gateway-ext/              # [Phase 3] Gateway 端 ACP 路由
│   │   ├── src/
│   │   │   ├── ws-server.ts
│   │   │   ├── node-registry.ts
│   │   │   ├── router.ts
│   │   │   ├── event-bridge.ts
│   │   │   └── session-tracker.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── remote-acpx-plugin/       # [Phase 4] Agent Tool Plugin
│       ├── src/
│       │   ├── plugin.ts
│       │   ├── gateway-client.ts
│       │   └── tools/
│       │       ├── session-new.ts
│       │       ├── session-prompt.ts
│       │       ├── session-list.ts
│       │       ├── session-end.ts
│       │       └── node-list.ts
│       ├── package.json
│       └── tsconfig.json
│
├── skills/
│   └── remote-acp-skill/         # [Phase 5] Agent Skill
│       ├── SKILL.md
│       └── examples/
│           ├── start-session.md
│           ├── multi-node.md
│           └── error-handling.md
│
├── package.json                  # Monorepo root
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

---

## 技術決策

| 項目 | 決策 | 理由 |
|------|------|------|
| 語言 | TypeScript | 與 OpenClaw 生態系一致 |
| 套件管理 | pnpm workspaces | Monorepo 管理，方便跨包依賴 |
| WS 函式庫 | `ws`（Node.js）| 輕量、低依賴 |
| 加密 | Node.js 內建 `crypto`（Ed25519）| 不需額外依賴 |
| 打包 | `tsup` | 簡單快速，支援 ESM + CJS |
| 測試 | `vitest` | 快速，TypeScript 原生支援 |

---

## 開發優先順序與里程碑

```
Week 1-2: Phase 1 (SDK) ✅ 已完成 MVP
  ✦ 定義所有 ACP 事件型別
  ✦ 實作序列化/反序列化與驗證
  ✦ 基礎 WS client 介面與 connection lifecycle
  ✦ 補上 request correlation 與 smoke / unit tests

Week 3-4: Phase 2 (Node Host Ext)
  ✦ WebSocket relay + 重連機制
  ✦ Claude Code CLI adapter
  ✦ Session 管理（spawn/kill）
  ✦ 整合測試（本機模擬）

Week 5-6: Phase 3 (Gateway Ext)
  ✦ Node WS server
  ✦ Ed25519 認證整合
  ✦ ACP 事件路由
  ✦ E2E 測試（真實 Node 連線）

Week 7: Phase 4 (Plugin)
  ✦ 實作所有 tool
  ✦ Plugin 註冊到 Gateway

Week 8: Phase 5 (Skill) + 整合
  ✦ 撰寫 Skill 文件
  ✦ E2E 完整流程測試
  ✦ 文件更新
```

---

## 風險與注意事項

> [!WARNING]
> **OpenClaw 官方 API 不穩定**：目前文件中的已知 Bug 包含 `node.invoke` 間歇性 30 秒超時（#17356）以及配對系統不同步（#6836），設計時須加入足夠的錯誤處理與重試機制。

> [!CAUTION]
> **ACP 協議細節未完整公開**：`stdin/stdout ACP` 協議格式需要逆向工程或實驗確認，可能需要抓包分析 Claude Code / Kiro CLI 的通訊格式。

> [!NOTE]
> **Ed25519 認證**：Node 配對流程需要處理 `pairing required (1008)` 的情況，應實作自動重試與 pending approval 等待機制。

---

## 開放問題（需確認）

1. **ACP 事件格式**：官方 `stdin/stdout ACP` 的具體 JSON schema？是否有文件？
2. **Plugin 安裝方式**：`remote-acpx plugin` 如何掛載到 OpenClaw Gateway？是否有 plugin SDK 文件？
3. **Streaming 輸出**：`session/output` 是否需要 chunked streaming？Agent 端如何展示？
4. **多租戶**：是否需要支援多個使用者各自的 Node pool？
5. **Kiro CLI adapter**：Kiro CLI 的 ACP 協議是否與 Claude Code 相同？

