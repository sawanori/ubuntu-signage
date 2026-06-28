/**
 * 4-A. shouldDisableGpu / gpuFallbackPhase / gpuCommandLineSwitches ユニットテスト
 *
 * src/main/wsl-detect.ts の純関数を検証する。
 * 依存: なし（純関数）
 */

import { describe, it, expect } from 'vitest'
import { shouldDisableGpu, gpuCommandLineSwitches, gpuFallbackPhase } from '../../src/main/wsl-detect'

describe('shouldDisableGpu', () => {
  // ─── 正常系 ────────────────────────────────────────────────────────────────

  it('A-01: procVersion に "microsoft" を含む場合 → true', () => {
    expect(
      shouldDisableGpu({
        env: {},
        procVersion: 'Linux version 5.15.90.1-microsoft-standard-WSL2',
      }),
    ).toBe(true)
  })

  it('A-02: env.WSL_DISTRO_NAME = "Ubuntu" → true', () => {
    expect(
      shouldDisableGpu({
        env: { WSL_DISTRO_NAME: 'Ubuntu' },
        procVersion: null,
      }),
    ).toBe(true)
  })

  it('A-03: env.WSLENV = "USERPROFILE/p" → true', () => {
    expect(
      shouldDisableGpu({
        env: { WSLENV: 'USERPROFILE/p' },
        procVersion: null,
      }),
    ).toBe(true)
  })

  it('A-04: env.DISABLE_GPU = "1" → true（強制無効化）', () => {
    expect(
      shouldDisableGpu({
        env: { DISABLE_GPU: '1' },
        procVersion: null,
      }),
    ).toBe(true)
  })

  it('A-05: WSL 条件に該当しない場合 → false', () => {
    expect(
      shouldDisableGpu({
        env: {},
        procVersion: 'Linux version 5.15.0-73-generic (buildd@lcy02-amd64-032)',
      }),
    ).toBe(false)
  })

  it('A-06: ENABLE_GPU=1 かつ procVersion に "microsoft" を含む → false（脱出口が優先）', () => {
    expect(
      shouldDisableGpu({
        env: { ENABLE_GPU: '1' },
        procVersion: 'Linux version 5.15.90.1-microsoft-standard-WSL2',
      }),
    ).toBe(false)
  })

  it('A-07: ENABLE_GPU=1 かつ WSL_DISTRO_NAME あり → false（脱出口が優先）', () => {
    expect(
      shouldDisableGpu({
        env: { ENABLE_GPU: '1', WSL_DISTRO_NAME: 'Ubuntu' },
        procVersion: null,
      }),
    ).toBe(false)
  })

  it('A-08: ENABLE_GPU=1 かつ DISABLE_GPU=1 → false（脱出口が最優先）', () => {
    expect(
      shouldDisableGpu({
        env: { ENABLE_GPU: '1', DISABLE_GPU: '1' },
        procVersion: null,
      }),
    ).toBe(false)
  })

  // ─── 異常系 / エッジケース ─────────────────────────────────────────────────

  it('A-09: procVersion=null（読み取り失敗）かつ env 非該当 → false', () => {
    expect(
      shouldDisableGpu({
        env: {},
        procVersion: null,
      }),
    ).toBe(false)
  })

  it('A-10: procVersion=null かつ WSL_DISTRO_NAME あり → true（env のみで判定）', () => {
    expect(
      shouldDisableGpu({
        env: { WSL_DISTRO_NAME: 'Debian' },
        procVersion: null,
      }),
    ).toBe(true)
  })

  it('A-11: procVersion に大文字 "MICROSOFT" を含む → true（toLowerCase 比較）', () => {
    expect(
      shouldDisableGpu({
        env: {},
        procVersion: 'Linux version 5.15.90.1-MICROSOFT-standard-WSL2',
      }),
    ).toBe(true)
  })

  it('A-12: procVersion = ""（空文字） → false（"microsoft" を含まない）', () => {
    expect(
      shouldDisableGpu({
        env: {},
        procVersion: '',
      }),
    ).toBe(false)
  })

  it('A-13: env.WSL_DISTRO_NAME = ""（空文字） → false（空文字は非該当）', () => {
    expect(
      shouldDisableGpu({
        env: { WSL_DISTRO_NAME: '' },
        procVersion: null,
      }),
    ).toBe(false)
  })

  it('A-14: env.WSLENV = ""（空文字） → false（空文字は非該当）', () => {
    expect(
      shouldDisableGpu({
        env: { WSLENV: '' },
        procVersion: null,
      }),
    ).toBe(false)
  })

  it('A-15: env.DISABLE_GPU = "0"（"1" 以外） → false', () => {
    expect(
      shouldDisableGpu({
        env: { DISABLE_GPU: '0' },
        procVersion: null,
      }),
    ).toBe(false)
  })

  it('A-16: ENABLE_GPU="0" かつ WSL_DISTRO_NAME あり → true（脱出口は "1" のみ）', () => {
    expect(
      shouldDisableGpu({
        env: { ENABLE_GPU: '0', WSL_DISTRO_NAME: 'Ubuntu' },
        procVersion: null,
      }),
    ).toBe(true)
  })
})

describe('gpuCommandLineSwitches', () => {
  // デフォルト phase が 2 になったため、phase 1 を検証するテストは GPU_FALLBACK_PHASE:'1' を明示する
  const PHASE1_SWITCHES = [{ name: 'disable-gpu' }, { name: 'disable-gpu-compositing' }]

  // ─── 正常系 ────────────────────────────────────────────────────────────────

  it('B-01: procVersion に "microsoft" を含む → フェーズ1スイッチ配列を返す', () => {
    expect(
      gpuCommandLineSwitches({
        env: { GPU_FALLBACK_PHASE: '1' },
        procVersion: 'Linux version 5.15.90.1-microsoft-standard-WSL2',
      }),
    ).toEqual(PHASE1_SWITCHES)
  })

  it('B-02: env.WSL_DISTRO_NAME = "Ubuntu" → フェーズ1スイッチ配列を返す', () => {
    expect(
      gpuCommandLineSwitches({
        env: { WSL_DISTRO_NAME: 'Ubuntu', GPU_FALLBACK_PHASE: '1' },
        procVersion: null,
      }),
    ).toEqual(PHASE1_SWITCHES)
  })

  it('B-03: env.DISABLE_GPU = "1"（強制有効化） → フェーズ1スイッチ配列を返す', () => {
    expect(
      gpuCommandLineSwitches({
        env: { DISABLE_GPU: '1', GPU_FALLBACK_PHASE: '1' },
        procVersion: null,
      }),
    ).toEqual(PHASE1_SWITCHES)
  })

  it('B-04: env.ENABLE_GPU = "1" かつ WSL → [] （脱出口が優先）', () => {
    expect(
      gpuCommandLineSwitches({
        env: { ENABLE_GPU: '1', WSL_DISTRO_NAME: 'Ubuntu' },
        procVersion: null,
      }),
    ).toEqual([])
  })

  it('B-05: 非WSL（procVersion=null, 環境変数なし） → []', () => {
    expect(
      gpuCommandLineSwitches({
        env: {},
        procVersion: null,
      }),
    ).toEqual([])
  })

  // ─── 配列の独立性・安定性 ──────────────────────────────────────────────────

  it('B-06: 返り値は毎回新しい配列インスタンス（呼び出し側が破壊しても安全）', () => {
    const params = { env: { WSL_DISTRO_NAME: 'Ubuntu', GPU_FALLBACK_PHASE: '1' }, procVersion: null }
    const result1 = gpuCommandLineSwitches(params)
    const result2 = gpuCommandLineSwitches(params)
    expect(result1).not.toBe(result2)  // 同一インスタンスではない
    result1.push({ name: 'mutated' })
    expect(result2).toEqual(PHASE1_SWITCHES)  // 一方を変更しても他方に影響なし
  })

  it('B-07: 要素順が安定している（disable-gpu が先、disable-gpu-compositing が後）', () => {
    const result = gpuCommandLineSwitches({
      env: { WSL_DISTRO_NAME: 'Ubuntu', GPU_FALLBACK_PHASE: '1' },
      procVersion: null,
    })
    expect(result[0]).toEqual({ name: 'disable-gpu' })
    expect(result[1]).toEqual({ name: 'disable-gpu-compositing' })
    expect(result).toHaveLength(2)
  })

  // ─── 追加エッジケース ──────────────────────────────────────────────────────

  it('B-08: ENABLE_GPU="1" かつ procVersion に "microsoft" → []（脱出口優先）', () => {
    expect(
      gpuCommandLineSwitches({
        env: { ENABLE_GPU: '1' },
        procVersion: 'Linux version 5.15.90.1-microsoft-standard-WSL2',
      }),
    ).toEqual([])
  })

  it('B-09: 非WSLの通常Linux → []', () => {
    expect(
      gpuCommandLineSwitches({
        env: {},
        procVersion: 'Linux version 5.15.0-73-generic (buildd@lcy02-amd64-032)',
      }),
    ).toEqual([])
  })
})

describe('gpuFallbackPhase', () => {
  it('C-01: GPU_FALLBACK_PHASE 未設定 → 2（デフォルト）', () => {
    expect(gpuFallbackPhase({})).toBe(2)
  })

  it("C-02: GPU_FALLBACK_PHASE = '1' → 1", () => {
    expect(gpuFallbackPhase({ GPU_FALLBACK_PHASE: '1' })).toBe(1)
  })

  it("C-03: GPU_FALLBACK_PHASE = '2' → 2", () => {
    expect(gpuFallbackPhase({ GPU_FALLBACK_PHASE: '2' })).toBe(2)
  })

  it("C-04: GPU_FALLBACK_PHASE = '3' → 3", () => {
    expect(gpuFallbackPhase({ GPU_FALLBACK_PHASE: '3' })).toBe(3)
  })

  it("C-04b: GPU_FALLBACK_PHASE = '4' → 4", () => {
    expect(gpuFallbackPhase({ GPU_FALLBACK_PHASE: '4' })).toBe(4)
  })

  it("C-05: GPU_FALLBACK_PHASE = '0' → 2（デフォルト）", () => {
    expect(gpuFallbackPhase({ GPU_FALLBACK_PHASE: '0' })).toBe(2)
  })

  it("C-06: GPU_FALLBACK_PHASE = 'abc' → 2（デフォルト）", () => {
    expect(gpuFallbackPhase({ GPU_FALLBACK_PHASE: 'abc' })).toBe(2)
  })

  it("C-07: GPU_FALLBACK_PHASE = ''（空文字） → 2（デフォルト）", () => {
    expect(gpuFallbackPhase({ GPU_FALLBACK_PHASE: '' })).toBe(2)
  })
})

describe('gpuCommandLineSwitches（フェーズ別）', () => {
  it('D-01: WSL かつ GPU_FALLBACK_PHASE=2 → phase 2 スイッチ配列を返す', () => {
    expect(
      gpuCommandLineSwitches({
        env: { WSL_DISTRO_NAME: 'Ubuntu', GPU_FALLBACK_PHASE: '2' },
        procVersion: null,
      }),
    ).toEqual([
      { name: 'disable-gpu' },
      { name: 'disable-gpu-compositing' },
      { name: 'in-process-gpu' },
    ])
  })

  it('D-02: WSL かつ GPU_FALLBACK_PHASE 未設定 → phase 2 スイッチ配列を返す（デフォルト）', () => {
    expect(
      gpuCommandLineSwitches({
        env: { WSL_DISTRO_NAME: 'Ubuntu' },
        procVersion: null,
      }),
    ).toEqual([
      { name: 'disable-gpu' },
      { name: 'disable-gpu-compositing' },
      { name: 'in-process-gpu' },
    ])
  })

  it('D-03: WSL かつ GPU_FALLBACK_PHASE=3 → phase 3 スイッチ配列を返す', () => {
    expect(
      gpuCommandLineSwitches({
        env: { WSL_DISTRO_NAME: 'Ubuntu', GPU_FALLBACK_PHASE: '3' },
        procVersion: null,
      }),
    ).toEqual([
      { name: 'in-process-gpu' },
      { name: 'use-gl', value: 'angle' },
      { name: 'use-angle', value: 'swiftshader' },
      { name: 'enable-unsafe-swiftshader' },
    ])
  })

  it('D-03b: WSL かつ GPU_FALLBACK_PHASE=4 → phase 4 スイッチ配列（in-process-gpu のみ）を返す', () => {
    expect(
      gpuCommandLineSwitches({
        env: { WSL_DISTRO_NAME: 'Ubuntu', GPU_FALLBACK_PHASE: '4' },
        procVersion: null,
      }),
    ).toEqual([{ name: 'in-process-gpu' }])
  })

  it('D-04: phase 3 でも ENABLE_GPU=1 なら []（脱出口優先）', () => {
    expect(
      gpuCommandLineSwitches({
        env: { ENABLE_GPU: '1', WSL_DISTRO_NAME: 'Ubuntu', GPU_FALLBACK_PHASE: '3' },
        procVersion: null,
      }),
    ).toEqual([])
  })

  it('D-05: GPU_FALLBACK_PHASE 指定があっても非WSLなら []', () => {
    expect(
      gpuCommandLineSwitches({
        env: { GPU_FALLBACK_PHASE: '3' },
        procVersion: null,
      }),
    ).toEqual([])
  })
})
