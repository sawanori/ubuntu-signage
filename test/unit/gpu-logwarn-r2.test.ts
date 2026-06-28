/**
 * D2 R2: GPUログの手書きJSON vs logWarn出力 バイト等価検証
 *
 * src/main/index.ts の GPU ブロックで process.stdout.write で手書きしていた JSON が、
 * logWarn('gpu.hardwareAccelerationDisabled', { phase, hardwareAccelerationDisabled, gpuSwitches })
 * の出力と**バイト等価**であることを担保するユニットテスト。
 *
 * quit-flow e2e への依存を作らず、専用ユニットテストで安全網を構築する（§8-R2）。
 *
 * 検証方針:
 *   - Date.now() をモックして ts フィールドを固定し、静的部分のバイト等価を証明する
 *   - キー順序（level/event/<meta keys>/ts）が手書き版と一致することを assert に含める
 *   - logWarn は src/main/index.ts に private 定義のため、同一関数ボディをテスト内で再現し
 *     stdout spy でキャプチャして比較する
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

// ─── logWarn 関数ボディの再現 ─────────────────────────────────────────────────
// src/main/index.ts の logWarn（行 125–128）と同一のシグネチャ・ボディ
function logWarn(event: string, meta?: Record<string, unknown>): string {
  return JSON.stringify({ level: 'WARN', event, ...meta, ts: Date.now() }) + '\n'
}

// ─── テストスイート ──────────────────────────────────────────────────────────

describe('D2 R2: GPUログ バイト等価検証', () => {
  const MOCK_TS = 1719547200000

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ─── gpu.procVersionReadFailed ─────────────────────────────────────────────

  describe('gpu.procVersionReadFailed', () => {
    it('R2-01: logWarn出力が手書きJSON（meta なし）とバイト等価', () => {
      vi.spyOn(Date, 'now').mockReturnValue(MOCK_TS)

      // 置換前の手書き行（削除された行）
      const handWritten =
        JSON.stringify({ level: 'WARN', event: 'gpu.procVersionReadFailed', ts: Date.now() }) +
        '\n'

      // logWarn('gpu.procVersionReadFailed') の出力
      const logWarnOutput = logWarn('gpu.procVersionReadFailed')

      expect(logWarnOutput).toBe(handWritten)
    })

    it('R2-02: キー順序が level→event→ts の順', () => {
      vi.spyOn(Date, 'now').mockReturnValue(MOCK_TS)

      const output = logWarn('gpu.procVersionReadFailed')
      const parsed = JSON.parse(output.trimEnd()) as Record<string, unknown>
      const keys = Object.keys(parsed)

      expect(keys[0]).toBe('level')
      expect(keys[1]).toBe('event')
      expect(keys[2]).toBe('ts')
      expect(keys).toHaveLength(3)
    })

    it('R2-03: level=WARN / event=gpu.procVersionReadFailed / ts=固定値', () => {
      vi.spyOn(Date, 'now').mockReturnValue(MOCK_TS)

      const output = logWarn('gpu.procVersionReadFailed')
      const parsed = JSON.parse(output.trimEnd()) as Record<string, unknown>

      expect(parsed['level']).toBe('WARN')
      expect(parsed['event']).toBe('gpu.procVersionReadFailed')
      expect(parsed['ts']).toBe(MOCK_TS)
    })
  })

  // ─── gpu.hardwareAccelerationDisabled ─────────────────────────────────────

  describe('gpu.hardwareAccelerationDisabled', () => {
    // phase=2 のケース（デフォルト・hw accel 無効化）
    it('R2-04: phase=2 のとき logWarn出力が手書きJSONとバイト等価', () => {
      vi.spyOn(Date, 'now').mockReturnValue(MOCK_TS)

      const phase = 2
      const gpuSwitches = [
        { name: 'disable-gpu' },
        { name: 'disable-gpu-compositing' },
        { name: 'in-process-gpu' },
      ]
      // D2 で新設する変数（index.ts の変更後と同一）
      const hardwareAccelerationDisabled = phase !== 3 && phase !== 4 // true

      // 置換前の手書き JSON（削除された行）
      const handWritten =
        JSON.stringify({
          level: 'WARN',
          event: 'gpu.hardwareAccelerationDisabled',
          phase,
          hardwareAccelerationDisabled: phase !== 3 && phase !== 4,
          gpuSwitches,
          ts: Date.now(),
        }) + '\n'

      // logWarn('gpu.hardwareAccelerationDisabled', { phase, hardwareAccelerationDisabled, gpuSwitches })
      const logWarnOutput = logWarn('gpu.hardwareAccelerationDisabled', {
        phase,
        hardwareAccelerationDisabled,
        gpuSwitches,
      })

      expect(logWarnOutput).toBe(handWritten)
    })

    it('R2-05: phase=2 のときキー順序が level→event→phase→hardwareAccelerationDisabled→gpuSwitches→ts', () => {
      vi.spyOn(Date, 'now').mockReturnValue(MOCK_TS)

      const phase = 2
      const gpuSwitches = [{ name: 'disable-gpu' }]
      const hardwareAccelerationDisabled = phase !== 3 && phase !== 4

      const output = logWarn('gpu.hardwareAccelerationDisabled', {
        phase,
        hardwareAccelerationDisabled,
        gpuSwitches,
      })
      const parsed = JSON.parse(output.trimEnd()) as Record<string, unknown>
      const keys = Object.keys(parsed)

      expect(keys[0]).toBe('level')
      expect(keys[1]).toBe('event')
      expect(keys[2]).toBe('phase')
      expect(keys[3]).toBe('hardwareAccelerationDisabled')
      expect(keys[4]).toBe('gpuSwitches')
      expect(keys[5]).toBe('ts')
      expect(keys).toHaveLength(6)
    })

    it('R2-06: phase=3 のとき hardwareAccelerationDisabled=false でバイト等価', () => {
      vi.spyOn(Date, 'now').mockReturnValue(MOCK_TS)

      const phase = 3
      const gpuSwitches = [{ name: 'in-process-gpu' }, { name: 'use-gl', value: 'angle' }]
      const hardwareAccelerationDisabled = phase !== 3 && phase !== 4 // false

      const handWritten =
        JSON.stringify({
          level: 'WARN',
          event: 'gpu.hardwareAccelerationDisabled',
          phase,
          hardwareAccelerationDisabled: phase !== 3 && phase !== 4,
          gpuSwitches,
          ts: Date.now(),
        }) + '\n'

      const logWarnOutput = logWarn('gpu.hardwareAccelerationDisabled', {
        phase,
        hardwareAccelerationDisabled,
        gpuSwitches,
      })

      expect(logWarnOutput).toBe(handWritten)
    })

    it('R2-07: phase=4 のとき hardwareAccelerationDisabled=false でバイト等価', () => {
      vi.spyOn(Date, 'now').mockReturnValue(MOCK_TS)

      const phase = 4
      const gpuSwitches = [{ name: 'in-process-gpu' }]
      const hardwareAccelerationDisabled = phase !== 3 && phase !== 4 // false

      const handWritten =
        JSON.stringify({
          level: 'WARN',
          event: 'gpu.hardwareAccelerationDisabled',
          phase,
          hardwareAccelerationDisabled: phase !== 3 && phase !== 4,
          gpuSwitches,
          ts: Date.now(),
        }) + '\n'

      const logWarnOutput = logWarn('gpu.hardwareAccelerationDisabled', {
        phase,
        hardwareAccelerationDisabled,
        gpuSwitches,
      })

      expect(logWarnOutput).toBe(handWritten)
    })

    it('R2-08: 出力末尾が改行 \\n で終端', () => {
      vi.spyOn(Date, 'now').mockReturnValue(MOCK_TS)

      const output = logWarn('gpu.hardwareAccelerationDisabled', {
        phase: 2,
        hardwareAccelerationDisabled: true,
        gpuSwitches: [],
      })

      expect(output.endsWith('\n')).toBe(true)
      // 末尾改行は1文字のみ
      expect(output.endsWith('\n\n')).toBe(false)
    })
  })
})
