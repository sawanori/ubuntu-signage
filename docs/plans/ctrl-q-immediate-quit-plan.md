# 実装計画書: Ctrl+Q 即終了 & WSLg GPU 描画安定化

**作成日**: 2026-06-27  
**担当**: sonnet（実装計画書作成）  
**レビュー待ち**: opus（アーキテクトレビュー）

---

## 0. 背景・根本原因（確定事項）

ユーザー報告: 「Ctrl+Q で画面が真っ白になっただけでウィンドウが閉じられない」

診断済み根本原因:
1. **終了UXの罠**: Ctrl+Q は 2段確認設計。`index.ts:742` で `onQuit: () => quitCoordinator.requestQuit()`。1回目の Ctrl+Q は `onArmedChange(true)` → `openSettings()` を呼んで設定パネルを最前面表示する（`index.ts:684-685`, `quit-coordinator.ts:69-82`）。3秒以内に2回目で初めて `app.quit()`。
2. **描画失敗**: WSLg では GPU プロセスが初期化失敗（`Exiting GPU process due to errors during initialization`）。`app.disableHardwareAcceleration()` は呼ばれているが（`index.ts:91-96`）、新規表示する WebContentsView（設定パネル）の合成に失敗し**白画面**になる。
3. **結果**: ユーザーには「白い設定パネルが出て、終了ボタンも2回目の押し方も見えず、閉じない」と見える。

---

## 1. 機能一覧と各機能の仕様

### 機能 A: Ctrl+Q 即終了（メイン修正）

| 項目 | 仕様 |
|------|------|
| トリガー | Ctrl+Q キー入力（globalShortcut） |
| 動作 | 1回押しで **即 `app.quit()` 実行**。確認なし・描画状態に無依存 |
| Wayland | globalShortcut 登録スキップ（既存動作を維持） |
| 多重押下 | `app.quit()` が複数回呼ばれても安全（Electron は冪等） |
| 設定パネル状態 | 設定パネルの開閉状態に無関係（描画できなくても終了する） |

**設計判断 A-1: QuitCoordinator の扱い（温存）**

`QuitCoordinator` は**温存する**。設定パネルの「終了」ボタン（`app:request-quit` IPC 経由）は依然として可視パネル内での操作のため、2段確認 UI は妥当かつ既存テスト資産がある。

QuitCoordinator の変更点はなし。変更するのは index.ts の結線のみ。

**設計判断 A-2: `armed → openSettings` 結合の解消**

現状の `onArmedChange` コールバック（`index.ts:684-690`）:
```typescript
onArmedChange: (armed: boolean): void => {
  if (armed) openSettings()   // ← これが白パネルの原因
  if (!settingsView.webContents.isDestroyed()) {
    settingsView.webContents.send('app:quit-armed', armed)
  }
},
```

`if (armed) openSettings()` は**削除**する。理由:
- Ctrl+Q が QuitCoordinator を迂回するため、この行は Ctrl+Q 経路では呼ばれなくなる
- 設定ボタン経由（`onRequestQuit`）の場合、パネルは既に開いており `openSettings()` は `settingsVisible===true` で早期リターン（`index.ts:651-654`）するため dead code
- 白パネル問題の原因コードを明示的に除去することで回帰防止

この結合を解消しても、設定パネルの `app:quit-armed` IPC 送信（終了ボタン UI フィードバック）は引き続き機能する。

**設計判断 A-3: `app.quit()` の確実性**

`app.quit()` は `before-quit` → `will-quit` 順にイベントを発行し全ウィンドウの `beforeunload` を実行する。本プロジェクトの WebContentsView renderer には `beforeunload` キャンセルロジックはない。また `window-all-closed` → `app.quit()` ループも `index.ts:197-199` で設定済み。フォールバック（`app.exit(0)`）は**不要**（過剰設計）。

### 機能 B: WSLg GPU 描画安定化（関連修正）

| 項目 | 仕様 |
|------|------|
| 目的 | 設定パネル・アドレスバー等の WebContentsView が WSLg で白くならず描画されるようにする |
| 適用条件 | `shouldDisableGpu()===true` の場合のみ（既存ゲートを流用） |
| 脱出口 | `ENABLE_GPU=1` 環境変数で全スイッチをスキップ（既存ロジック維持） |
| 反復前提 | GPU スイッチは環境依存。実機 WSL での検証を**複数回**要する可能性あり |

---

## 2. ファイル構成・変更対象ファイル一覧

### 変更が必要なファイル

| ファイル | 変更内容 | 行 |
|---------|---------|-----|
| `src/main/index.ts` | `onQuit` コールバックを `app.quit()` 直呼びに変更 | 742 |
| `src/main/index.ts` | `onArmedChange` 内 `if (armed) openSettings()` を削除 | 685 |
| `src/main/index.ts` | GPU command-line スイッチを WSL 検出ブロックに追加 | 91-96 付近 |

### 変更不要なファイル

| ファイル | 理由 |
|---------|------|
| `src/main/quit-coordinator.ts` | 温存。設定ボタン用 2段確認のまま |
| `src/main/input-coordinator.ts` | `onQuit` はコールバックとして受け取るだけ。結線は index.ts |
| `src/main/wsl-detect.ts` | `shouldDisableGpu` 純関数は変更なし |
| `src/preload/settings.ts` | `quitApp()`/`onQuitArmed()` は設定パネル用として温存 |
| `src/renderer/settings/main.ts` | 設定パネルの終了ボタン 2段確認 UI は維持 |

### テスト変更対象

| ファイル | 変更種別 | 内容 |
|---------|---------|------|
| `test/unit/input-coordinator.test.ts` | **追加** | Ctrl+Q コールバック B1-07 の補足：onQuit が直接 quit 関数として注入される前提の検証（後述テストケース参照） |
| `test/e2e/quit-flow.spec.ts` | **更新** | B3-06 を「Ctrl+Q 1回 → armed 状態ではなく即終了」に変更 |
| `test/e2e/quit-flow.spec.ts` | **新規** | QB-E2E-01: Ctrl+Q 1回でプロセス終了確認（fixme → 実装対象） |
| `test/unit/quit-coordinator.test.ts` | **変更なし** | QuitCoordinator 自体は変更なし |
| `test/unit/wsl-detect.test.ts` | **変更なし** | shouldDisableGpu は変更なし |

---

## 3. 依存関係・技術選定の根拠

### 3.1 QuitCoordinator 温存の根拠

- 設定パネルの終了ボタンは「可視状態での操作」→ 2段確認 UI は UX として妥当
- QuitCoordinator の単体テストが充実（B0-01〜B0-08: 8ケース）。撤去コストに対して得られる簡素化が小さい
- `onRequestQuit: () => quitCoordinator.requestQuit()`（`index.ts:797`）は変更不要

### 3.2 `app.quit()` vs `app.exit(0)` の選択

`app.quit()` を選択。理由:
- `before-quit` イベントで `globalShortcut.unregisterAll()` と `powerSaveBlocker.stop()` が実行される（`index.ts:201-207`）。`app.exit(0)` はこれを飛ばす
- `app.quit()` はフレームレス BaseWindow + 5層 WebContentsView を `window-all-closed` 経由で確実に閉じる（`index.ts:197-199`, `296-298` にハンドラあり）

### 3.3 GPU スイッチ技術選定（Context7 Electron ドキュメント参照）

`app.commandLine.appendSwitch()` は `app.whenReady()` より前に呼ぶ必要がある。既存の `shouldDisableGpu` ブロックは `app.disableHardwareAcceleration()` の直後であり、ここに追加する。

候補スイッチと根拠:

| スイッチ | 効果 | WSLg での期待 |
|---------|------|--------------|
| `disable-gpu` | GPU プロセスを起動しない（最も強力） | GPU 初期化エラー自体を防ぐ |
| `disable-gpu-compositing` | GPU compositing のみ無効化（CPU 合成へ） | WebContentsView の合成失敗を防ぐ |
| `in-process-gpu` | GPU をブラウザプロセスに統合（別プロセス不要） | GPU プロセスクラッシュ問題を回避 |
| `use-gl=swiftshader` | OpenGL ES を SwiftShader（CPU）で処理 | GL 呼び出し自体をソフトウェアで代替 |
| `use-angle=swiftshader` | ANGLE バックエンドを SwiftShader に変更 | ANGLE 経由の GPU アクセスを CPU に落とす |
| `disable-gpu-sandbox` | GPU サンドボックス無効化 | WSLg の権限制約を回避（最後の手段） |
| `ozone-platform=x11` | Ozone で X11 を強制（WSLg の XWayland 向け） | Wayland/X11 混在問題を解消（isWayland===true 時は適用外） |

**推奨実施順序**（反復検証が必要、最小侵襲から始める）:

```
フェーズ 1: disable-gpu + disable-gpu-compositing（最優先・最も確実）
フェーズ 2: フェーズ1で不十分なら in-process-gpu を追加
フェーズ 3: フェーズ2でも不十分なら use-gl=swiftshader を追加
フェーズ 4: 解決しない場合 disable-gpu-sandbox を最後の手段として検討
```

**重要**: GPU スイッチは WSLg 環境の差異（カーネルバージョン、Mesa バージョン、WSLg ビルド）に強く依存する。計画書の「フェーズ 1」が正解の環境もあれば「フェーズ 3」まで必要な環境もある。CI 上でなく**実機 WSL での反復検証**が必要。

---

## 4. 各機能のテストケースリスト

### 4-A: Ctrl+Q 即終了（新規テストケース）

#### ユニットテスト: `test/unit/input-coordinator.test.ts` への追加

| ID | テスト名 | 種別 | 検証内容 |
|----|---------|------|---------|
| QB-U-01 | Ctrl+Q コールバック発火 → `onQuit()` が1回呼ばれる | 正常系 | B1-07 既存テストで検証済み。`onQuit` の中身（`app.quit()`）は index.ts の統合テストで検証 |
| QB-U-02 | `onQuit` に `app.quit()` 相当のモック関数を渡す → Ctrl+Q 1回で1回のみ呼ばれる | 正常系 | `mockOnQuit` を注入して `registerQuitShortcut()` → コールバック発火 → `mockOnQuit` が exactly 1 回 |
| QB-U-03 | Ctrl+Q 多重押下 → `onQuit()` は発火のたびに呼ばれる（重複登録がないこと） | 正常系 | コールバックを2回発火 → `mockOnQuit` が 2 回（`app.quit()` の冪等性は Electron 側に委ねる） |
| QB-U-04 | Wayland 環境で `registerQuitShortcut()` → `onQuit` は登録されない → キー入力では呼ばれない | 異常系 | B1-02 既存テストで検証済み |
| QB-U-05 | `onQuit` 未定義で Ctrl+Q 発火 → TypeError なし（no-op） | 異常系 | B1-08 既存テストで検証済み |
| QB-U-06 | `globalShortcut.register` が `false` 返す → WARN ログ出力・`onQuit` は紐付かない | 異常系 | B1-03 既存テストで検証済み |

#### E2E テスト: `test/e2e/quit-flow.spec.ts` への更新・追加

| ID | テスト名 | 種別 | 検証内容 |
|----|---------|------|---------|
| QB-E2E-01 | Ctrl+Q 1回 → アプリプロセスが終了する | 正常系 | X11環境でのみ有効。`electronApp.close()` またはプロセス終了を確認 |
| QB-E2E-02 | Ctrl+Q 1回で即終了（armed 状態にならない） | 正常系 | 終了ボタンが「もう一度押して終了」にならないことを確認（旧 B3-06 を逆転させた検証） |
| QB-E2E-03 | Ctrl+Q 1回 → 設定パネルが開かない | 正常系 | `onArmedChange(true)` が呼ばれても `openSettings()` が呼ばれないことの確認（WSL 白パネル回帰防止） |
| QB-E2E-04 | WSL 環境で Ctrl+Q → 白画面なしで終了 | 正常系 | WSL 実機のみ。GPU エラーログが出ないことを確認 |

#### 既存 E2E テストの更新

| ID | 更新内容 |
|----|---------|
| B3-06（旧: Ctrl+Q 1回 → armed + 設定パネル表示） | **削除または反転**: 新仕様では Ctrl+Q は即終了のため armed 状態にならない。QB-E2E-01/02 で置き換える |
| B3-01〜B3-05（設定パネルの終了ボタン 2段確認） | **維持**: 設定パネルボタンは QuitCoordinator 経由のため既存仕様通り |

### 4-B: `onArmedChange` クリーンアップ（設計変更の検証）

| ID | テスト名 | 種別 | 検証内容 |
|----|---------|------|---------|
| QB-U-07 | 設定パネルが開いた状態で `onRequestQuit`（IPC）を発火 → `openSettings()` は呼ばれない | 正常系 | `onArmedChange` から `openSettings()` 削除後の回帰確認。設定パネルは開いたままの状態が維持される |
| QB-U-08 | `onRequestQuit` 2回 → `app.quit()` が呼ばれる（QuitCoordinator 経路の維持確認） | 正常系 | 設定パネル終了ボタンの 2段確認が壊れていないことを確認 |

### 4-C: WSL GPU 描画（GPU スイッチ）

| ID | テスト名 | 種別 | 検証内容 |
|----|---------|------|---------|
| GPU-U-01 | `shouldDisableGpu===true` の場合に `app.commandLine.appendSwitch('disable-gpu')` が呼ばれる | 正常系 | index.ts の GPU スイッチ適用ロジックの単体テスト（モックが必要） |
| GPU-U-02 | `ENABLE_GPU=1` の場合に GPU スイッチが追加されない | 異常系 | 脱出口が機能することを確認 |
| GPU-RT-01 | WSL 実機: `DISPLAY=:0 npm run dev` 起動後、設定パネルが白くならず描画される | 実機検証 | フェーズ 1 スイッチ適用後に手動確認 |
| GPU-RT-02 | WSL 実機: アドレスバー View が白くならず描画される | 実機検証 | `gpu.hardwareAccelerationDisabled` ログと GPU エラーログの有無を確認 |
| GPU-RT-03 | WSL 実機: `ENABLE_GPU=1` で起動した場合 GPU スイッチが適用されず GPU アクセラレーションが有効のまま | 実機検証 | 脱出口の動作確認 |

### 4-D: 既存テストの影響確認（変更なしを期待）

| テストファイル | 期待 | 理由 |
|-------------|------|------|
| `test/unit/quit-coordinator.test.ts` (B0-01〜B0-08) | 全パス維持 | QuitCoordinator は変更なし |
| `test/unit/input-coordinator.test.ts` (B1-01〜B1-08) | 全パス維持 | InputCoordinator は変更なし。`onQuit` はコールバックとして抽象化済み |
| `test/unit/wsl-detect.test.ts` (A-01〜A-16) | 全パス維持 | `shouldDisableGpu` 純関数は変更なし |

---

## 5. エラー＆レスキューマップ

| 処理 | 想定される異常 | ハンドリング方法 | ユーザーへの影響 |
|------|--------------|----------------|----------------|
| Ctrl+Q → `app.quit()` | `beforeunload` が予期せず発火してキャンセル | WebContentsView renderer に `beforeunload` キャンセルロジックはない（コードレビューで確認済み）。万一発生したら `app.exit(0)` フォールバックを検討 | キャンセルされた場合はウィンドウが閉じない → 次フェーズで `app.exit(0)` タイムアウトを追加 |
| Ctrl+Q → `app.quit()` | Wayland 環境でショートカット未登録 | 既存動作を維持（登録スキップ + WARN ログ）。終了手段なし → 設定パネルの終了ボタンを案内 | Wayland では Ctrl+Q 不可（既知の制限） |
| `app.commandLine.appendSwitch()` | 無効なスイッチ名（タイポ等） | Electron は無効スイッチを**サイレントに無視**（エラーなし）。起動ログに `gpu.commandLineSwitchAdded` イベントを出力して追跡可能にする | GPU 修正が適用されないが他機能に影響なし |
| GPU スイッチ適用後の起動 | WSLg 環境でスイッチが不十分で白画面継続 | 構造化ログ（`gpu.hardwareAccelerationDisabled`）で適用有無を確認。フェーズを順次進める | 画面が白いままの場合は次フェーズのスイッチを試す（反復前提） |
| `onArmedChange` から `openSettings()` 削除後 | 設定パネルの終了ボタンが armed 時に期待外れの挙動 | `openSettings()` は既に open 時 no-op だったため動作変化なし。`app:quit-armed` IPC 送信は維持 | 設定パネルの終了ボタン UI（「もう一度押して終了」表示）は変わらず機能する |
| GPU-RT-* 実機検証でフェーズ 1 スイッチが効かない | 特定の WSLg バージョンでスイッチ組み合わせが異なる | フェーズ 2/3 に進む。ログで GPU エラーメッセージを確認し、スイッチを選択 | 開発時間が増加するが機能的影響はない |
| `app.quit()` 多重呼び出し | Ctrl+Q 連打で `app.quit()` 複数回 | Electron の `app.quit()` は冪等（内部で 2度目は no-op 相当）。問題なし | なし |

---

## 6. 具体的コード変更（実装時の参照用）

### 変更 1: `src/main/index.ts` — Ctrl+Q の onQuit を即 `app.quit()` に変更

**変更前** (line 742):
```typescript
onQuit: () => quitCoordinator.requestQuit(),
```

**変更後**:
```typescript
onQuit: () => app.quit(),
```

### 変更 2: `src/main/index.ts` — `onArmedChange` から `openSettings()` 呼び出しを削除

**変更前** (lines 684-690):
```typescript
onArmedChange: (armed: boolean): void => {
  if (armed) openSettings()                          // ← この行を削除
  if (!settingsView.webContents.isDestroyed()) {
    settingsView.webContents.send('app:quit-armed', armed)
  }
},
```

**変更後**:
```typescript
onArmedChange: (armed: boolean): void => {
  // armed → openSettings() の結合を解消（設定パネルボタン経由では既に open のため dead code だった）
  if (!settingsView.webContents.isDestroyed()) {
    settingsView.webContents.send('app:quit-armed', armed)
  }
},
```

### 変更 3: `src/main/index.ts` — WSL GPU コマンドラインスイッチ追加

**変更前** (lines 91-97):
```typescript
if (shouldDisableGpu({ env: process.env as Record<string, string | undefined>, procVersion })) {
  app.disableHardwareAcceleration()
  process.stdout.write(
    JSON.stringify({ level: 'WARN', event: 'gpu.hardwareAccelerationDisabled', ts: Date.now() }) + '\n',
  )
}
```

**変更後**:
```typescript
if (shouldDisableGpu({ env: process.env as Record<string, string | undefined>, procVersion })) {
  app.disableHardwareAcceleration()
  // WSLg では GPU プロセスが初期化失敗して WebContentsView 合成が白画面になるため
  // command-line スイッチで GPU を完全に無効化する。
  // フェーズ 1: disable-gpu + disable-gpu-compositing（最小侵襲）
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
  // フェーズ 2（フェーズ 1 で不十分な場合はコメントを外す）:
  // app.commandLine.appendSwitch('in-process-gpu')
  // フェーズ 3（フェーズ 2 でも不十分な場合）:
  // app.commandLine.appendSwitch('use-gl', 'swiftshader')
  process.stdout.write(
    JSON.stringify({
      level: 'WARN',
      event: 'gpu.hardwareAccelerationDisabled',
      gpuSwitches: ['disable-gpu', 'disable-gpu-compositing'],
      ts: Date.now(),
    }) + '\n',
  )
}
```

---

## 7. 既存テストへの影響まとめ

| テストファイル | 影響 | アクション |
|-------------|------|----------|
| `test/unit/quit-coordinator.test.ts` | なし | 変更不要 |
| `test/unit/wsl-detect.test.ts` | なし | 変更不要 |
| `test/unit/input-coordinator.test.ts` | 軽微・追加のみ | QB-U-02/QB-U-03 の新規ケース追加（任意）。既存 B1-* テストは全通過維持 |
| `test/e2e/quit-flow.spec.ts` | 更新あり | B3-06 を反転（armed → 即終了に変更）。QB-E2E-01/02 を新規追加 |
| `test/e2e/e2e-20.spec.ts` | なし | アドレスバーテストは Ctrl+Q に無関係 |

---

## 8. GPU 検証ステップ（経験的反復プロセス）

WSLg GPU 修正は実機検証が必要。以下の手順で反復する。

```
ステップ 1: フェーズ 1 スイッチ（disable-gpu + disable-gpu-compositing）を index.ts に追加
ステップ 2: WSL 環境で DISPLAY=:0 npm run dev（または npm run build && npm start）
ステップ 3: 起動ログを確認
  - gpu.hardwareAccelerationDisabled が出力されているか
  - "Exiting GPU process" や "Failed to send GpuControl.CreateCommandBuffer" が出ないか
ステップ 4: 設定パネルを開く（Ctrl+G または隅 3 タップ）→ 白くないか確認
ステップ 5: アドレスバーを表示（Ctrl+L）→ 白くないか確認
ステップ 6: 不十分なら index.ts のフェーズ 2/3 コメントを外して再試行
ステップ 7: ENABLE_GPU=1 で起動しスイッチ適用なしを確認（脱出口の動作検証）
```

---

## 9. 変更ファイルとテストケース数サマリ

| 変更ファイル | 変更種別 | 変更行数（概算） |
|------------|---------|--------------|
| `src/main/index.ts` | 1行変更 + 1行削除 + ~10行追加 | 約 13行 |
| `test/unit/input-coordinator.test.ts` | 任意追加（QB-U-02/03 計 ~20行） | 約 20行（任意） |
| `test/e2e/quit-flow.spec.ts` | B3-06 更新 + QB-E2E-01/02 追加 | 約 40行 |

**合計テストケース数**:
- 新規追加テストケース: 5〜8件（QB-U-01〜06 のうち未カバー分 + QB-E2E-01/02）
- 更新テストケース: 1件（B3-06）
- 変更なし既存テスト: 26件（B0-01〜08 + B1-01〜08 + A-01〜16）

---

## 10. 未確定・要検証ポイント

1. **GPU スイッチの最終組み合わせ**: フェーズ 1〜4 のどこで収束するかは実機 WSLg 環境に依存する。計画書ではフェーズ 1 をデフォルトとしてコメントアウト方式で段階的に試す設計にした。
2. **Wayland 環境での終了手段**: Ctrl+Q は Wayland では登録されない（既存制限）。設定パネルの終了ボタンが唯一の終了手段。Wayland 向けの別の終了手段は今回のスコープ外。
3. **E2E テスト実装**: `test/e2e/quit-flow.spec.ts` の QB-E2E-01/02 は Playwright + Electron でプロセス終了を検証する設計が確立していないため `test.fixme` で追加し、後続タスクで実装する。
4. **`app.disableDomainBlockingFor3DAPIs()`**: GPU プロセスクラッシュ後に 3D API がドメイン単位でブロックされる Chromium デフォルト動作を無効化するオプション。`disable-gpu` を使う場合は不要だが、スイッチ効果が不十分な場合の追加候補として記録しておく。
