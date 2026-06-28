/**
 * T19/T20/T23/T32-UI — settings-controller.test.ts
 *
 * SettingsController: DOM非依存の設定ロジック単体テスト
 *
 * カバー範囲:
 *   - loopトグル: toggleLoop() でloopEnabledを反転し、bridge経由で保存する
 *   - interval選択: selectInterval() で間隔を更新し、bridge経由で保存する
 *   - 不正URLでエラー: validateUrl() が http/https 以外のスキームをエラーとして返す
 *   - 保存往復で反映: IPC roundtrip (updateConfig) の返却値でcontrollerの内部configを更新する
 *   - テスト再生はIDLE以外無効: testPlay() がIDLE以外のschedulerStateでは何もしない
 *   - フォルダ選択: applyFolderPick() / pickFolder() でvideoFolderPathを更新する
 *   - setUrl: 有効URLのみ保存、無効URLはurlErrorをセットして保存しない
 *
 * テスト環境: node (Vitest)
 * IPCブリッジ: SettingsBridge インターフェース経由でモック注入
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  SettingsController,
  type SettingsBridge,
} from '../../src/renderer/settings/settings-controller'
import type { Config } from '../../src/shared/types'

// ── ベースフィクスチャ ──────────────────────────────────────────────────────────

const BASE_CONFIG: Config = {
  siteUrl: 'https://example.com/signage',
  videoFolderPath: '/home/user/videos',
  intervalMinutes: 5,
  loopEnabled: true,
  fadeDurationMs: 1000,
}

// ── モックブリッジファクトリ ──────────────────────────────────────────────────

/**
 * デフォルトでは BASE_CONFIG を返すモック SettingsBridge を作成する。
 * updateConfig はマージ済みコンフィグを返す（サーバー側の保存成功を模倣）。
 */
function makeMockBridge(overrides: Partial<SettingsBridge> = {}): SettingsBridge {
  return {
    getConfig: vi.fn().mockResolvedValue({ ...BASE_CONFIG }),
    updateConfig: vi.fn().mockImplementation(async (patch: Partial<Config>) => ({
      ...BASE_CONFIG,
      ...patch,
    })),
    testPlay: vi.fn(),
    pickFolder: vi.fn().mockResolvedValue({ folderPath: null }),
    ...overrides,
  }
}

// ── テスト本体 ─────────────────────────────────────────────────────────────────

describe('SettingsController', () => {
  let bridge: SettingsBridge
  let controller: SettingsController

  beforeEach(async () => {
    bridge = makeMockBridge()
    controller = new SettingsController(bridge)
    await controller.initialize()
  })

  // ──────────────────────────────────────────────────────────────────────────────
  // initialize
  // ──────────────────────────────────────────────────────────────────────────────
  describe('initialize()', () => {
    it('bridge.getConfig を呼び出して設定を取得する', async () => {
      const b = makeMockBridge()
      const c = new SettingsController(b)
      await c.initialize()
      expect(b.getConfig).toHaveBeenCalledOnce()
    })

    it('取得した設定を内部状態に保持する', async () => {
      expect(controller.config).toEqual(BASE_CONFIG)
    })

    it('初期 schedulerState は IDLE', () => {
      expect(controller.schedulerState).toBe('IDLE')
    })

    it('初期 urlError は null', () => {
      expect(controller.urlError).toBeNull()
    })
  })

  // ──────────────────────────────────────────────────────────────────────────────
  // loopトグル
  // ──────────────────────────────────────────────────────────────────────────────
  describe('toggleLoop()', () => {
    it('loopEnabled=true のとき bridge.updateConfig({ loopEnabled: false }) を呼ぶ', async () => {
      expect(controller.config?.loopEnabled).toBe(true)
      await controller.toggleLoop()
      expect(bridge.updateConfig).toHaveBeenCalledWith({ loopEnabled: false })
    })

    it('loopEnabled=false のとき bridge.updateConfig({ loopEnabled: true }) を呼ぶ', async () => {
      const falseConfig = { ...BASE_CONFIG, loopEnabled: false }
      const b = makeMockBridge({
        getConfig: vi.fn().mockResolvedValue(falseConfig),
        updateConfig: vi.fn().mockResolvedValue({ ...falseConfig, loopEnabled: true }),
      })
      const c = new SettingsController(b)
      await c.initialize()

      expect(c.config?.loopEnabled).toBe(false)
      await c.toggleLoop()
      expect(b.updateConfig).toHaveBeenCalledWith({ loopEnabled: true })
    })

    it('IPC roundtrip の返却値で内部 config が更新される', async () => {
      const updated = { ...BASE_CONFIG, loopEnabled: false }
      vi.mocked(bridge.updateConfig).mockResolvedValueOnce(updated)

      await controller.toggleLoop()

      expect(controller.config?.loopEnabled).toBe(false)
    })

    it('bridge.updateConfig が null を返した場合は内部 config を変更しない', async () => {
      vi.mocked(bridge.updateConfig).mockResolvedValueOnce(null)
      const before = controller.config

      await controller.toggleLoop()

      expect(controller.config).toEqual(before)
    })
  })

  // ──────────────────────────────────────────────────────────────────────────────
  // interval選択
  // ──────────────────────────────────────────────────────────────────────────────
  describe('selectInterval()', () => {
    it('選択した interval で bridge.updateConfig を呼ぶ', async () => {
      await controller.selectInterval(10)
      expect(bridge.updateConfig).toHaveBeenCalledWith({ intervalMinutes: 10 })
    })

    it('IPC roundtrip の返却値で内部 config が更新される', async () => {
      const updated = { ...BASE_CONFIG, intervalMinutes: 15 as const }
      vi.mocked(bridge.updateConfig).mockResolvedValueOnce(updated)

      await controller.selectInterval(15)

      expect(controller.config?.intervalMinutes).toBe(15)
    })

    it('30分を選択した場合も正しく保存される', async () => {
      await controller.selectInterval(30)
      expect(bridge.updateConfig).toHaveBeenCalledWith({ intervalMinutes: 30 })
    })

    it('bridge.updateConfig が null を返した場合は内部 config を変更しない', async () => {
      vi.mocked(bridge.updateConfig).mockResolvedValueOnce(null)
      const before = controller.config

      await controller.selectInterval(30)

      expect(controller.config).toEqual(before)
    })
  })

  // ──────────────────────────────────────────────────────────────────────────────
  // URL検証 (validateUrl / setUrl)
  // ──────────────────────────────────────────────────────────────────────────────
  describe('validateUrl()', () => {
    it('http:// URL は有効', () => {
      const result = controller.validateUrl('http://example.com')
      expect(result.valid).toBe(true)
    })

    it('https:// URL は有効', () => {
      const result = controller.validateUrl('https://secure.example.com/signage')
      expect(result.valid).toBe(true)
    })

    it('ftp:// URL は無効', () => {
      const result = controller.validateUrl('ftp://ftp.example.com')
      expect(result.valid).toBe(false)
    })

    it('javascript:// URL は無効', () => {
      const result = controller.validateUrl('javascript://evil')
      expect(result.valid).toBe(false)
    })

    it('file:// URL は無効', () => {
      const result = controller.validateUrl('file:///etc/passwd')
      expect(result.valid).toBe(false)
    })

    it('書式不正 URL は無効', () => {
      const result = controller.validateUrl('not-a-url')
      expect(result.valid).toBe(false)
    })

    it('無効な URL を検証すると urlError がセットされる', () => {
      controller.validateUrl('ftp://example.com')
      expect(controller.urlError).not.toBeNull()
    })

    it('有効な URL を検証すると urlError がクリアされる', () => {
      controller.validateUrl('ftp://example.com') // エラーをセット
      controller.validateUrl('https://example.com') // エラーをクリア
      expect(controller.urlError).toBeNull()
    })

    it('無効時に返す result.message が非空文字列', () => {
      const result = controller.validateUrl('javascript://evil')
      expect(result.valid).toBe(false)
      if (!result.valid) {
        expect(result.message.length).toBeGreaterThan(0)
      }
    })
  })

  describe('setUrl()', () => {
    it('有効な URL のとき bridge.updateConfig({ siteUrl }) を呼ぶ', async () => {
      await controller.setUrl('https://new-site.example.com')
      expect(bridge.updateConfig).toHaveBeenCalledWith({ siteUrl: 'https://new-site.example.com' })
    })

    it('無効な URL のとき bridge.updateConfig を呼ばない', async () => {
      await controller.setUrl('ftp://invalid.example.com')
      expect(bridge.updateConfig).not.toHaveBeenCalled()
    })

    it('無効な URL のとき null を返す', async () => {
      const result = await controller.setUrl('javascript://evil')
      expect(result).toBeNull()
    })

    it('有効な URL のとき IPC roundtrip 後に内部 config が更新される', async () => {
      const updated = { ...BASE_CONFIG, siteUrl: 'https://new-site.example.com' }
      vi.mocked(bridge.updateConfig).mockResolvedValueOnce(updated)

      await controller.setUrl('https://new-site.example.com')

      expect(controller.config?.siteUrl).toBe('https://new-site.example.com')
    })
  })

  // ──────────────────────────────────────────────────────────────────────────────
  // 保存往復で反映 (save roundtrip)
  // ──────────────────────────────────────────────────────────────────────────────
  describe('保存往復で反映', () => {
    it('toggleLoop: IPC 返却値 (loopEnabled=false) が内部 config に反映される', async () => {
      const updatedConfig = { ...BASE_CONFIG, loopEnabled: false }
      vi.mocked(bridge.updateConfig).mockResolvedValueOnce(updatedConfig)

      await controller.toggleLoop()

      expect(controller.config).toEqual(updatedConfig)
    })

    it('selectInterval: IPC 返却値 (intervalMinutes=30) が内部 config に反映される', async () => {
      const updatedConfig = { ...BASE_CONFIG, intervalMinutes: 30 as const }
      vi.mocked(bridge.updateConfig).mockResolvedValueOnce(updatedConfig)

      await controller.selectInterval(30)

      expect(controller.config?.intervalMinutes).toBe(30)
    })

    it('applyFolderPick: IPC 返却値 (videoFolderPath) が内部 config に反映される', async () => {
      const updatedConfig = { ...BASE_CONFIG, videoFolderPath: '/new/videos' }
      vi.mocked(bridge.updateConfig).mockResolvedValueOnce(updatedConfig)

      await controller.applyFolderPick('/new/videos')

      expect(controller.config?.videoFolderPath).toBe('/new/videos')
    })

    it('null が返った場合は以前の config のまま変化しない', async () => {
      vi.mocked(bridge.updateConfig).mockResolvedValueOnce(null)
      const original = controller.config

      await controller.toggleLoop()

      expect(controller.config).toEqual(original)
    })
  })

  // ──────────────────────────────────────────────────────────────────────────────
  // テスト再生 (testPlay)
  // ──────────────────────────────────────────────────────────────────────────────
  describe('testPlay()', () => {
    it('schedulerState が IDLE のとき bridge.testPlay() を呼び true を返す', () => {
      controller.setSchedulerState('IDLE')
      const result = controller.testPlay()
      expect(result).toBe(true)
      expect(bridge.testPlay).toHaveBeenCalledOnce()
    })

    it('schedulerState が PLAYING のとき bridge.testPlay() を呼ばず false を返す', () => {
      controller.setSchedulerState('PLAYING')
      const result = controller.testPlay()
      expect(result).toBe(false)
      expect(bridge.testPlay).not.toHaveBeenCalled()
    })

    it('schedulerState が FADE_IN のとき bridge.testPlay() を呼ばず false を返す', () => {
      controller.setSchedulerState('FADE_IN')
      const result = controller.testPlay()
      expect(result).toBe(false)
      expect(bridge.testPlay).not.toHaveBeenCalled()
    })

    it('schedulerState が FADE_OUT のとき bridge.testPlay() を呼ばず false を返す', () => {
      controller.setSchedulerState('FADE_OUT')
      const result = controller.testPlay()
      expect(result).toBe(false)
      expect(bridge.testPlay).not.toHaveBeenCalled()
    })

    it('IDLE → PLAYING に変えると testPlay() が無効になる', () => {
      controller.setSchedulerState('IDLE')
      expect(controller.testPlay()).toBe(true)

      // リセットして再テスト
      vi.mocked(bridge.testPlay).mockClear()
      controller.setSchedulerState('PLAYING')
      expect(controller.testPlay()).toBe(false)
      expect(bridge.testPlay).not.toHaveBeenCalled()
    })
  })

  // ──────────────────────────────────────────────────────────────────────────────
  // フォルダ選択 (applyFolderPick / pickFolder)
  // ──────────────────────────────────────────────────────────────────────────────
  describe('applyFolderPick()', () => {
    it('非 null パスで bridge.updateConfig({ videoFolderPath }) を呼ぶ', async () => {
      await controller.applyFolderPick('/new/videos')
      expect(bridge.updateConfig).toHaveBeenCalledWith({ videoFolderPath: '/new/videos' })
    })

    it('null のとき bridge.updateConfig を呼ばない', async () => {
      await controller.applyFolderPick(null)
      expect(bridge.updateConfig).not.toHaveBeenCalled()
    })

    it('null のとき null を返す', async () => {
      const result = await controller.applyFolderPick(null)
      expect(result).toBeNull()
    })
  })

  describe('pickFolder()', () => {
    it('bridge.pickFolder を呼び出す', async () => {
      await controller.pickFolder()
      expect(bridge.pickFolder).toHaveBeenCalledOnce()
    })

    it('ピッカーが folderPath を返したとき updateConfig を呼ぶ', async () => {
      vi.mocked(bridge.pickFolder).mockResolvedValueOnce({ folderPath: '/picked/videos' })
      const updated = { ...BASE_CONFIG, videoFolderPath: '/picked/videos' }
      vi.mocked(bridge.updateConfig).mockResolvedValueOnce(updated)

      await controller.pickFolder()

      expect(bridge.updateConfig).toHaveBeenCalledWith({ videoFolderPath: '/picked/videos' })
    })

    it('ピッカーが null を返したとき updateConfig を呼ばない', async () => {
      vi.mocked(bridge.pickFolder).mockResolvedValueOnce({ folderPath: null })

      await controller.pickFolder()

      expect(bridge.updateConfig).not.toHaveBeenCalled()
    })
  })

  // ──────────────────────────────────────────────────────────────────────────────
  // setSchedulerState
  // ──────────────────────────────────────────────────────────────────────────────
  describe('setSchedulerState()', () => {
    it('schedulerState を更新できる', () => {
      controller.setSchedulerState('PLAYING')
      expect(controller.schedulerState).toBe('PLAYING')
    })

    it('IDLE に戻せる', () => {
      controller.setSchedulerState('FADE_OUT')
      controller.setSchedulerState('IDLE')
      expect(controller.schedulerState).toBe('IDLE')
    })
  })

  // ──────────────────────────────────────────────────────────────────────────────
  // §7.1.6: validateUrl 空文字許容（CRITICAL: §5.6）
  // ──────────────────────────────────────────────────────────────────────────────
  describe('validateUrl() — 空文字許容（§5.6）', () => {
    it('空文字は有効（未設定 = スタート画面）→ {valid: true}', () => {
      const result = controller.validateUrl('')
      expect(result.valid).toBe(true)
    })

    it('空白のみの文字列は有効（trim 後が空文字）→ {valid: true}', () => {
      const result = controller.validateUrl('   ')
      expect(result.valid).toBe(true)
    })

    it('空文字を検証すると urlError がクリアされる', () => {
      controller.validateUrl('ftp://bad') // エラーをセット
      controller.validateUrl('')          // 空文字でクリア
      expect(controller.urlError).toBeNull()
    })
  })

  // ──────────────────────────────────────────────────────────────────────────────
  // §7.1.6: setUrl 空文字許容
  // ──────────────────────────────────────────────────────────────────────────────
  describe('setUrl() — 空文字許容（§5.6）', () => {
    it('setUrl(\'\') が bridge.updateConfig({ siteUrl: \'\' }) を呼ぶ', async () => {
      await controller.setUrl('')
      expect(bridge.updateConfig).toHaveBeenCalledWith({ siteUrl: '' })
    })

    it('setUrl(\'\') 後に内部 config の siteUrl が空文字になる', async () => {
      const updated = { ...BASE_CONFIG, siteUrl: '' }
      vi.mocked(bridge.updateConfig).mockResolvedValueOnce(updated)
      await controller.setUrl('')
      expect(controller.config?.siteUrl).toBe('')
    })
  })

  // ──────────────────────────────────────────────────────────────────────────────
  // §7.1.6: applyExternalConfig — 外部書き手による config 同期（CRITICAL §2.7）
  // ──────────────────────────────────────────────────────────────────────────────
  describe('applyExternalConfig() — 外部 config を内部状態に反映（§5.6）', () => {
    it('applyExternalConfig(config) で _config が更新される', () => {
      const newConfig = { ...BASE_CONFIG, loopEnabled: false, siteUrl: 'https://new.example.com' }
      controller.applyExternalConfig(newConfig)
      expect(controller.config).toEqual(newConfig)
    })

    it('applyExternalConfig 後に toggleLoop が最新値の反転を送信する', async () => {
      // 初期: loopEnabled = true (ON)
      // 外部から loopEnabled=false (OFF) の更新が来た想定
      controller.applyExternalConfig({ ...BASE_CONFIG, loopEnabled: false })
      // _config.loopEnabled = false になっているはず
      await controller.toggleLoop()
      // !false = true を送信するはず（正しく反転）
      expect(bridge.updateConfig).toHaveBeenCalledWith({ loopEnabled: true })
    })

    // §7.1.6 stale 検出 Red テスト:
    // applyExternalConfig 実装後に Green になること（実装前は TypeError で FAIL = Red）
    it('[stale検出] applyExternalConfig 後の toggleLoop が stale 値ではなく最新値で反転する', async () => {
      // 初期: loopEnabled = true (ON)
      expect(controller.config?.loopEnabled).toBe(true)

      // 外部（アドレスバー）が loopEnabled を ON→OFF に変更
      controller.applyExternalConfig({ ...BASE_CONFIG, loopEnabled: false })
      // _config が最新化（false）されていること
      expect(controller.config?.loopEnabled).toBe(false)

      // パネルのトグルを押す → !false = true を送信（stale だと !true = false になってしまう）
      await controller.toggleLoop()
      expect(bridge.updateConfig).toHaveBeenCalledWith({ loopEnabled: true })
    })
  })
})
