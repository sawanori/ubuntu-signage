# リファクタリング計画書（内部品質パス）

対象リポジトリ: `/home/noritakasawada/project/ubuntuapp`（Electron デジタルサイネージ / TypeScript + electron-vite + vitest + playwright）
作成日: 2026-06-28
レビュー: Opus アーキテクト consolidate（並列解析の生 findings を検証・統合）

---

## 1. 目的とスコープ

本パスは **観測可能な挙動を一切変えない内部品質改善（純粋リファクタ）** のみを行う。機能追加・仕様変更・UX 改善は含まない。

### 絶対保証（このパスで変えないもの）
- **UI**: 画面表示・レイアウト・色・フェード時間・ボタンの活性/非活性などユーザーが見える要素を一切変えない。
- **挙動・タイミング**: 再生スケジュール、watchdog タイマー長、フェード 2000ms、リトライ間隔などの実行時タイミングを変えない。
- **IPC 契約**: チャネル名・送受信ペイロード形状・sender allowlist を変えない。
- **config schema 意味論**: `ConfigSchema` が受理/拒否するキー集合・型・デフォルト値を変えない（`fadeDurationMs` を含む）。
- **テストが依存するログイベント**: テスト（unit / e2e）が assert しているログイベント名・ペイロード（例: `gpu.hardwareAccelerationDisabled`, `scheduler.watchdogTriggered`, `playlist.empty`, `renderer.crashed`）を変えない。バイト等価でない変更は行わない。

### 許可される操作
デッド/到達不能コードの除去、重複の統合・共通ヘルパー抽出、型の厳格化、**観測出力を変えずに** サイレント障害を表面化、過剰抽象の単純化、ファイルサイズ/複雑度の削減、潜在的なエラー温床パターンの是正。

### スコープ外
あるクリーンアップがわずかでも挙動/スキーマ/契約/テスト assert を変えるなら、**実施せず §5「スコープ外（要ユーザー判断）」に記録** し、判断をユーザーに委ねる。

### 検証の前提（本計画作成時に実コードで確認済み）
- `fadeDurationMs` は schema / types / DEFAULT_CONFIG とテストにしか出現せず、本番ランタイムで読まれていない。CSS は `transition: opacity 2000ms`（`src/renderer/overlay/styles.css:47`）。デフォルトは 1000ms で **CSS と一致しない**。
- 5 つの WebContentsView はすべて明示 partition（`persist:site` / `''` / `persist:overlay` / `persist:hotspot` / `persist:settings`）を持ち、`session.defaultSession` を消費する view は存在しない。`media://` の既定セッション登録（index.ts 271 付近）には消費者がいない。
- scheduler の watchdog 配線は 4 箇所（scheduler.ts 104 / 229 / 276 / 287）でバイト等価に重複。
- preload `updateConfig` は `Promise<void>` 宣言だが実体は `Config | null` を返す（型の嘘）。
- `SchedulerState` union は shared/types.ts:27 と renderer/settings/settings-controller.ts:27 に二重定義。
- e2e-20.spec.ts は 23 test 中 22 が `test.fixme(true, ...)`（全 1014 行中 ~960 行が永久スキップの本体）。
- index.ts は 972 行。`logWarn`/`logError` は **巻き上げされる関数宣言** で GPU ブロック（87 行付近）から呼び出し可能（「まだ定義されていない」というコメントは誤り）。`logWarn` は `{level,event,...meta,ts}` を出力し、GPU ブロックの手書き JSON とキー順含めバイト等価。

---

## 2. 方針

- **純粋リファクタのみ**。本計画の §3 全項目は `挙動影響=なし`。`挙動影響=要注意` のものは 1 件も §3 に含めず、§5 に隔離する。
- 各項目は「対象 / 現状の問題 / 具体的変更 / 挙動影響 / リスク / テスト影響 / 優先度」を明記。
- 重複する findings は統合済み（例: `fadeDurationMs` の dead-config 指摘 3 件 → §5-O1 + §3 コメント是正に集約。Window API 二重定義 → C2 を根本対策とし C1 を即時の具体修正として併記）。
- **グリーン維持**: 各ステップ後に `typecheck` + `lint` + 全テスト（unit 501 件）を緑に保つ（§5 検証戦略）。
- **保守的**: 確信度の高い低リスク項目を優先。index.ts の本格的なファイル分割など高リスク作業は本パスでは行わず明示的に保留する。

---

## 3. リファクタ項目一覧（すべて挙動影響=なし）

### テーマ A: 重複統合（本番コード）

| ID | 対象 | 現状の問題 | 具体的変更 | リスク | テスト影響 | 優先度 |
|----|------|-----------|-----------|-------|-----------|-------|
| A1 | src/main/index.ts:882-933 | `loadOverlay/loadSettings/loadHotspot/loadAddressBar` が view と path segment 以外バイト等価（~52 行 ×4）。dev/prod 分岐の変更が 4 箇所に分散しドリフトする。 | `loadView(view, seg)` を 1 つ追加し、`isDev && devBaseUrl!==''` なら `loadURL(\`${devBaseUrl}/${seg}/index.html\`)`、否なら `loadFile(join(__dirname,\`../renderer/${seg}/index.html\`))`。4 named 関数は 1 行委譲で残す（呼び出し側＝Promise.all/再ロードは無改変）。URL/ファイルは完全一致。 | 低 | index.ts は unit 非対象。typecheck/build で担保。 | **P1** |
| A2 | src/main/scheduler/scheduler.ts:104,229,276,287 | `this.watchdogTimer=setTimeout(()=>{this.watchdogTimer=null; logger.error('scheduler.watchdogTriggered',{state}); _forceIdle()}, ms)` が 4 回複写。1 箇所で timer の null 化を忘れる等のドリフト源。 | `private _armWatchdog(stateLabel, ms)` を新設し 4 箇所から呼ぶ。タイマー長・ログイベント名/ペイロード・`_forceIdle` は同一。 | 低 | scheduler.test.ts が event/state/タイマー長を assert。出力バイト等価で緑維持。 | **P1** |
| A3 | src/main/index.ts:271-291 | 既定セッションと `persist:overlay` の `protocol.handle('media',...)` が同一 inline closure を複写（毎リクエスト `createElectronProtocolHandler(currentVideoFolder,...)` を再生成）。 | `const handleMedia = (req) => createElectronProtocolHandler(currentVideoFolder, mediaFsAdapter, protocolLogger)(req)` を一度定義し両登録へ渡す。live-folder closure 意味論を維持。 | 低 | media-protocol コアは別途テスト済み。配線のみ。 | P2 |
| A4 | src/main/index.ts:653-690 | 4 つの `render-process-gone` ハンドラが `logError('renderer.crashed',{view,reason})` + reload を複写。hotspot/addressBar は reload 後の状態復元 `.catch` も複写。 | `attachCrashRecovery(view, name, reload, afterReload?)` を追加。overlay/settings は afterReload なし、hotspot は zone 再適用、addressBar は toolbar 再適用を渡す。ログイベント/ペイロード同一。 | 低 | index.ts は unit 非対象。 | P2 |
| A5 | src/main/index.ts:792-794,837-860 | `onSiteUrlChange/onAddressBarNavigate/onAddressBarReload` が `siteRetryState=createRetryState(); loadSiteUrl(url)` を複写。`onToggleAddressBar` が 2 箇所で同一定義。 | `const reloadSite=(url)=>{siteRetryState=createRetryState(); loadSiteUrl(url)}` と `const toggleAddressBar=()=>setToolbarVisible(!toolbarVisible)` を定義し全呼び出し元から参照。`onAddressBarReload` は `()=>reloadSite(configManager.current.siteUrl)`。 | 低 | index.ts は unit 非対象。 | P2 |
| A6 | src/renderer/overlay/main.ts:192-218 | `triggerFadeIn`/`triggerFadeOut` が target opacity（'1' vs '0'）以外同一（transitionend 登録/解除/guard を複写）。 | `runOpacityTransition(to:'0'|'1', onComplete)` を抽出し両者を 1 行定義に。ランタイム挙動同一。 | 低 | overlay/main.ts は DOM glue で unit 非対象。controller テストは独自 callback を注入。 | P3 |
| A7 | src/renderer/overlay/overlay-controller.ts:165-209 | `_startFadeOut` と `_handleError`（可視エラー）が「fade-out→IDLE」完了ブロック（state ガード→IDLE→setVisible(false)→currentPath=null→onFadeOutDone）を複写。 | `private _completeFadeOutToIdle()` を抽出し両者から呼ぶ。`onPlayed`/`onError` の発火順序は現状維持。 | 低 | overlay-controller.test.ts が遷移を網羅。呼び出し順/出力同一で緑維持。 | P3 |
| A8 | src/renderer/addressbar/main.ts:53-59, src/renderer/hotspot/main.ts | addressbar/hotspot は `getElementById(...) as HTML*` を null チェックなしで多用。settings(`getEl<T>` が明示 throw)/overlay(`instanceof`)と防御方法が 3 通りに分裂。要素欠落時、後段で不透明な TypeError 化。 | renderer 共通の `getEl<T>(selector)`（ラベル付き Error を throw）を 1 つ用意し addressbar/hotspot に適用、settings の `getEl` も同じものに集約。正常系は全要素存在で挙動不変、異常系のエラーが早期・ラベル付きになるだけ。 | 低 | これらの entry module は unit 非対象。 | P2 |
| A9 | src/renderer/settings/main.ts:144-146,211-213 | `data-minutes` を renderConfig は `Number(...)`、click handler は `parseInt(...,10)` で解釈。実値 '5'/'10'/'15'/'30' では一致するが解析戦略が二重。 | 一方（`Number`）に統一、小さなローカル helper で read+validate を共通化。実属性値で挙動同一。 | 低 | DOM handler で unit 非対象。 | P3 |

### テーマ A': 重複統合（テストコード）

| ID | 対象 | 現状の問題 | 具体的変更 | リスク | テスト影響 | 優先度 |
|----|------|-----------|-----------|-------|-----------|-------|
| A10 | test/unit/ipc.test.ts:42-70, index-integration.test.ts:80-110 | `createMockIpcMain/HandlerStore/makeEvent/IpcEvent`・URL 定数・`BASE_CONFIG` を 2 ファイルが各々バイト等価に定義。IpcEvent 形状や registerHandlers 契約変更が 2 箇所要編集。 | `test/unit/helpers/ipc-harness.ts` に集約し両者から import。assert は不変。 | 低 | assert 変更なし。~40 行の足場を一本化。 | P2 |
| A11 | test/unit/playlist.test.ts:15-25, watcher.int.test.ts:26-34,70-85 | 両 real-FS テストが `makeTempDir/touch`（+watcher は `makeMockLogger`）を各々定義。 | `test/unit/helpers/fs-fixtures.ts` に集約し import。 | 低 | assert 変更なし。 | P3 |
| A12 | test/e2e/{e2e-01,e2e-13,e2e-16,e2e-20,e2e-nav}.spec.ts, harness/electron-launch.ts | `SKIP_REASON_NO_WCV`（派生含む）と `delay(ms)` が複数 spec/harness で重複。 | `harness/electron-launch.ts` から `SKIP_REASON_NO_WCV` + `skipReasonForView(name)` + `delay` を export し各 spec で import。 | 低 | skip ロジック不変。 | P3 |
| A13 | test/unit/media-protocol.test.ts:61-77,720-741 ほか | roundtrip テストが `makeRealFsAdapter()` を再実装。`ProtocolRequest` 構築 boilerplate が 30+ 回複写。 | roundtrip で `makeRealFsAdapter()` を再利用し、`makeReq(relPath, range?)`（no-range デフォルト）helper を追加。 | 低 | assert 変更なし。ファイル縮小。 | P3 |

### テーマ B: デッドコード除去

| ID | 対象 | 現状の問題 | 具体的変更 | リスク | テスト影響 | 優先度 |
|----|------|-----------|-----------|-------|-----------|-------|
| B3 | test/e2e/e2e-20.spec.ts:118-1014 | 23 test 中 22 が `test.fixme(true,...)` で永久短絡。~960 行の到達不能 assert 本体が存在し得ない hook（`app._toolbarVisible` 等）を参照したまま腐朽。実在しない E2E カバレッジを示唆。 | describe 骨格 + 先頭コメント + 唯一実行される `addressBarView が検出できる` smoke test だけに縮約。未実装シナリオはコメント/チェックリストとして残す。**fixme の有効化（実行 test 集合の変更）は行わない**。 | 低 | 実行 test 集合は不変（22 は既に永久 skip）。~960 行削除。 | **P1** |
| B4 | test/unit/index-integration.test.ts:112-250 | 「Phase E IPC 結合」ブロックが ipc.test.ts「Phase C: addressbar IPC」と同一挙動（navigate/toggle-loop/settings:update broadcast/toggle/reload）を再検証。固有なのは `notifyAddressZoneEnabled`（25-65, toolbar-utils）のみ。 | `notifyAddressZoneEnabled` describe を残し、重複 registerHandlers ブロック（+ 私的 IPC mock 足場）を削除。ファイルを toolbar-utils zone 検証として整理。 | 低 | ipc.test.ts と同一カバレッジが残存。~6 重複 test 削除。 | **P1** |
| B1 | src/shared/types.ts:30-34 | `OverlayPlayPayload/OverlayPlayedPayload/OverlayErrorPayload/OverlayDurationReadyPayload/SettingsFolderPickedPayload` が src/test 内で未 import（grep で消費者ゼロ確認）。実 IPC は inline literal を使用。 | 5 つの dead type alias を削除（type-only でコンパイル時消去）。 | 低 | テスト参照ゼロ（grep 確認）。 | P2 |
| B5 | test/unit/ipc.test.ts:741-799 | `ConfigUpdateSchema 検証` describe が schema.test.ts:117-184 の専用スイートと重複。schema 検証は schema モジュールの責務。 | ipc.test.ts の当該 describe を削除し schema.test.ts に委譲。ipc.test.ts は `applyUpdate` mock 返却で委譲を既に検証済み。 | 低 | ~9 schema-only test 削除。同一カバレッジは schema.test.ts に残存。 | P2 |
| B2 | src/shared/types.ts:18-24 | `PlaylistState` 型は定義のみで未 import（grep 確認）。実 playlist は inline フィールドで状態管理。 | 当該 type を削除（type-only・消去対象）。 | 低 | テスト参照なし。 | P3 |
| B6 | test/unit/settings-controller.test.ts:413-419 | 「空文字許容」ブロックが `https://有効`・`ftp://無効` を再記述。これは main の validateUrl ブロック（176-184）と重複（ラベル「既存:」が重複を自認）。 | 「既存:」2 件を削除し空文字/空白固有ケースのみ残す。 | 低 | 2 冗長 assert 削除。scheme カバレッジ不変。 | P3 |
| B7 | src/renderer/addressbar/main.ts:25 | `export {};` が module 化のため存在するが、行 27 の `import type { Config }` で既に module。dead。 | addressbar の `export {};` を削除。hotspot/main.ts のものは import 無しで必要なため残す。 | 低 | なし。 | P3 |
| B9 | src/main/config.ts:244-249 | `save()` 上に JSDoc が 2 連続。最初は孤児で、2 つ目（@returns）だけが現行 boolean 戻り値を記述。 | 最初のブロック（244-249）を削除し @returns ブロックを残す。 | 低 | なし。 | P3 |
| B8 | test/unit/.gitkeep, test/e2e/.gitkeep | 両 dir は多数のファイルを保持し placeholder は無用（現状 git 管理外のため純粋な整理）。 | 両 `.gitkeep` を削除。 | 低 | なし。 | P3 |

> **敢えて変更しない**: playlist.ts:88-91,110-115 の到達不能 null 分岐（防御ガード兼 `playlist.empty` 再 emit）は、削除すると防御網が減るため **現状維持**。サイズ最適化目的でのみ将来検討。

### テーマ C: 型の厳格化

| ID | 対象 | 現状の問題 | 具体的変更 | リスク | テスト影響 | 優先度 |
|----|------|-----------|-----------|-------|-----------|-------|
| C1 | src/preload/settings.ts:56-57 | `updateConfig` を `Promise<void>` と注釈するが実体は `Config\|null` を返す（renderer 側 `SettingsWindowApi` は `Promise<Config\|null>`）。preload 境界で戻り値型が暗黙破棄＝既にドリフト済みの型の嘘。 | 注釈を `(patch: Partial<Config>): Promise<Config\|null>` に修正。ランタイム値は既に `Config\|null`。 | 低 | preload 注釈を assert するテストなし（mock 経由）。 | **P1** |
| C2 | src/preload/{overlay,settings,hotspot,addressbar}.ts ＋ 対応 renderer | 各 `xxxApi` の型が preload の contextBridge object 形状と renderer の `declare global Window` で二重に手動維持。C1 の型ドリフトが実害の証拠。 | preload 側で `export interface XxxApi` を単一定義し contextBridge object に注釈、renderer の Window 拡張は `import type` で再利用。型のみで build 時消去（ランタイム結合なし）。C1 の根本対策。 | 低 | なし。 | P2 |
| C5 | src/shared/types.ts:5-16, src/shared/schema.ts:54,61-67 | `Config` 型（手書き・7+ module が import）と `ConfigSchema` が相互 import なし・`z.infer` 等価検査なしで独立。schema.ts:54 は「z.infer は Config と完全一致」と主張するが何も強制していない（サイレントドリフト源）。 | **保守的案を採用**: `Config` は手書きのまま残し、`Config` と `z.infer<typeof ConfigSchema>` の相互代入可能性を assert する **コンパイル時等価テスト** を 1 件追加（型のみ・ランタイム無影響）。schema.ts:54 の自己言及的な等価コメントを「等価性は型テストで担保」と是正。（より踏み込んだ `export type Config = z.infer<...>` 化は構造変更のため §6 でユーザーに選択肢提示。） | 低 | 既存 config/schema テストは推論型＝現行型で緑維持。等価テスト 1 件追加。 | P2 |
| C7 | test/unit/ipc.test.ts:541-549 | `makeQuitEvent` が `as IpcEvent` で object 全体を強制 cast。コメント「sender は今後追加予定」は古い（ipc.ts:35 は既に `sender?:{id:number}`）。cast が構造型をマスクし将来のミスマッチを握りつぶす。 | `as IpcEvent` cast を外し構造的型検査に委ねる（object は既に適合）。古いコメントを是正。sender 未定義分岐で cast が要る場合のみ局所化。 | 低 | quit-event factory の型検査強化。assert 不変。 | P2 |
| C3 | src/preload/addressbar.ts:36-40, src/renderer/addressbar/main.ts:31-35 | `NavigateResult` を preload と renderer で同一定義。renderer は `result.config` を読まず（grep 0 件）、`config?` フィールドは renderer から見て dead。 | renderer は `import type { NavigateResult } from '../../preload/addressbar'` で再利用（再宣言を排除）。`config?` は将来契約の可能性があるため型は残す。 | 低 | なし。 | P3 |
| C4 | src/renderer/settings/settings-controller.ts:27 | `SchedulerState` union を shared/types.ts:27 と同一定義で再宣言（同ファイルは既に shared から `Config` を import）。状態追加時に renderer 側が古い集合のまま型付けされるドリフト源。 | 行 27 を `import type { SchedulerState } from '../../shared/types'` に置換し、外部利用があれば `export type { SchedulerState }` で再 export。 | 低 | settings-controller.test.ts はリテラル状態値を使用。同一 union で緑維持。 | P3 |
| C6 | test/unit/folder-change-handler.test.ts, index-integration.test.ts | mock を `as unknown as Watcher/PlaylistManager` で cast し対象メソッドのみ stub。実 interface が消去され、production がメソッド改名/追加してもテストが通り続ける。 | mock を `Pick<Watcher,'stop'\|'start'>` / `Pick<PlaylistManager,'resetCursor'>` 等で型付けし、`as unknown as` escape hatch を排除。 | 低 | mock↔production 境界をコンパイル時に強制。assert 不変。 | P3 |

### テーマ D: サイレント障害の是正・コメント是正

| ID | 対象 | 現状の問題 | 具体的変更 | 挙動影響 | リスク | テスト影響 | 優先度 |
|----|------|-----------|-----------|---------|-------|-----------|-------|
| D3 | src/renderer/overlay/main.ts:187,199,204,216 ＋ src/main/config.ts:38 | overlay の JSDoc/コメントが fade を「≈1000ms / opacity 1000ms」と記述するが実 CSS は 2000ms、デフォルトは 1000ms＝**3 つの数値が不整合**。読者が誤った timing を推論し得る。`fadeDurationMs` が configurable な fade を示唆するが未配線。 | overlay の 4 コメントを実 CSS 値「2000ms」参照（または「CSS 駆動、styles.css 参照」と値非依存）に是正。DEFAULT_CONFIG の `fadeDurationMs` に「現状未配線」コメントを付与し configurability の誤示唆を止める。**フィールド削除/配線は行わない（§5-O1）**。 | なし（コメントのみ） | 低 | なし。 | **P1** |
| D2 | src/main/index.ts:80-115,152-168 | GPU/diag ブロックが「logWarn はまだ定義されていない」という **誤コメント** を根拠に `process.stdout.write` で logger の JSON 形状を手書き複写。実際は `logWarn`/`logError` は巻き上げ関数宣言で当該行から呼出可能。 | inline `process.stdout.write` を `logWarn('gpu.procVersionReadFailed')` / `logWarn('gpu.hardwareAccelerationDisabled',{phase,hardwareAccelerationDisabled,gpuSwitches})` に置換し誤コメント削除。`logWarn` は `{level:'WARN',event,...meta,ts}` を出力し、手書き object と **キー順含めバイト等価**（確認済み）。 | なし（出力バイト等価） | 低 | e2e quit-flow.spec.ts:108 が `gpu.hardwareAccelerationDisabled` を assert。形状不変で通過。**置換後に e2e quit-flow を必ず実行し diff 確認**。 | P2 |
| D1 | src/renderer/overlay/main.ts:71-75 | `DomVideoElement.play()` が `void this.el.play()` で promise を破棄。`play()` の reject（NotAllowedError/AbortError 等）は `<video>` の 'error' イベントを発火しないため、`OverlayController.setOnError` に届かず **完全に無音**（ログ無し）。24h サイネージで黒画面のまま PLAYING に滞留し得る。 | `.catch((e)=>{console.error('[overlay] video.play() rejected', e)})` を付与。成功パスの観測出力は不変、現状無音の失敗パスに console.error を出すのみ（onError へのルーティングは挙動変更のため**行わない**）。 | なし（成功パス不変、現状無音の失敗パスにのみ console.error） | 低 | overlay-controller.test.ts は mock IVideoElement を使用。DomVideoElement は DOM glue で unit 非対象。 | P2 |
| D4 | src/renderer/settings/main.ts:160-162, settings-controller.ts:242 | test-play の disable/guard が `schedulerState` に依存するが、renderer で `setSchedulerState` を呼ぶ本番経路が無く（IPC チャネル無し）`_schedulerState` は永久に 'IDLE'。実ガードは Main 側にあり、UI コードは「busy 中に無効化」と読めるが実機能なし。 | コメントを強化し「schedulerState は renderer で更新されず、この disable は cosmetic/非機能。実ガードは Main 側」と明記。**メソッド/ガード削除は行わない**（settings-controller.test.ts が assert＝§5-O7）。 | なし（既に no-op、ドキュメントのみ） | 低 | ドキュメントのみ。テスト影響なし。 | P2 |
| D5 | src/main/ipc.ts:398 | コメントが `hotspot:address-bar-toggle` ハンドラは `toggleAddressBarZone()` へ委譲すると主張するが、実体は `deps.onToggleAddressBar?.()` を直接呼ぶ（index.ts が `setToolbarVisible` に配線）。`InputCoordinator.toggleAddressBarZone()` は本番未呼出（呼出元はテストのみ）。 | ipc.ts:398 コメントを「`deps.onToggleAddressBar` へ委譲」と是正（ゼロリスク）。**メソッド削除は §5-O5 に保留**（テストを伴うため）。 | なし（コメントのみ） | 低 | コメント修正のみ無影響。 | P2 |
| D9 | test/e2e/harness/electron-launch.ts:177-220 | `identifyViews()` が `url.includes(keyword)` の順序 if/else と「about: 以外＝siteView」の catch-all で view 判定。外部 site URL が 'settings'/'overlay' 等を含むと誤分類。WCV 依存 test は view null で self-skip するため、誤分類はテストを**静かに弱める**。 | path segment 一致（例 `endsWith('/settings/index.html')` / path 正規表現）に変更し、siteView 判定を「既知 renderer path のいずれにも一致しない http(s) URL」と明示化。teardown の silent catch は cleanup として許容（debug ログ可）。 | なし | 低 | 検出が頑健化し WCV test が静かに skip/誤路しなくなる。正常時は変化なし。 | P2 |
| D7 | src/main/media-protocol.ts:374-413 | `hasRange`（375 で算出）と等価な条件を 380 で `rangeHeader===null\|\|rangeHeader===''` と再記述。同一述語が 2 表現。 | 380 を `if (!hasRange)` に変更し算出済みフラグを再利用。制御フロー/レスポンス同一。 | なし | 低 | media-protocol.test.ts は 200/206/416 を網羅。不変。 | P3 |
| D6 | src/shared/types.ts:1-2,29 | 冒頭「stub」「全実装は T10 で行う」「IPC payload 型 — T10 で拡充」コメントが現実と不一致（T10 完了済み・型は使用中）。未完 stub と誤認させる。 | 当該コメントを削除し、ファイル役割を 1 行で正確に記述（shared domain/IPC types）。 | なし | 低 | コメントのみ。 | P3 |

### テーマ E: 大きいファイル（index.ts ~972 行）

- **本パスでの対応**: A1（loadView 統合）/ A3（handleMedia 統合）/ A4（attachCrashRecovery）/ A5（reloadSite・toggleAddressBar）の helper 抽出により index.ts を **構造リスクなしで ~80-100 行削減**する。これらは上表に個別計上済み。
- **本格的なファイル分割は本パスでは行わない（保留）**: view 生成 / session・protocol 設定 / crash-recovery / load 配線を別モジュールへ切り出す full split は、index.ts が unit 非対象であり初期化順序の微妙な regression リスクを伴うため、**別途レビューを伴う独立タスク**として §5-O11 に記録し判断をユーザーに委ねる。

### ビルド/ツール設定

| ID | 対象 | 現状の問題 | 具体的変更 | リスク | テスト影響 | 優先度 |
|----|------|-----------|-----------|-------|-----------|-------|
| E2 | tsconfig.json / tsconfig.node.json / tsconfig.e2e.json | 3 tsconfig が strict 系設定（target/strict/skipLibCheck/noEmit 等）を `extends` 無しで各々複写。`src/shared/**` は 2 config に含まれ、手動コピーでのみ整合。 | `tsconfig.base.json` に共通 compilerOptions を集約し 3 config が `extends`、差分（module/moduleResolution/lib/types/include と e2e の緩和）のみ override。**`lib`/`types` は extends で置換されるため子で再宣言**。 | 中 | typecheck 系は再実行し **変更前後で診断が完全一致することを必須確認**。フィールド忘れで実効オプションが変わる微妙リスクあり。 | P3 |

---

## 4. エラー＆レスキューマップ（主要リファクタ単位）

| 処理 | 想定される異常 | ハンドリング方法 | ユーザーへの影響 |
|------|---------------|-----------------|-----------------|
| A1 `loadView` 統合 | dev/prod 分岐や segment 文字列の写し間違いで URL/path が変化 | 統合前後で生成される URL/file path を 4 view 分突き合わせ、`build` + 起動 smoke で各 view ロードを確認 | なし（成功時は全 view 従来通り表示） |
| A2 `_armWatchdog` 抽出 | タイマー長/イベント名/`_forceIdle` 呼出の取り違え | scheduler.test.ts（watchdog event/state/duration を assert）を緑で維持し回帰検知 | なし（watchdog 発火タイミング不変） |
| A3 `handleMedia` 統合 | `currentVideoFolder` を closure でなく値束縛してしまいフォルダ変更に追従しなくなる | 「毎リクエストで `createElectronProtocolHandler(currentVideoFolder,...)` を呼ぶ」live-folder 意味論を維持。フォルダ変更後の `media://` 取得を手動確認 | なし（動画再生・差し替え不変） |
| A4 `attachCrashRecovery` | reload 後の状態復元（zone/toolbar）を取り違え/欠落 | overlay/settings=復元なし、hotspot=zone 再適用、addressBar=toolbar 再適用を明示配線。ログ `renderer.crashed` 形状を維持 | なし（クラッシュ復旧挙動不変） |
| D2 GPU ログの logger 化 | `logWarn` 出力が手書き JSON とバイト不一致になり e2e assert が落ちる | `logWarn` の `{level,event,...meta,ts}` がキー順含め一致することを確認済み。置換後 **e2e quit-flow を必ず実行** | なし（ログ出力バイト等価） |
| D1 `play()` の `.catch` 付与 | 既存 'error' イベント経路との二重ハンドリング/挙動変化 | 成功パスは無改変、reject 時に console.error を出すのみ。onError へはルーティングしない | なし（成功時不変。失敗時に初めて診断ログが出る＝改善） |
| C1/C2/C5 型修正 | 型変更で 7+ 消費 module の型崩れ | 推論型が現行手書き型と構造同一であることを確認し `typecheck` を緑で維持。C5 は等価テストを追加 | なし（ランタイム値・形状不変） |
| B3/B4/B5 テスト削減 | 削除で唯一カバレッジを失う | 削除対象は他ファイルに同一カバレッジが残ること（ipc.test.ts / schema.test.ts）を grep+対応確認。実行 test 集合の純減のみ | なし（製品挙動不変） |
| D9 `identifyViews` 厳密化 | path 一致条件のミスで全 view が誤判定→大量 skip | 既知 renderer path の `endsWith` 一致表を網羅し、正常検出時に挙動不変を E2E で確認 | なし（E2E 検出が頑健化） |
| E2 tsconfig base 化 | `lib`/`types` 置換忘れで実効 strict 設定が変化 | 変更前後で `typecheck`/`typecheck:e2e` の診断出力を **完全 diff** し一致を確認 | なし（型検査結果不変） |

---

## 5. スコープ外（要ユーザー判断）

以下は `挙動影響 ≠ なし`（または契約/スキーマ/テスト assert を変える）ため **本パスでは実施しない**。判断をユーザーに委ねる。各項目に「本パスで可能な無害な代替」を併記。

| ID | 項目 | なぜスコープ外か | 本パスでの無害な代替 |
|----|------|----------------|--------------------|
| O1 | `fadeDurationMs` の **削除 or CSS への配線** | (a) 削除は config schema 意味論を変える（`z.object` が unknown キーを strip → 既存永続 config の当該キーが load 時に黙って落ち、`settings:update` で送られると拒否される）。schema.test.ts:71-80 / config.test.ts:396-405 を破壊。(b) 配線は fade を 2000ms→1000ms に変える（UI 観測可能）。 | D3 のコメント是正のみ実施（フィールドが現状 inert であることを明示）。削除/配線は未実施。 |
| O2 | 空 playlist の `playlist.empty` 二重ログ統合 | PlaylistManager 側と Scheduler 側の両方を別々のテスト（playlist.test.ts / playback-orchestrator.test.ts:63）が assert。統合は assert 済み WARN 行を 1 本除去する。 | なし（現状維持）。実施するなら playlist テスト更新が前提。 |
| O3 | 既定セッション `media://` ハンドラ（index.ts 271 付近）の削除 | 全 view が明示 partition を持ち消費者ゼロ＝技術的には dead（挙動影響なし）だが **セキュリティ隣接**のため独断削除を避ける。 | 削除の代わりに「defensive no-op」コメントを付与（ゼロリスク・本パス可）。削除可否はユーザー確認。 |
| O4 | addressbar `renderConfig` への focus ガード追加 | settings は focus 中 `urlInput.value` 上書きを抑止。addressbar に同ガードを足すと「入力中に config 更新が来たとき上書きするか否か」というユーザー観測挙動が変わる。 | なし（現状維持）。採否はユーザー判断。 |
| O5 | `InputCoordinator.toggleAddressBarZone()` メソッド削除 | 本番未呼出だがテスト 2 件を保持。削除は（非観測だが）public API 変更＋テスト削除。 | D5 のコメント是正のみ実施。メソッド削除は保留。 |
| O6 | `Scheduler.triggerFireForTest()` の本番面からの除去 | 唯一の呼出元は scheduler.test.ts:99（US-03）。除去は US-03 の書き換えを要し、test-only API を製品面から消す決定。 | なし（現状維持）。実施するなら US-03 を実経路で再設計。 |
| O7 | `SettingsController.setSchedulerState`/ガードの除去 | settings-controller.test.ts:293-388 が assert（非 IDLE で `testPlay()` が false）。除去はテスト挙動を変える。 | D4 のドキュメント是正のみ実施。 |
| O8 | vitest `passWithNoTests:false` 化 | 0 件マッチ時に CI が green→fail に変わる（現リポジトリでは発生しないが CI-outcome の変更）。 | 推奨はするが本パスでは未実施。採否はユーザー判断（silent-failure 対策として有益）。 |
| O9 | lint glob を `eslint src test` 等へ拡大 | 製品挙動は不変だが test/ の既存違反が表面化し修正/ルール例外の churn を生む可能性。 | 推奨はするが本パスでは未実施。実施時は一度走らせ修正 or ratchet。 |
| O10 | 5 dead IPC payload 型の **配線（option b）** | main/preload/renderer の send/on を共通型参照に変える＝本エリア外を編集。 | B1 の削除（option a）を実施。配線は保留。 |
| O11 | index.ts の本格的ファイル分割 | unit 非対象ファイルの大規模分割は初期化順序 regression リスクを伴う。 | A1/A3/A4/A5 の in-place helper 抽出で ~80-100 行削減のみ実施。分割は独立タスクとして保留。 |
| O12 | watcher.int.test.ts（real chokidar + real FS + 10s polling）の隔離 | informational。製品 timing は変えない前提。隔離は test 実行構成（vitest project 分離 / test:integration script）の決定を要す。 | なし（現状維持）。CI flake 低減のため隔離を提案するに留める。 |
| O13 | C5 の `export type Config = z.infer<typeof ConfigSchema>` 化 | 7+ module が import する `Config` の供給元を schema.ts に変える構造変更（推論型は現行と同一だが結合方向が変わる）。 | C5 ではより保守的な「等価コンパイル時テスト追加」を実施。z.infer 化はオプションとして提示。 |

---

## 6. 実行順序と検証戦略

### 基本原則（グリーン維持）
各項目の適用後に必ず次を実行し、すべて緑であることを確認してから次へ進む:

```
npm run typecheck && npm run typecheck:e2e   # 型
npm run lint                                  # 静的解析
npm test                                      # unit 501 件
```

ログ等価が要点の項目（D2）は加えて該当 e2e を実行:

```
npx playwright test test/e2e/quit-flow.spec.ts
```

### 推奨実行順序（低リスク・独立性の高い順）

1. **コメント/ドキュメント是正（ゼロ〜低リスク）**: D3, D4, D5, D6, B9, B7, B8, C7（cast/コメント）, D7。— 製品ロジック不変、最速で緑確認。
2. **デッドコード除去（type-only / テスト）**: B1, B2, B5, B6, B4, B3。— grep で消費者ゼロを再確認しつつ削除。各削除後に `typecheck`+`test`。
3. **型の厳格化**: C1 → C2（C1 を吸収する根本対策）→ C3, C4, C5（等価テスト追加）, C6。— `typecheck` 中心に検証。
4. **本番コードの重複統合（挙動等価が要点）**: A2（scheduler, テスト厚い）→ A1, A3, A4, A5（index.ts）→ A6, A7（overlay）→ A8, A9。— A2 は scheduler.test.ts で即回帰検知。index.ts 系は build + 起動 smoke。
5. **サイレント障害の表面化**: D1（play().catch）, D2（GPU→logWarn, e2e 必須）, D9（identifyViews）。
6. **テスト足場の集約**: A10, A11, A12, A13。
7. **ビルド設定（中リスク・最後）**: E2（tsconfig base 化）。変更前後で typecheck 診断を完全 diff。

各テーマ完了時を同期ポイントとし、unit 全緑 + typecheck + lint を品質ゲートとする。

### ロールバック容易性
- 全項目が **小粒度・独立** で、1 項目 = 1 論理コミット相当。問題発生時は当該項目のみ revert すれば緑へ戻せる。
- 型のみ/コメントのみの項目（テーマ C/D の大半）はランタイム無影響でロールバックコスト最小。
- リスク「中」は E2 のみ。これを最後に回し、診断 diff で gate することで前段成果を巻き込まない。
- 本リポジトリは現状 git 管理外のため、着手前に作業ツリーのスナップショット（または git 初期化）を取得し、項目ごとのチェックポイントを残すことを推奨。

---

## 7. 想定効果（概算）

| 区分 | 概算効果 |
|------|---------|
| 行数削減（テスト） | e2e-20.spec.ts の到達不能本体 **~960 行削除**（B3）、index-integration の重複 IPC ブロック ~140 行 + ipc.test の schema 重複 ~60 行削除（B4/B5）。合計 **~1,160 行超** の純減。 |
| 行数削減（本番） | index.ts: loadView 統合 ~40 行、crash-recovery ~20 行、media/callback 統合 ~20 行 → **~80-100 行削減**（A1/A3/A4/A5）。scheduler ~12 行（A2）、overlay ~15 行（A6/A7）。 |
| 重複削減 | 4×load helper・4×watchdog・2×media closure・4×crash handler・5×reload/toggle callback・2×fade 関数・2×IPC mock 足場・2×FS fixture・30+×ProtocolRequest boilerplate を **単一ソース化**。ドリフト面を大幅縮小。 |
| エラー温床の解消 | preload 型の嘘（C1）と Window API 二重定義（C2）の根本是正、Config↔Schema ドリフトのコンパイル時検知（C5）、`as unknown as`/`as IpcEvent` escape hatch 除去（C6/C7）、未チェック DOM cast の一元防御（A8）。 |
| サイレント障害の表面化 | `video.play()` reject の無音化を診断ログ化（D1）、GPU ログの logger 集約で形状一元化（D2）、誤コメント（fade 数値・logWarn 未定義・toggleAddressBarZone 委譲・schedulerState 機能性）の是正で誤推論リスクを除去（D3/D2/D5/D4）。 |
| 配線堅牢化 | E2E view 検出の substring→path 厳密化で「静かな skip/誤路」リスクを除去（D9）。 |

すべて挙動・UI・IPC 契約・config schema 意味論・テスト依存ログを不変に保ったまま、コードベースの重複・デッドコード・型の嘘・サイレント障害を体系的に縮小する。挙動を変える可能性のある誘惑的クリーンアップ（fadeDurationMs, 二重ログ, focus ガード等）はすべて §5 に隔離し、ユーザー判断に委ねた。

---

## 8. レビュー結果と実行前必須修正（2026-06-28 / Codex異モデル + Opusアーキテクト2パス）

本計画を Codex（異モデル独立レビュー）と Opus（アーキテクト2パス）でレビューした。
**事実確認はすべて correct**（fadeDurationMs 未配線 / 5 view 明示 partition＝既定セッション media:// 消費者ゼロ / logWarn はキー順までバイト等価 / dead 型5+PlaylistState 未 import / e2e-20 は 22/23 fixme / preload updateConfig は Promise<void> 宣言で実体 Config|null — 全て検証済み）。
総合判定: **このままでは実行不可**。実行前に以下を反映すること。

### 🔴 CRITICAL（実行前に必修正）
- **R1: C2/C3 の型移設先を修正。** renderer が preload から型を import すると、renderer tsconfig（`src/renderer/**`＋`src/shared/**` のみ）に preload ファイル（`import ... from 'electron'`）が取り込まれ typecheck を壊しうる。→ 共有 API/ペイロード型は **`src/shared/` に移設**し、preload と renderer の双方がそこから import する（C1/C2/C3/C4 の「単一ソース化」意図は維持しつつ cross-import を排除）。
- **R2: D2 の検証を是正。** 計画は「GPUログを logWarn 化後、quit-flow e2e で `gpu.hardwareAccelerationDisabled` を assert して守る」とするが、**quit-flow.spec.ts は実際には assert しておらず test.fixme コメントのみ**＝安全網が機能しない（＝レスキューマップ自体にサイレント障害）。→ D2 の検証は **実 stdout の前後バイト比較、または専用ユニットで出力 JSON 文字列の一致を assert** に置き換える。logWarn 出力自体のバイト等価性は確認済み。

### 🟡 判断保留（ユーザー確認待ち）
- **J1: D1（video.play() に .catch(console.error)）** — Codex は「失敗時に新規コンソール出力＝観測可能なので §5 へ」。一方プロジェクト方針「サイレント障害にしない」に合致（計画も成功パス不変・失敗時のみ診断ログと明記）。→ **在スコープ維持 or §5 送り** を要判断（推奨: 在スコープ維持）。
- **J2: B3（e2e-20 の ~960 行 fixme 本体削除）** — 実行テスト集合は不変だがシナリオ草案を失う＝「カバレッジ不変」ではなく負債整理。→ 草案を簡潔なチェックリスト化して削除でよいか要確認。
- **J3: A8/A9** — 異常系（要素欠落・不正 data-minutes）の失敗の仕方が変わる（正常系は不変）。kiosk ではラベル付き即時失敗が安全。→ 在スコープ維持を推奨。
- **J4: E2（tsconfig base 化）** — 検証は診断 diff だけでなく **`tsc --showConfig` の実効オプション diff** で parity 証明する（子で lib/types/module/moduleResolution/allowImportingTsExtensions/isolatedModules/esModuleInterop 等の差分を再宣言）。最後・中リスクのまま。

### 🛟 安全策
- **R6: 本リポジトリは git 管理外。** 38 項目の連続リファクタにつき、着手前に **`git init` ＋ 項目ごとコミット（1 項目 = 1 コミット）** を強く推奨（問題時に当該項目のみ即 revert）。

### 実行ゲート（次セッションの再開手順）
ユーザー承認 → 計画に R1/R2/R6 を反映 → sonnet 実装（§6 推奨順・各項目後に typecheck+lint+全テスト緑維持）→ 各テーマ完了時に Opus 品質ゲート。
**現状: 実装は未着手。ユーザー承認＋ J1/J2 の判断＋ §5 から included したい項目の有無を待っている段階。**

---

## 9. 実行確定事項（2026-06-28 ユーザー承認・本セクションが§8の保留項目を上書きする）

> 本セクションは §8「判断保留（ユーザー確認待ち）」「🔴 CRITICAL」「🛟 安全策」の各項目に対するユーザー最終決定を記録する。§1〜§8 の本文は改変しない。以降の実装はここに記載した確定事項を正として進める。

### 9-1. 全体方針（確定）

| 項目 | 決定内容 |
|------|---------|
| 実行可否 | リファクタリング実行を **承認・着手する** |
| リポジトリ管理 | GitHub（`git@github.com:sawanori/ubuntu-signage.git`）管理下で作業ブランチ `refactor/internal-quality` を使用 |
| コミット粒度 | **1項目 = 1コミット**（R6 充足） |

---

### 9-2. CRITICAL修正の反映（確定）

#### R1 — C1/C2/C3/C4 の型移設先の是正

renderer が preload ファイルから型を cross-import すると renderer tsconfig が `import ... from 'electron'` を巻き込み typecheck を壊すため、共有 API 型・ペイロード型は **新規 `src/shared/` モジュール**（例: `src/shared/window-api.ts`）へ移設し、preload と renderer の双方がそこから `import type` する。

| サブ項目 | 対応方針 |
|---------|---------|
| **C1** | `src/preload/settings.ts` の `updateConfig` 注釈を `(patch: Partial<Config>): Promise<Config \| null>` に是正（実体に一致）。単独で実施可。 |
| **C2** | 各 `XxxApi`（overlay / settings / hotspot / addressbar）interface を `src/shared/` に単一定義し、preload の contextBridge object に注釈、renderer の `declare global Window` 拡張も同じ shared 型を `import type` で再利用。 |
| **C3** | `NavigateResult` も `src/shared/` に置き、preload と renderer 双方がそこから import（renderer 側の再宣言を排除）。`config?` フィールドは将来契約のため型は残す。 |
| **C4** | `SchedulerState` は既に `src/shared/types.ts` に定義済みのため、`renderer/settings/settings-controller.ts` はそこから `import type` するだけ（移設不要）。 |

#### R2 — D2 の検証方法の是正

§8 計画では「quit-flow e2e で assert する」としていたが、`quit-flow.spec.ts` は実際には assert せず test.fixme コメントのみで安全網が機能しない。下記に変更する。

- **代替検証**: `logWarn` の出力 JSON 文字列が従来の手書き JSON 文字列とバイト等価であることを assert する **専用ユニットテストを新設**して担保する（実 stdout キャプチャ比較でも可）。
- `logWarn` 出力 `{level, event, ...meta, ts}` がキー順含めバイト等価であることは確認済み。

---

### 9-3. 判断保留の確定

| 保留ID | 確定内容 |
|--------|---------|
| **J1** | **在スコープ維持（確定）**: D1（`video.play()` に `.catch(console.error)` 付与）を本パスで実施する。正常系の観測出力は不変、現状無音の異常系にのみ診断ログを出す。 |
| **J2** | **削除確定**: B3（e2e-20.spec.ts の ~960 行 fixme 本体）は describe 骨格 + 唯一実行される smoke test のみ残し、未実装シナリオは簡潔なチェックリスト/コメント化して削除する。実行テスト集合は不変。 |
| **J3** | **在スコープ維持（確定）**: A8/A9（DOM 要素欠落時のラベル付き即時エラー・data-minutes 解釈統一）を本パスで実施する。正常系は不変、現状無音の異常系にのみ診断を出す。 |
| **J4** | **確定**: E2（tsconfig base 化）の parity 証明は型診断 diff に加え、**`tsc --showConfig` の実効オプション diff** で行う。子 config で `lib` / `types` / `module` / `moduleResolution` / `allowImportingTsExtensions` / `isolatedModules` / `esModuleInterop` 等の差分を再宣言する。 |

---

### 9-4. §5（スコープ外）からの取り込み（確定）

以下の §5 項目を本パスに取り込む（「推奨する方法」を採用）:

| 項目ID | 確定内容 |
|--------|---------|
| **O8** | **実施**: vitest 設定を `passWithNoTests: false` 化（テスト 0 件マッチ時に green → fail。サイレント障害対策）。 |
| **O9** | **実施**: lint 対象 glob を `test/` ディレクトリへ拡大。既存違反が出た場合は最小修正 or ルール ratchet で緑化する（churn は最小限に）。 |
| **O3** | **推奨方法を実施（削除しない）**: 既定セッションの `media://` ハンドラ（index.ts 271 付近）は **削除せず**、§5 記載の「defensive no-op コメント付与」（ゼロリスクの無害な代替）を実施する。セキュリティ隣接のため独断削除は回避。 |

上記以外の §5 項目（O1 / O2 / O4 / O5 / O6 / O7 / O10 / O11 / O12 / O13）は **§5 のまま保留**（今回は実施しない）。

---

### 9-5. §6 実行順序への反映（追記）

新規追加分（O3 / O8 / O9）の実行位置を明記する:

| 追加項目 | 実行タイミング |
|---------|--------------|
| **O8 / O9**（ツール設定） | §6 ステップ 1（コメント/ドキュメント是正）の直後。独立性が高いので早めに実施してよい。ただし O9 で `test/` 配下の lint 違反が出る場合があるため、テスト足場集約（A10〜A13 / ステップ 6）の前に一度走らせる。 |
| **O3**（defensive コメント） | A3（handleMedia 統合）と同じ index.ts 編集フェーズ（ステップ 4）で同時に扱う。 |
| **D2 の検証**（R2 反映） | D2 実施後、e2e quit-flow 依存ではなく専用ユニットテストで stdout キャプチャ比較を行う（§6 ステップ 5 の注記として反映）。 |
