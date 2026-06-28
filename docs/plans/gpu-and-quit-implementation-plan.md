# GPU無効化 & アプリ終了機能 実装計画書

バージョン: v1.2.0  
作成日: 2026-06-27  
更新日: 2026-06-27（ユーザー判断確定 + QuitCoordinator設計反映）  
対象環境: WSL2 + WSLg (開発), Linux ARM/x64 (本番キオスク)

---

## 0. 改訂履歴（アーキテクトレビュー反映 v1.1.0）

| # | 重大度 | 指摘 | 対応 |
|---|--------|------|------|
| C1 | CRITICAL | 2段階確認状態がパネル閉→再開でリセットされず、確認状態のまま再表示すると1タップ即終了が成立。§B2-5 スニペットに reset 処理が無く §B3-04 の記述と矛盾 | §B2-5 に `resetQuitConfirm()` を追加し openPanel() 冒頭・close-btn・quitApp() 送信後で呼ぶ。§B3 / §B3-04 と整合 |
| C2 | CRITICAL | `validateSender` は URL 文字列照合のみで WebContents インスタンス同一性を検証していない。`file:///evil/settings/x.html` 等の path に `/settings/` を含む偽 URL が通り得る。「任意レンダラから app.quit() を呼べない」の前提が文字列照合だけでは不成立 | §B2-1 に WebContents id 同一性検証（`settingsWebContentsId`）を追加。さらに信頼境界の前提（siteView は preload 無 = ipcRenderer 不到達）を明文化し、spoof 境界テスト B2-06/B2-07 を追加 |
| C3 | CRITICAL | §B4「クリーンアップは確実に走る」と §5「`void watcher.stop()` は非同期失敗の可能性あり」が矛盾（guaranteed vs best-effort のサイレント障害） | §B4 を「同期クリーンアップは確実／非同期 watcher.stop() は best-effort」に明確化。§5 と整合。uncaughtException→relaunch 相互作用も明記 |
| I1〜I6 | INFORMATIONAL | GPU ブロック配置精度・GPU 有効性の [M] 検証欠落・WSL ソフトウェアデコード注記・@keyframes 未定義・Ctrl+Q operator-only・B1 テストの accelerator フィルタ | 各節および §7 [M] 検証、§確定事項(ユーザー判断済) に反映 |
| U1 | 確定 | Ctrl+Q = 有効・確認あり（即終了ではなく同じ2段階確認を経由、Wayland スキップは既存 Ctrl+L と同一） | §B1 更新 |
| U2 | 確定 | 終了確認 = インライン2段階（モーダルなし）。確認状態とタイマーは main プロセス（QuitCoordinator）に集約。renderer は薄い表示のみ | §B2/B3 全面更新、新規 quit-coordinator.ts 追加 |
| U3 | 確定 | テスト範囲 = ユニット（QuitCoordinator 含む）＋ E2E スケルトン（test.fixme）を今回作る | §4-B0 追加、§4-B3 更新 |

---

## 1. 概要 / 目的

### 1.1 修正A: GPU ハードウェアアクセラレーション無効化

WSL2+WSLg 環境では、Electron の GPU プロセスが初期化に失敗する。
その結果 WebContentsView の上位レイヤー (z:1 addressBarView) が描画されず、
アドレスバーの入力フォームが表示されない。

`app.disableHardwareAcceleration()` を **WSL 検出時のみ** アプリ起動前に呼ぶことで
GPU エラーを回避する。本番キオスク（Linux ARM/x64）では GPU を使うため
**無条件無効化は禁止**。

### 1.2 修正B: アプリ内終了機能

現行コードにはアプリ終了手段が一切ない（globalShortcut は Ctrl+G と Ctrl+L のみ）。
WSLg/Wayland では globalShortcut が発火しないことがあるため、
確実性の高い経路（設定パネルの終了ボタン）を主軸とし、
Ctrl+Q ショートカットはベストエフォートの補助手段とする。

---

## 2. 機能一覧と各機能の仕様

### 修正A: WSL検出 + GPU 無効化

#### A-1. shouldDisableGpu 純関数 (`src/main/wsl-detect.ts` 新規)

```typescript
interface ShouldDisableGpuOptions {
  /** process.env 相当。テストでは任意のオブジェクトを注入可能 */
  env: Record<string, string | undefined>
  /**
   * /proc/version の内容。読み取り失敗時は null を渡す。
   * null の場合は env チェックのみで判定する（false 側に倒す）
   */
  procVersion: string | null
}

function shouldDisableGpu(options: ShouldDisableGpuOptions): boolean
```

**無効化条件（いずれかを満たせば true）:**
| 優先 | 条件 | 判定内容 |
|------|------|----------|
| 最高 | `env.ENABLE_GPU === '1'` | **即 false を返す（脱出口）** |
| 1 | `env.DISABLE_GPU === '1'` | 強制無効化 |
| 2 | `procVersion` が `'microsoft'` を含む（toLowerCase比較） | WSL2 Linux カーネル |
| 3 | `env.WSL_DISTRO_NAME` が非空文字列 | WSL ディストリビューション名 |
| 4 | `env.WSLENV` が非空文字列 | WSL 環境変数ブリッジ |
| default | 上記いずれも非該当 | false（GPU 有効） |

**例外時の方針:**
- `/proc/version` 読み取り失敗（ENOENT / EACCES）→ 呼び出し元で `null` に変換して渡す
- `shouldDisableGpu` 自体は純関数のため例外をスローしない

#### A-2. index.ts での呼び出し

**配置位置（I3 反映）**: `src/main/index.ts` の **シングルインスタンスガード
（`requestSingleInstanceLock()` の `if (!gotLock) { app.quit(); process.exit(0) }`、現状 L68-73）の直後**、
かつ `protocol.registerSchemesAsPrivileged`（L132）・`app.whenReady()`（L169）より前に置く。

- ガード**直後**に置く理由: 2 番目のインスタンス（`!gotLock` で即 `process.exit(0)`）でも
  `/proc/version` 読取・`disableHardwareAcceleration` が走るのは無害だが冗長。
  ガード通過後に限定することで終了予定プロセスでの不要 I/O を避ける。
- `app.whenReady()` より前である制約は不変（ready 後に呼ぶと無効）。
- `logWarn` は関数宣言（L83）のためホイストされ、この位置から呼び出し可能。

```typescript
// WSL 検出 → GPU 無効化（app.ready 前に必須 / シングルインスタンスガード直後）
let procVersion: string | null = null
try {
  procVersion = fs.readFileSync('/proc/version', 'utf-8')
} catch {
  logWarn('gpu.procVersionReadFailed', { reason: 'cannot read /proc/version' })
}

if (shouldDisableGpu({ env: process.env, procVersion })) {
  app.disableHardwareAcceleration()
  logWarn('gpu.hardwareAccelerationDisabled', { reason: 'WSL detected' })
}
```

**ENABLE_GPU=1 の脱出口**: WSLg でも GPU を試したい場合に使用可能。
ただし GPU 初期化失敗時の挙動は環境依存であり動作保証外。

**副作用の注記（I2 反映）**: `disableHardwareAcceleration()` は overlayView の動画デコード／合成も
ソフトウェア処理に落とす。**WSL 開発環境では動画再生の CPU 負荷増・カクつきが起こり得る**。
開発用途では許容だが「**開発時の動画性能は本番（GPU 維持）を反映しない**」点に留意する。
本番キオスク（Linux ARM/x64）は無効化条件に該当しないため GPU 維持され影響なし。

---

### 修正B1: Ctrl+Q ショートカット（ベストエフォート）

`src/main/input-coordinator.ts` に `registerQuitShortcut()` / `unregisterQuitShortcut()` を追加する。
既存の Ctrl+G / Ctrl+L の実装パターンを完全に踏襲する。

**インターフェース追加:**
```typescript
export interface InputCoordinatorOptions {
  // ...既存フィールド...
  /** app.quit() 相当のコールバック（未定義 = no-op） */
  onQuit?: () => void
}
```

**追加フィールド:**
```typescript
private readonly onQuit?: () => void
private quitShortcutRegistered = false
```

**registerQuitShortcut() 仕様:**
- Wayland (`isWayland=true`) → `warn('input.shortcutSkipped', {reason:'wayland', accelerator:'Control+Q'})` + return
- 二重登録防止: `quitShortcutRegistered` が true なら no-op
- `globalShortcut.register('Control+Q', () => { this.onQuit?.() })`
- 失敗時: `warn('input.shortcutRegisterFailed', {accelerator:'Control+Q'})`

**unregisterQuitShortcut() 仕様:**
- 未登録なら no-op
- `globalShortcut.unregister('Control+Q')` + `quitShortcutRegistered = false`

**確認あり（U1 反映）**: Ctrl+Q は即終了ではなく `quitCoordinator.requestQuit()` を経由し、
設定パネル終了ボタンと同じ2段階確認（armed → 3秒タイムアウト or 再押しで確定）を通る。
Wayland 時のスキップ方針は既存 Ctrl+G / Ctrl+L と同一。
X11 / 本番では有効だが、WSLg/Wayland では効かない可能性が高い（best-effort）。
隅3タップ→設定パネル→終了ボタンが確実な経路。

**index.ts での結線:**
```typescript
// InputCoordinatorOptions に追加（QuitCoordinator 経由 ― 即 app.quit() ではない）
onQuit: () => { quitCoordinator.requestQuit() }

// 登録
inputCoordinator.registerQuitShortcut()

// will-quit クリーンアップ
app.on('will-quit', () => {
  inputCoordinator.unregisterShortcut()
  inputCoordinator.unregisterAddressBarShortcut()
  inputCoordinator.unregisterQuitShortcut()  // ← 追加
  void watcher.stop()
  orchestrator.dispose()
})
```

---

### 新規: src/main/quit-coordinator.ts（確認状態の単一真実源 / U2 反映）

Ctrl+Q と設定パネル終了ボタンの両方が同じ armed 状態を共有するため、
確認状態と3秒タイマーは renderer ではなく **main プロセス**に集約する。

#### クラス設計（DI でユニットテスト可能）

```typescript
interface QuitCoordinatorDeps {
  /** app.quit() 相当 */
  quit: () => void
  /** armed 状態変化時のコールバック（true=armed, false=disarmed） */
  onArmedChange: (armed: boolean) => void
  setTimeoutFn: typeof setTimeout
  clearTimeoutFn: typeof clearTimeout
  /** 確認ウィンドウ（ms）。デフォルト 3000 */
  confirmWindowMs?: number
}

class QuitCoordinator {
  constructor(deps: QuitCoordinatorDeps)
  /**
   * armed=false → armed=true にし3秒タイマー開始、onArmedChange(true) 呼び出し。
   * armed=true → タイマー解除し quit() 呼び出し（確定終了）。
   * タイマーリークなし: 既存タイマーがあれば冒頭で必ず解除してから再設定。
   */
  requestQuit(): void
  /** タイマー解除・armed=false・onArmedChange(false) 呼び出し */
  disarm(): void
}
```

**不変条件:**
- タイマーは常に最大1本（既存タイマーがあれば `requestQuit()` 冒頭で解除してから再開始）
- `disarm()` は armed=false 状態でも呼べる（no-op / エラーなし、onArmedChange は不要な場合呼ばない）
- 3秒タイムアウト → 自動 `disarm()`（`onArmedChange(false)` 呼び出し）

#### index.ts 結線（QuitCoordinator）

```typescript
const quitCoordinator = new QuitCoordinator({
  quit: () => app.quit(),
  onArmedChange: (armed) => {
    if (armed) openSettings()   // armed=true で設定パネルを必ず開く（Ctrl+Q でも armed 表示が見える）
    settingsView.webContents.send('app:quit-armed', armed)
  },
  setTimeoutFn: setTimeout,
  clearTimeoutFn: clearTimeout,
  // confirmWindowMs: 3000  // デフォルト値
})

// closeSettings() に disarm を追加（C1: パネルを閉じたら確認状態を必ずリセット）
// 既存の closeSettings() 末尾に追加:
//   quitCoordinator.disarm()
```

**C1 の解法（旧設計から変更）**: renderer 側の `resetQuitConfirm()` 方式を廃止し、
`closeSettings()`（index.ts）で `quitCoordinator.disarm()` を呼ぶ方式に統一する。
確認状態は main が保持するため、renderer の DOM 再初期化・タイマー解除なしでも disarm が確実に働く。
disarm 後に `onArmedChange(false)` → `app:quit-armed`(false) push → renderer ボタンが自動で初期状態に戻る。

---

### 修正B2: 設定パネル終了ボタン（確実な経路）

フロー: 設定パネル → 終了ボタン click → preload quitApp() → IPC 'app:request-quit' → main quitCoordinator.requestQuit() → onArmedChange → push 'app:quit-armed' → renderer ボタン表示更新

#### B2-1. ipc.ts — 'app:request-quit' ハンドラ追加（信頼境界強化込み・C2 反映）

##### 信頼境界の前提（明文化・C2 反映）

既存 `validateSender` は `event.senderFrame.url` の **オリジン（proto/host）＋パス文字列**を
照合するのみで、**WebContents インスタンスの同一性は検証していない**。
したがって単独では「URL に `/settings/` を含む別レンダラ（例: `file:///evil/settings/x.html`）」を
原理的に弾けない。

このアプリで「任意レンダラから `app:request-quit` を送れない」ことを支える**実質的な不変条件**は以下:

1. **siteView（唯一 外部 URL を読むビュー）は preload を持たない**
   （`index.ts` L296-303: `webPreferences` に `preload` 無し）。
   → `ipcRenderer` 自体に到達できず、`app:request-quit` を **送信する手段が存在しない**。
2. 他ビュー（overlay / settings / hotspot / addressbar）は**アプリ同梱のローカルファイル**のみをロードする。

この不変条件は **load-bearing なセキュリティ前提**であり、将来 siteView に preload を付与する／
外部コンテンツへ ipcRenderer を露出する変更を入れる場合は本ハンドラの安全性が崩れる旨を
コードコメントに明記する。

##### 追加防御: WebContents id 同一性検証（C2 反映）

`app:request-quit` は不可逆・高影響な操作のため、URL 照合に加えて**送信元 WebContents が
実際の settingsView か**をインスタンス id で検証する（多層防御 / defense-in-depth）。

`IpcEvent` を後方互換に拡張（`sender` は optional のため既存テスト・既存チャネルに影響なし）:
```typescript
export interface IpcEvent {
  senderFrame: { url: string } | null
  /** 送信元 WebContents の最小情報（id 同一性検証用 / 省略時はスキップ） */
  sender?: { id: number }
}
```

`RegisterHandlersDeps` に追加:
```typescript
/** quitCoordinator.requestQuit() 相当のコールバック（省略可） */
onRequestQuit?: () => void
/**
 * settingsView の実 WebContents id（app:request-quit の sender 同一性検証用 / 省略可）。
 * 指定時は event.sender.id と一致しない送信を拒否する。省略時は URL 照合のみ。
 */
settingsWebContentsId?: number
```

ハンドラ登録:
```typescript
ipcMain.on('app:request-quit', (event) => {
  // 第1層: URL オリジン＋パス照合（既存 validateSender）
  if (!validateSender(event, 'settings', 'app:request-quit', logger)) return
  // 第2層: WebContents インスタンス id 同一性（settingsWebContentsId 指定時のみ）
  if (
    settingsWebContentsId !== undefined &&
    event.sender?.id !== settingsWebContentsId
  ) {
    logger.error('ipc.invalidSender', {
      event: 'ipc.invalidSender',
      channel: 'app:request-quit',
      reason: 'webContents id mismatch',
      expectedId: settingsWebContentsId,
      actualId: event.sender?.id,
    })
    return
  }
  if (!onRequestQuit) {
    logger.warn('ipc.quitCallbackNotSet', { event: 'ipc.quitCallbackNotSet' })
    return
  }
  onRequestQuit()
})
```

- sender は `settings` View のみ許可（validateSender 既存パターン）＋ id 同一性
- `onRequestQuit` 未定義時は WARN ログを出して no-op（サイレント障害を避ける）

##### index.ts での結線（C2 反映）

`registerHandlers({ ... })` に以下を追加する:
```typescript
onRequestQuit: () => { quitCoordinator.requestQuit() },
settingsWebContentsId: settingsView.webContents.id,
```

`settingsWebContentsProxy`（既存 L639）は `WebContentsLike` の薄いプロキシであり
`event.sender` 比較には使えないため、**実 `settingsView.webContents.id` を別途渡す**。

#### B2-2. preload/settings.ts — quitApp() / onQuitArmed() 追加

`contextBridge.exposeInMainWorld('settingsApi', {...})` に追加:
```typescript
/** アプリを終了する（app:request-quit IPC 送信）。毎クリック送信、renderer は状態を持たない */
quitApp: (): void => { ipcRenderer.send('app:request-quit') },
/** armed 状態変化を受信するリスナー登録（app:quit-armed push チャネル）。renderer ボタン表示の同期に使用 */
onQuitArmed: (cb: (armed: boolean) => void): void => {
  ipcRenderer.on('app:quit-armed', (_event, armed: boolean) => cb(armed))
}
```

#### B2-3. renderer/settings/index.html — 終了ボタン追加

`panel-footer` に終了ボタンを追加（test-play-btn と同じフッター内）:
```html
<!-- 終了ボタン（2段階確認: 1クリック目→確認状態, 2クリック目→実行） -->
<button id="quit-btn" class="quit-btn">終了</button>
```

#### B2-4. renderer/settings/styles.css — quit-btn スタイル追加

```css
/* 終了ボタン: 赤系（操作の重大さを視覚的に伝える） */
.quit-btn {
  padding: 10px 24px;
  background: transparent;
  border: 1px solid rgba(239, 68, 68, 0.5);
  border-radius: 9px;
  color: rgba(239, 68, 68, 0.8);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.quit-btn:hover {
  background: rgba(239, 68, 68, 0.12);
  border-color: #ef4444;
  color: #ef4444;
}

/* 2段階確認: 1クリック目後の「確認」状態 */
.quit-btn--confirm {
  background: rgba(239, 68, 68, 0.2);
  border-color: #ef4444;
  color: #fff;
  animation: quit-pulse 0.3s ease;
}

/* I5 反映: 参照している @keyframes を定義する（未定義だと無音でアニメ無効）。
   CSP style-src 'self' でも styles.css 内の keyframes は許可される。 */
@keyframes quit-pulse {
  0%   { transform: scale(1); }
  50%  { transform: scale(1.04); }
  100% { transform: scale(1); }
}
```

#### B2-5. renderer/settings/main.ts — 終了ボタン配線（薄い表示層 / U2 反映）

renderer は確認状態もタイマーも持たない。ボタンクリックのたびに `app:request-quit` を送信し、
main から push された `app:quit-armed` イベントで表示を同期するだけ（**単一真実源は main の QuitCoordinator**）。

```typescript
const quitBtn = getEl<HTMLButtonElement>('#quit-btn')

// ボタンクリック → 毎回 app:request-quit 送信
// 1クリック目: main が arm → app:quit-armed(true) push で表示更新
// 2クリック目: main が確定終了 (app.quit())
quitBtn.addEventListener('click', () => {
  window.settingsApi.quitApp()
})

// main からの armed 状態変化を受信 → ボタン表示を同期
window.settingsApi.onQuitArmed((armed: boolean) => {
  if (armed) {
    quitBtn.textContent = 'もう一度押すと終了'
    quitBtn.classList.add('quit-btn--confirm')
  } else {
    quitBtn.textContent = '終了'
    quitBtn.classList.remove('quit-btn--confirm')
  }
})
```

**C1 の解法（旧設計から変更）**: renderer が `resetQuitConfirm()` を呼ぶ方式を廃止。
`closeSettings()`（index.ts）で `quitCoordinator.disarm()` を呼ぶことで確認状態をリセットする。
main が状態を持つため、renderer の DOM 再初期化・タイマー解除なしでも確実に disarm が働く。
disarm 後に `onArmedChange(false)` → `app:quit-armed`(false) push → ボタン表示が自動で初期状態に戻る。
openPanel() や close-btn への `resetQuitConfirm()` 追加も不要となる。

`SettingsWindowApi` インターフェースに `quitApp: () => void` と
`onQuitArmed: (cb: (armed: boolean) => void) => void` を追加し、
`window.settingsApi.quitApp()` / `window.settingsApi.onQuitArmed()` を直接呼ぶ（SettingsController 非経由）。

---

### 修正B3: 2段階確認の設計理由（U2 反映）

キオスク用途のため誤操作での終了を防ぐ。確認状態は **main プロセス（QuitCoordinator）が単一真実源**として保持する。
- 1クリック目（renderer → main `app:request-quit`）: main が armed=true にし、`app:quit-armed`(true) push → ボタンが「もう一度押すと終了」状態に変わり、3秒タイマー開始
- 3秒以内に2クリック目（renderer → main `app:request-quit`）: main が `app.quit()` を呼び実際に終了
- 3秒後（タイムアウト）: main が自動 disarm し `app:quit-armed`(false) push → ボタンが初期状態に戻る（誤タップのリカバリ）
- **パネルを閉じた場合: `closeSettings()`（index.ts）が `quitCoordinator.disarm()` を呼ぶ**（C1）。`app:quit-armed`(false) push → ボタンが初期状態で再表示。1タップ即終了を防ぐ
- Ctrl+Q も同じ `quitCoordinator.requestQuit()` を経由するため同一の確認フローを辿る
- 確認状態とタイマーは main が保持、renderer は `app:quit-armed` push で表示を同期するだけ
- IPC は毎クリック `app:request-quit` を送信、push は `app:quit-armed` の2本のみ

---

### 修正B4: 既存クリーンアップの確認

**現状の before-quit / will-quit の流れ:**
```
app.quit() → before-quit: globalShortcut.unregisterAll() + powerSaveBlocker.stop()
           → win.close() → window-all-closed → app.quit() (no-op, 終了済み)
           → will-quit: unregisterShortcut/AddressBar + watcher.stop() + orchestrator.dispose()
```

**判定（C3 反映・guaranteed と best-effort を明確に区別する）:**

正規の `app.quit()` 経路で走るクリーンアップは、**同期処理と非同期処理で保証レベルが異なる**。
「確実に走る（guaranteed）」と「best-effort」を混同しない。

| クリーンアップ | 種別 | 保証レベル |
|----------------|------|-----------|
| `globalShortcut.unregisterAll()`（before-quit L178） | 同期 | **確実**（同期完走） |
| `powerSaveBlocker.stop()`（before-quit L179-182） | 同期 | **確実**（同期完走） |
| `inputCoordinator.unregisterShortcut/AddressBar/Quit()`（will-quit） | 同期 | **確実**（同期完走） |
| `orchestrator.dispose()`（will-quit L845, clearTimeout/clearInterval のみ） | 同期 | **確実**（同期完走） |
| `void watcher.stop()`（will-quit L844） | 非同期・**fire-and-forget** | **best-effort**（await しない） |

- **同期クリーンアップは確実に完走する**（プロセス終了前に同期実行されるため）。
- `void watcher.stop()` は **意図的に await しない fire-and-forget**。Promise の拒否は
  `process.on('unhandledRejection')`（L100-104）でログ化されるが、**停止完了は待たれない**ため
  ファイルウォッチャー停止が不完全になり得る。影響は軽微（プロセス終了で OS が fd を回収）。
  → 「確実に走る」とは表現せず **best-effort** と明記する（§5 と整合）。

**CRITICAL 相互作用の注記（uncaughtException → relaunch）:**
`process.on('uncaughtException')`（L90-98）は `app.relaunch() + app.quit()` を呼ぶ。
**もし将来 before-quit / will-quit のハンドラが「同期的にスロー」すると、ユーザーの意図的終了が
`relaunch`（再起動）に化け、終了機能の中核保証が覆る**。
- 現状の `orchestrator.dispose()`（clearTimeout/clearInterval のみ）・各 unregister・
  `void watcher.stop()`（拒否は非同期で unhandledRejection 行き）は**同期スローしない**ため、
  現時点では relaunch へ化けない。
- 将来 dispose/stop に同期スローし得る処理を追加する場合は、ハンドラ内を try/catch で囲み
  同期例外を握り込む（ただしサイレント握り潰しは禁止＝必ず logError する）必要がある旨を注記する。

**既知の制約 (best-effort):**
- `void watcher.stop()` の非同期エラーは unhandledRejection でログ化されるが停止完了は待たれない。
- 親プロセスが SIGKILL で殺された場合は全クリーンアップがスキップされる。OS レベルの制約で回避不可。

---

## 3. 変更対象ファイル一覧

### 新規ファイル

| ファイル | 役割 |
|----------|------|
| `src/main/wsl-detect.ts` | `shouldDisableGpu()` 純関数（DI可能、テスト対象） |
| `src/main/quit-coordinator.ts` | `QuitCoordinator` クラス（確認状態・タイマー集約・DI でユニットテスト可能） |
| `test/unit/wsl-detect.test.ts` | shouldDisableGpu のユニットテスト |
| `test/unit/quit-coordinator.test.ts` | QuitCoordinator のユニットテスト（§4-B0） |

### 変更ファイル

| ファイル | 変更内容 |
|----------|----------|
| `src/main/index.ts` | シングルインスタンスガード直後に `/proc/version` 読込 + shouldDisableGpu + disableHardwareAcceleration / QuitCoordinator インスタンス化・結線（onArmedChange で openSettings + push / closeSettings に disarm 追加）/ registerQuitShortcut（onQuit: quitCoordinator.requestQuit）/ will-quit に unregisterQuitShortcut 追加 / registerHandlers に `onRequestQuit` + `settingsWebContentsId` を渡す |
| `src/main/input-coordinator.ts` | `onQuit` フィールド追加 / `registerQuitShortcut()` / `unregisterQuitShortcut()` 追加 |
| `src/main/ipc.ts` | `IpcEvent.sender?` 追加（C2）/ `RegisterHandlersDeps.onRequestQuit` + `settingsWebContentsId?` 追加 / `ipcMain.on('app:request-quit', ...)` ハンドラ（URL + id 二層検証）追加 |
| `src/preload/settings.ts` | `contextBridge` に `quitApp()`（`app:request-quit` 送信）と `onQuitArmed(cb)`（`app:quit-armed` 受信）を追加 |
| `src/renderer/settings/index.html` | `panel-footer` に `#quit-btn` ボタン追加 |
| `src/renderer/settings/styles.css` | `.quit-btn` / `.quit-btn--confirm` / `@keyframes quit-pulse` スタイル追加 |
| `src/renderer/settings/main.ts` | `SettingsWindowApi` に `quitApp` / `onQuitArmed` 追加 / `#quit-btn` シンプルクリックハンドラ（毎回 quitApp()）/ `onQuitArmed` リスナーでボタン表示同期（独自タイマー・独自状態なし） |
| `test/unit/input-coordinator.test.ts` | Ctrl+Q 登録/解除/Wayland/コールバックのテスト追加 |
| `test/unit/ipc.test.ts` | `app:request-quit` 正常/不正sender/onRequestQuit未定義 のテスト追加 |

---

## 4. テストケース一覧

### 4-A. shouldDisableGpu（`test/unit/wsl-detect.test.ts`）

#### 正常系

| ID | 条件 | 期待値 |
|----|------|--------|
| A-01 | procVersion = 'Linux version ... microsoft ...' | true |
| A-02 | env.WSL_DISTRO_NAME = 'Ubuntu' | true |
| A-03 | env.WSLENV = 'USERPROFILE/p' | true |
| A-04 | env.DISABLE_GPU = '1' | true |
| A-05 | 上記いずれも非該当 | false |
| A-06 | env.ENABLE_GPU = '1' かつ procVersion に 'microsoft' を含む | **false（脱出口が優先）** |
| A-07 | env.ENABLE_GPU = '1' かつ WSL_DISTRO_NAME あり | **false（脱出口が優先）** |
| A-08 | env.ENABLE_GPU = '1' かつ DISABLE_GPU = '1' | **false（脱出口が優先）** |

#### 異常系 / エッジケース

| ID | 条件 | 期待値 |
|----|------|--------|
| A-09 | procVersion = null（読み取り失敗） + env 非該当 | false |
| A-10 | procVersion = null + WSL_DISTRO_NAME あり | true（env だけで判定） |
| A-11 | procVersion = 'Linux version ... MICROSOFT ...'（大文字） | true（toLowerCase 比較） |
| A-12 | procVersion = ''（空文字） | false（'microsoft' を含まない） |
| A-13 | env.WSL_DISTRO_NAME = ''（空文字） | false（空文字は非該当） |
| A-14 | env.WSLENV = ''（空文字） | false（空文字は非該当） |
| A-15 | env.DISABLE_GPU = '0'（'1' 以外） | false |
| A-16 | env.ENABLE_GPU = '0' かつ WSL_DISTRO_NAME あり | true（脱出口は '1' のみ） |

---

### 4-B0. QuitCoordinator（`test/unit/quit-coordinator.test.ts`）

vi.useFakeTimers() で依存注入（setTimeoutFn/clearTimeoutFn）を使い、タイマーリークなしを純粋に検証する。

| ID | シナリオ | 期待挙動 |
|----|----------|---------|
| B0-01 | armed=false で requestQuit() | armed=true に遷移、onArmedChange(true) 1回呼ばれる、タイマー開始 |
| B0-02 | armed=true で requestQuit() | clearTimeoutFn 呼ばれる、quit() が1回呼ばれる |
| B0-03 | requestQuit() 後に confirmWindowMs 経過 | onArmedChange(false) 呼ばれる、armed=false（自動 disarm） |
| B0-04 | requestQuit() 後に disarm() | clearTimeoutFn 呼ばれる、armed=false、onArmedChange(false) 呼ばれる |
| B0-05 | requestQuit() 2回連続（タイムアウト前） | 2回目で quit() 呼ばれる、clearTimeoutFn は各 requestQuit() 冒頭で呼ばれタイマーリークなし |
| B0-06 | requestQuit() → タイムアウト → requestQuit() | 2サイクル目: 再び armed=true（onArmedChange(true) 呼ばれる）、quit() は呼ばれない |
| B0-07 | disarm() を armed=false 状態で呼ぶ | no-op、エラーなし、quit() / onArmedChange は呼ばれない |
| B0-08 | confirmWindowMs=500 のカスタム指定 | 499ms 経過では disarm されない、500ms で disarm される |

---

### 4-B1. InputCoordinator Ctrl+Q（`test/unit/input-coordinator.test.ts`）

#### registerQuitShortcut

| ID | 条件 | 期待値 |
|----|------|--------|
| B1-01 | isWayland=false, 登録成功 | quitShortcutRegistered=true, register('Control+Q')呼ばれる |
| B1-02 | isWayland=true | register呼ばれない, WARN('input.shortcutSkipped', {reason:'wayland', accelerator:'Control+Q'}) |
| B1-03 | globalShortcut.register が false を返す | WARN('input.shortcutRegisterFailed', {accelerator:'Control+Q'}), quitShortcutRegistered=false |
| B1-04 | registerQuitShortcut() を2回呼ぶ | register は1回のみ呼ばれる（二重登録防止） |

#### unregisterQuitShortcut

| ID | 条件 | 期待値 |
|----|------|--------|
| B1-05 | 登録済みの場合 | unregister('Control+Q') 呼ばれる, quitShortcutRegistered=false |
| B1-06 | 未登録の場合 | unregister 呼ばれない（no-op） |

#### コールバック

| ID | 条件 | 期待値 |
|----|------|--------|
| B1-07 | Ctrl+Q 発火（コールバック呼び出し） | onQuit() が1回呼ばれる |
| B1-08 | onQuit 未定義の場合に Ctrl+Q 発火 | エラーなし（no-op） |

**テスト実装メモ（I6 反映）**: 既存ヘルパー `getRegisteredCallback()`（input-coordinator.test.ts
L53-64）は `mockShortcutRegister.mock.calls[0]` 固定で **Ctrl+G 前提**。B1 テストで Ctrl+Q の
コールバックを取得する際は `calls[0]` を使わず、`mock.calls.find(c => c[0] === 'Control+Q')` で
**accelerator でフィルタ**して該当コールバック（`c[1]`）を取得すること。
registerShortcut/registerAddressBarShortcut/registerQuitShortcut が同一モック register を共有するため、
呼び出し順依存のインデックス参照は壊れやすい。

---

### 4-B2. IPC 'app:request-quit'（`test/unit/ipc.test.ts`）

| ID | 条件 | 期待値 |
|----|------|--------|
| B2-01 | settings View から呼ばれる（URL 正・id 一致） | onRequestQuit() が1回呼ばれる |
| B2-02 | overlay View から呼ばれる（不正sender） | onRequestQuit() 呼ばれない, ERROR('ipc.invalidSender') |
| B2-03 | senderFrame = null | onRequestQuit() 呼ばれない, ERROR('ipc.invalidSender') |
| B2-04 | onRequestQuit が未定義（settingsWebContentsId 未指定 or 一致） | onRequestQuit呼ばれない, WARN('ipc.quitCallbackNotSet') |
| B2-05 | app:request-quit を2回連続で呼ぶ | onRequestQuit() が2回呼ばれる（IPC 層はデバウンスなし、状態管理は QuitCoordinator が担う） |
| B2-06 | **spoof: `file:///evil/settings/x.html`（URL は通るが id 不一致）** | **onRequestQuit() 呼ばれない, ERROR('ipc.invalidSender', reason:'webContents id mismatch')** |
| B2-07 | **spoof: URL は settings 正・`event.sender.id` ≠ settingsWebContentsId** | **onRequestQuit() 呼ばれない, ERROR('ipc.invalidSender', reason:'webContents id mismatch')** |
| B2-08 | settingsWebContentsId 未指定（後方互換）かつ URL 正 | onRequestQuit() が1回呼ばれる（id 検証スキップ） |

**テスト実装メモ（C2 反映）**: `makeEvent(url)` ヘルパー（ipc.test.ts L42）は `{ senderFrame: { url } }`
のみを返す。B2 テストでは `sender: { id }` を含む拡張イベント（例: `makeQuitEvent(url, id)`）を用意し、
`registerHandlers` に `settingsWebContentsId` を渡したケース／渡さないケースの両方を検証する。
B2-06/B2-07 は「URL 文字列照合だけでは塞げない spoof を id 同一性で塞ぐ」ことの回帰テスト。

---

### 4-B3. 2段階確認フロー（統合・E2E テスト / U2/U3 反映）

確認状態ロジックは QuitCoordinator（B0 ユニットテスト）が保証する。
B3 は QuitCoordinator + index.ts 結線 + renderer 表示の**統合フロー**を対象とする。
タイマー系ユニットは B0 に移管。DOM 配線は E2E スケルトン（test.fixme）を今回作成し、後続タスクで充足する。

| ID | シナリオ | 期待挙動 | ゲート |
|----|----------|----------|--------|
| B3-01 | 終了ボタン1クリック目 | main が armed=true 設定、`app:quit-armed`(true) push → ボタンが「もう一度押すと終了」に変わる / quit-btn--confirm クラス付与 | E2E/[M] |
| B3-02 | 3秒以内に2クリック目 | main が quit() 呼び出し → アプリ終了 | E2E/[M] |
| B3-03 | 3秒後（タイムアウト）→ ボタン表示 | `app:quit-armed`(false) push → ボタンが「終了」に戻る（タイマー遷移は B0-03 で保証、renderer onQuitArmed 受信は E2E） | unit（B0-03）+ E2E |
| **B3-04** | **1クリック後にパネルを閉じて再開** | **closeSettings() が disarm() 呼び出し → `app:quit-armed`(false) push → 再open 時「終了」表示。1タップでは終了しない（C1 回帰）** | **E2E/[M]（+ unit B0-04 で disarm 状態遷移を保証）** |
| B3-05 | 1クリック後に close-btn でパネルを閉じる | closeSettings() 経由で disarm → armed=false、ボタン初期化（C1: close-btn でも reset） | E2E/[M] |
| B3-06 | Ctrl+Q 1回 | quitCoordinator.requestQuit() 経由で armed=true、設定パネルが開く（openSettings() 呼ばれる）、ボタンが「もう一度押すと終了」表示 | E2E/[M] |
| B3-07 (fixme) | E2E スケルトン: 終了フロー全体（arm → confirm → quit） | `test.fixme` プレースホルダー（今回作成、後続タスクで充足） | E2E スケルトン |

> **B3-04 は CRITICAL C1 の回帰テスト**。disarm の状態遷移は B0-04（unit）で保証し、
> E2E では「closeSettings() が disarm() を呼ぶ」結線と「renderer ボタンが初期状態に戻る」を確認する。
> QuitCoordinator が単一真実源なので、renderer 側の DOM 状態テストではなく main の状態遷移テストが中心となる。

---

## 5. エラー＆レスキューマップ

| 処理 | 想定される異常 | ハンドリング方法 | ユーザーへの影響 |
|------|---------------|-----------------|-----------------|
| `fs.readFileSync('/proc/version')` | ENOENT / EACCES / その他例外 | try/catch → procVersion=null、WARN ログ('gpu.procVersionReadFailed')出力 | env チェックのみで WSL 判定。WSL_DISTRO_NAME 等がなければ GPU が有効のまま（GPU エラーが残る）。ENABLE_GPU=1 や DISABLE_GPU=1 で手動回避可能 |
| `app.disableHardwareAcceleration()` | app ready 後に呼んだ場合 | **シングルインスタンスガード直後・whenReady 前**に配置することで確実に ready 前に呼ぶ（§A-2）。誤配置はレビュー＋[M] 検証で確認 | GPU 問題が残る（防止策は実装パターンの遵守） |
| `shouldDisableGpu()` 自体 | 不正な env オブジェクト | 純関数。Optional chaining / 空文字チェックを内部実装に含める | なし（例外スローなし） |
| `globalShortcut.register('Control+Q')` | 他アプリが Control+Q を占有 | register が false → WARN ログ('input.shortcutRegisterFailed') | Ctrl+Q が効かない。他の終了経路（設定パネルの終了ボタン）は影響なし |
| IPC 'app:request-quit' sender 検証（第1層 URL） | 不正 View / spoof URL からの呼び出し | validateSender → false → ERROR('ipc.invalidSender') + early return | ユーザーへの影響なし（攻撃阻止）。終了は起きない |
| IPC 'app:request-quit' sender 検証（第2層 id） | URL は通るが WebContents id 不一致（C2 spoof） | `event.sender?.id !== settingsWebContentsId` → ERROR('ipc.invalidSender', reason:'webContents id mismatch') + early return | ユーザーへの影響なし（攻撃阻止）。終了は起きない |
| IPC 'app:request-quit' onRequestQuit 未定義 | registerHandlers に onRequestQuit を渡し忘れ | `if (!onRequestQuit) { logger.warn('ipc.quitCallbackNotSet'); return }` | 終了できない。WARN ログで開発中に早期発見。main が状態を持つため renderer ボタンは armed=false のまま固着しない |
| app.quit() 時の before-quit ハンドラ（同期） | globalShortcut.unregisterAll() の内部例外 | **同期スローした場合 uncaughtException→app.relaunch() に化け、終了が再起動になる危険**。現状の同期処理は実質スローしないが、将来追加時はハンドラ内 try/catch + logError で同期例外を握り込む（§B4 注記） | 通常は確実に完走。万一同期スロー時は意図せず再起動の可能性 |
| app.quit() 時の will-quit ハンドラ（同期部） | unregister* / orchestrator.dispose() の同期例外 | 同上（同期スローは relaunch 化リスク）。現状は clearTimeout/clearInterval のみで非スロー | 通常は確実に完走 |
| app.quit() 時の will-quit ハンドラ（非同期部） | `void watcher.stop()` の **非同期** Promise 拒否 | **意図的 fire-and-forget（best-effort）**。拒否は unhandledRejection（L100-104）で **ERROR ログ化**される（サイレント握り潰しではない）。停止完了は待たれない | ファイルウォッチャー停止が不完全になり得るが、プロセス終了で OS が fd 回収。終了自体は成立 |
| QuitCoordinator タイムアウト | clearTimeout が重複して呼ばれる | QuitCoordinator 内でタイマーは1本を保証（requestQuit() 冒頭で既存タイマーを必ず解除）。B0-05 が回帰ゲート | なし |
| 確認状態の固着（C1） | パネル閉→再開で confirm 状態が残り 1タップ即終了 | `closeSettings()`（index.ts）で `quitCoordinator.disarm()` を呼ぶ → `app:quit-armed`(false) push → renderer ボタンが初期状態に戻る（§新規 QuitCoordinator / §B3-04） | なし（誤終了防止が機能目的どおり維持される） |
| SIGKILL による強制終了 | 全クリーンアップがスキップされる | OS レベルの制約で回避不可（best-effort）。systemd Restart=always で再起動 | watcher / orchestrator が孤児化する可能性あり（プロセス終了で OS が回収） |

---

## 6. 既存テスト / 型(typecheck) / lint を壊さない方針

### 6.1 型互換性

- `InputCoordinatorOptions.onQuit` は `optional` とする（`onQuit?: () => void`）。
  既存のテスト・index.ts 等への追加が段階的に可能。
- `RegisterHandlersDeps.onRequestQuit` / `RegisterHandlersDeps.settingsWebContentsId` も同様に
  `optional` とする。既存の `registerHandlers()` 呼び出しは変更不要。
- `IpcEvent.sender?: { id: number }` を **optional 追加**する（C2）。既存の `makeEvent()` ヘルパー
  （`{ senderFrame }` のみ）や他チャネルのテストは sender 未指定でも通る（id 検証は
  settingsWebContentsId 指定時のみ作動するため）。
- `SettingsWindowApi.quitApp` / `SettingsWindowApi.onQuitArmed` を追加した際、既存の型チェックがある箇所
  （`declare global { interface Window { settingsApi: SettingsWindowApi } }`）を更新する。

### 6.2 既存テストへの影響

- `input-coordinator.test.ts`: `createCoordinator()` ヘルパーが `InputCoordinatorOptions` の
  全フィールドを渡しているが、`onQuit` は optional のため既存テストはそのまま通る。
- `ipc.test.ts`: `registerHandlers()` に渡す deps オブジェクトに `onRequestQuit` を追加しない場合も
  optional フィールドなので既存テストに影響しない。
- `settings-controller.test.ts`: SettingsController に変更を加えないため影響なし。

### 6.3 wsl-detect.ts のモジュール設計

- `shouldDisableGpu` は named export の純関数とする（クラス不使用）。
- Node.js の `fs` を直接 import せず、`procVersion` 文字列を引数で受け取るため、
  vitest（Node.js 環境）で Electron に依存せずテスト可能。

### 6.4 lint / フォーマット

- 既存コードは ESLint + Prettier を使用。追加コードも同じフォーマットを踏襲。
- `@typescript-eslint/no-dynamic-delete` 等の既存 ESLint ルールに従う。
- `app.disableHardwareAcceleration()` 呼び出し行にはコメントで「ready前必須」を明記する。

---

## 7. 手動検証 [M]（ユニットでは検出不能な統合項目）

純関数テスト（A-01〜A-16）は `shouldDisableGpu` の**返り値**しか検証できず、
「実際にアドレスバーが描画されるか」「whenReady より前に呼ばれているか」「Ctrl+Q の OS 挙動」は
ユニットで検出できない。以下を **[M] 手動検証ゲート**として実施する。

### 7.1 GPU 無効化の有効性（I1 / Codex-INFO 反映）

| ID | 手順 | 期待結果 |
|----|------|----------|
| M-GPU-01 | 実 WSL2+WSLg で `npm run dev` 起動 | ログに `gpu.hardwareAccelerationDisabled` 出力 / **アドレスバー入力欄（z:1）が描画される** |
| M-GPU-02 | 本番キオスク相当（非 WSL）で起動 | `gpu.hardwareAccelerationDisabled` **非出力** / GPU 有効 |
| M-GPU-03 | `ENABLE_GPU=1 npm run dev`（WSL 上） | 無効化されない（脱出口確認）。GPU 初期化失敗時の挙動は環境依存 |
| M-GPU-04 | `DISABLE_GPU=1` を非 WSL で指定 | 強制無効化される |

> **重要**: M-GPU-01 は「`disableHardwareAcceleration` が実際にアドレスバー未描画問題を解消するか」の
> efficacy 検証であり、この計画の前提因果（GPU 初期化失敗 → z:1 未描画）を裏付ける**必須**確認。
> もし無効化してもアドレスバーが描画されない場合、原因は別（前提が誤り）であり再調査が必要。

### 7.2 アプリ終了経路（ユーザー観点 4/5）

| ID | 手順 | 期待結果 |
|----|------|----------|
| M-QUIT-01 | 設定パネル → 終了ボタン1回 → 3秒以内に2回目 | アプリが終了する |
| M-QUIT-02 | 終了ボタン1回 → 3秒待つ | ボタンが「終了」に戻る（終了しない）|
| M-QUIT-03 | **終了ボタン1回 → 3秒以内にパネルを閉じて再度開く** | **「終了」表示で再表示され、1タップでは終了しない（C1 回帰）** |
| M-QUIT-04 | X11 / 本番で Ctrl+Q | アプリが終了する（best-effort 成功） |
| M-QUIT-05 | WSLg/Wayland で Ctrl+Q | 効かない可能性あり（設定パネル経路が確実経路） |

---

### 6.5 ビルド設定の変更不要

- `wsl-detect.ts` は `src/main/` 配下のため electron-vite の main バンドルに自動包含される。
- preload / renderer の変更は既存の preload / renderer バンドルに自動包含される。
- `vite.config.ts` / `tsconfig.json` の変更は不要。

---

## 付録: 実装順序（推奨）

1. **A: wsl-detect.ts 新規作成 + テスト（Red → Green）**
   - `src/main/wsl-detect.ts` を作成してテストを書き、通す
   - `src/main/index.ts` の**シングルインスタンスガード直後・whenReady 前**に呼び出しを追加（§A-2）

2. **B0: QuitCoordinator 新規作成 + テスト（Red → Green）**
   - `src/main/quit-coordinator.ts` を作成してテストを書き、通す（§4-B0 ユニットテスト）
   - `index.ts` に QuitCoordinator インスタンス化・結線（onArmedChange: openSettings + push / closeSettings に disarm 追加）

3. **B1: InputCoordinator に Ctrl+Q 追加 + テスト（Red → Green）**
   - `input-coordinator.ts` に `onQuit` / `registerQuitShortcut` / `unregisterQuitShortcut` 追加
   - テスト追加・通す
   - `index.ts` の結線（`onQuit: () => quitCoordinator.requestQuit()` / `registerQuitShortcut()` / `unregisterQuitShortcut()`）

4. **B2: IPC 'app:request-quit' 追加 + テスト（Red → Green）**
   - `ipc.ts` に `onRequestQuit` フックと `app:request-quit` ハンドラを追加
   - テスト追加・通す
   - `index.ts` の `registerHandlers` に `onRequestQuit: () => quitCoordinator.requestQuit()` / `settingsWebContentsId` を渡す

5. **B2-preload / renderer: 終了ボタン配線（薄い表示層）**
   - `preload/settings.ts` に `quitApp()`（`app:request-quit` 送信）と `onQuitArmed()`（`app:quit-armed` 受信）を追加
   - `settings/index.html` に `#quit-btn` 追加
   - `settings/styles.css` に `.quit-btn` / `.quit-btn--confirm` / `@keyframes quit-pulse` スタイル追加
   - `settings/main.ts` に シンプルクリックハンドラ（毎回 quitApp() 送信）+ `onQuitArmed` リスナー追加（独自タイマー・独自状態なし）
   - E2E スケルトン（test.fixme）作成

6. **全体: 既存テスト + typecheck + lint 確認**
   - `npm run test` / `npm run typecheck` / `npm run lint` を実行してグリーンを確認

> 実装順序メモ（更新）: B0 で QuitCoordinator を先に作り単体テストを通してから B1/B2 を結線する。
> B1 の `index.ts` 結線では `onQuit: () => quitCoordinator.requestQuit()` を使用。
> B2 の `registerHandlers` には `onRequestQuit` + `settingsWebContentsId: settingsView.webContents.id` を渡す（C2）。
> preload/settings.ts には `onQuitArmed` を含める。styles.css には `@keyframes quit-pulse` を含める（I5）。
> closeSettings() への `quitCoordinator.disarm()` 追加を忘れないこと（C1）。

---

## 確定事項(ユーザー判断済)

以下はアーキテクトレビューで挙がった「対応要否確認」項目について、ユーザーの判断が確定した。
CRITICAL（C1〜C3）は v1.1.0 で解消済み。下記は v1.2.0 で反映済みの設計判断。

1. **終了確認の UI 方式** → **インライン2段階に確定**
   - ボタン1回目で armed/赤色「もう一度押すと終了」表示、3秒以内の再操作で終了。
   - モーダルダイアログ（`dialog.showMessageBox`）は使わない。
   - 実装: QuitCoordinator（main プロセス）が armed 状態と3秒タイマーを保持。renderer は薄い表示のみ。

2. **Ctrl+Q の挙動** → **有効・確認あり に確定**
   - Ctrl+Q も同じ2段階確認（`quitCoordinator.requestQuit()`）を経由する。即終了にはしない。
   - Wayland 時の登録スキップ方針は既存 Ctrl+L / Ctrl+G と同一（スキップ）。
   - armed=true で設定パネルを自動オープンするため、Ctrl+Q 実行時もユーザーが「もう一度押すと終了」を確認できる。

3. **テスト範囲** → **ユニット + E2E スケルトン(test.fixme) を今回作る に確定**
   - ユニット: QuitCoordinator（B0）/ InputCoordinator（B1）/ IPC 'app:request-quit'（B2）
   - E2E スケルトン: `test.fixme` プレースホルダーとして今回作成（内容は後続タスクで充足）

4. **WebContents id 検証の横展開** → **app:request-quit 限定で十分とする（横展開は別タスク）**
   - 高影響・不可逆な `app:request-quit` のみに第2層 id 同一性検証を適用。
   - 既存チャネルへの横展開は別タスクとして将来検討。

5. **GPU 強制フラグ** → **2フラグ構成（ENABLE_GPU=1 / DISABLE_GPU=1）で確定**
   - `ENABLE_GPU=1` が最優先脱出口。`DISABLE_GPU=1` が強制無効化。命名変更なし。
