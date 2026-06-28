/**
 * src/main/wsl-detect.ts — 修正 A
 *
 * WSL 環境検出と GPU 無効化判定。
 *
 * shouldDisableGpu は純関数（副作用なし・DI 不要）。
 * 判定優先順位:
 *   1. ENABLE_GPU=1 → 常に false（最優先の脱出口）
 *   2. DISABLE_GPU=1 → true（強制無効化）
 *   3. WSL_DISTRO_NAME が空でない → true
 *   4. WSLENV が空でない → true
 *   5. /proc/version に "microsoft" を含む（大文字小文字無視） → true
 *   6. 上記いずれも非該当 → false
 */

export interface ShouldDisableGpuParams {
  /** process.env 相当の環境変数マップ */
  env: Record<string, string | undefined>
  /** /proc/version の内容。読み取り失敗時は null を渡す */
  procVersion: string | null
}

/**
 * アプリ起動時に GPU ハードウェアアクセラレーションを無効にすべきかどうかを返す純関数。
 *
 * WSL2 環境では GPU アクセラレーションが不安定になるため、検出時に無効化する。
 * ENABLE_GPU=1 を設定することで WSL 上でも GPU を使用できる（テスト・デバッグ用途）。
 */
export function shouldDisableGpu({ env, procVersion }: ShouldDisableGpuParams): boolean {
  // ENABLE_GPU=1 は最優先の脱出口 — 他の条件より先にチェックする
  if (env.ENABLE_GPU === '1') return false

  // DISABLE_GPU=1 は強制無効化
  if (env.DISABLE_GPU === '1') return true

  // WSL 環境変数による検出
  if (env.WSL_DISTRO_NAME) return true
  if (env.WSLENV) return true

  // /proc/version による検出（null = 読み取り失敗 = 非 Linux や権限なし → false 扱い）
  if (procVersion !== null && procVersion.toLowerCase().includes('microsoft')) return true

  return false
}

/**
 * GPU フォールバックフェーズを返す純関数。
 *
 * GPU_FALLBACK_PHASE 環境変数で切替（デフォルト 2）。
 * '1' → 1、'2' → 2、'3' → 3、'4' → 4。
 * それ以外（undefined・空文字・'0'・不正値等）→ 2（デフォルト）。
 */
export function gpuFallbackPhase(env: Record<string, string | undefined>): 1 | 2 | 3 | 4 {
  const val = env.GPU_FALLBACK_PHASE
  if (val === '1') return 1
  if (val === '2') return 2
  if (val === '3') return 3
  if (val === '4') return 4
  // undefined・空文字・その他不正値はすべてデフォルト 2
  return 2
}

/**
 * WSL 環境で適用すべき Chromium command-line スイッチの配列を返す純関数。
 *
 * `shouldDisableGpu(params)` が false の場合は空配列を返す。
 * ENABLE_GPU=1 の脱出口は `shouldDisableGpu` が既に false を返すため自動的に保護される。
 *
 * GPU_FALLBACK_PHASE 環境変数で切替（デフォルト 2）:
 *   phase 1: disable-gpu + disable-gpu-compositing（最小侵襲）
 *   phase 2: disable-gpu + disable-gpu-compositing + in-process-gpu（デフォルト）
 *   phase 3: in-process-gpu + use-gl=angle + use-angle=swiftshader + enable-unsafe-swiftshader
 *            （Chromium 134 では use-gl=swiftshader は無効。ANGLE 経由で swiftshader を使う）
 *            ※ disable-gpu / disable-gpu-compositing は含めない（swiftshader GL パスと競合するため）
 *   phase 4: in-process-gpu のみ（GPU プロセス分離のみ回避し実 GPU は使う）
 *            ※ disable-gpu / use-gl 系は含めない
 *
 * @returns 各要素を `app.commandLine.appendSwitch(sw.name, sw.value)` に渡すスイッチのオブジェクト配列。
 *          呼び出し側が破壊しても安全なように毎回新しい配列・新しいオブジェクトインスタンスを返す。
 */
export function gpuCommandLineSwitches(
  params: ShouldDisableGpuParams,
): Array<{ name: string; value?: string }> {
  if (!shouldDisableGpu(params)) return []

  const phase = gpuFallbackPhase(params.env)

  if (phase === 1) {
    // フェーズ 1: GPU プロセス起因の描画失敗を防ぐ最小スイッチセット
    return [{ name: 'disable-gpu' }, { name: 'disable-gpu-compositing' }]
  }
  if (phase === 2) {
    // フェーズ 2: in-process-gpu を追加して GPU プロセス分離を回避する（デフォルト）
    return [
      { name: 'disable-gpu' },
      { name: 'disable-gpu-compositing' },
      { name: 'in-process-gpu' },
    ]
  }
  if (phase === 3) {
    // フェーズ 3: ANGLE 経由 swiftshader ソフトウェア GL パス（disable-gpu 系は含めない — 競合するため）
    // Chromium 134 では use-gl=swiftshader が無効（none 扱い）のため use-gl=angle + use-angle=swiftshader を使う
    return [
      { name: 'in-process-gpu' },
      { name: 'use-gl', value: 'angle' },
      { name: 'use-angle', value: 'swiftshader' },
      { name: 'enable-unsafe-swiftshader' },
    ]
  }
  // フェーズ 4: GPU プロセス分離のみ回避し実 GPU を使う（disable-gpu / use-gl 系は含めない）
  return [{ name: 'in-process-gpu' }]
}
