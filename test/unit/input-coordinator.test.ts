/**
 * T21/T22 — 入力ロジック ユニットテスト
 *
 * InputCoordinator:
 *   隅 3 タップカウンタ:
 *     UH-01: 1.5 秒以内に 3 回タップ → 設定パネルを開く
 *     UH-02: 時間窓外（1.5 秒超）の 3 回 → 発火しない・カウントリセット
 *   Ctrl+G globalShortcut ラッパ:
 *     T21: トグル動作・多重起動防止（UT-12）・Wayland スキップ・登録/解除
 *
 * タイマーは vitest fake timers を使用（Date.now() もモック対象）。
 * Electron globalShortcut はモックオブジェクトで注入。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InputCoordinator } from '../../src/main/input-coordinator'
import type {
  InputCoordinatorOptions,
  GlobalShortcutAdapter,
  InputCoordinatorLogger,
} from '../../src/main/input-coordinator'

describe('InputCoordinator', () => {
  let mockOpenSettings: ReturnType<typeof vi.fn>
  let mockCloseSettings: ReturnType<typeof vi.fn>
  let mockIsSettingsOpen: ReturnType<typeof vi.fn>
  let mockShortcutRegister: ReturnType<typeof vi.fn>
  let mockShortcutUnregister: ReturnType<typeof vi.fn>
  let mockWarn: ReturnType<typeof vi.fn>
  let mockDebug: ReturnType<typeof vi.fn>
  let mockToggleAddressBar: ReturnType<typeof vi.fn>
  let globalShortcut: GlobalShortcutAdapter
  let logger: InputCoordinatorLogger

  /** テスト用 InputCoordinator を生成する */
  function createCoordinator(
    overrides: Partial<InputCoordinatorOptions> = {},
  ): InputCoordinator {
    return new InputCoordinator({
      onOpenSettings: mockOpenSettings as () => void,
      onCloseSettings: mockCloseSettings as () => void,
      isSettingsOpen: mockIsSettingsOpen as () => boolean,
      globalShortcut,
      logger,
      ...overrides,
    })
  }

  /**
   * registerShortcut() で登録された Ctrl+G コールバックを取得するヘルパー。
   * 未登録の場合は例外をスローする。
   */
  function getRegisteredCallback(): () => void {
    const calls = mockShortcutRegister.mock.calls
    const firstCall = calls[0]
    if (!firstCall || firstCall.length < 2) {
      throw new Error('Ctrl+G shortcut has not been registered yet')
    }
    const cb = firstCall[1]
    if (typeof cb !== 'function') {
      throw new Error('registered callback is not a function')
    }
    return cb as () => void
  }

  beforeEach(() => {
    vi.useFakeTimers()
    mockOpenSettings = vi.fn()
    mockCloseSettings = vi.fn()
    mockIsSettingsOpen = vi.fn().mockReturnValue(false)
    mockShortcutRegister = vi.fn().mockReturnValue(true)
    mockShortcutUnregister = vi.fn()
    mockWarn = vi.fn()
    mockDebug = vi.fn()
    mockToggleAddressBar = vi.fn()
    globalShortcut = {
      register: mockShortcutRegister as GlobalShortcutAdapter['register'],
      unregister: mockShortcutUnregister as GlobalShortcutAdapter['unregister'],
    }
    logger = {
      warn: mockWarn as InputCoordinatorLogger['warn'],
      debug: mockDebug as InputCoordinatorLogger['debug'],
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ---------------------------------------------------------------------------
  // 隅 3 タップカウンタ (T22)
  // ---------------------------------------------------------------------------
  describe('Corner 3-tap counter', () => {
    it('UH-01: fires open event when 3 taps occur within 1.5 seconds', () => {
      const coordinator = createCoordinator()

      coordinator.recordTap()
      vi.advanceTimersByTime(500)
      coordinator.recordTap()
      vi.advanceTimersByTime(500)
      coordinator.recordTap() // total elapsed: 1000ms — all 3 taps within 1500ms window

      expect(mockOpenSettings).toHaveBeenCalledOnce()
    })

    it('UH-02: does not fire and resets counter when taps spread beyond 1.5-second window', () => {
      const coordinator = createCoordinator()

      coordinator.recordTap() // t=0
      vi.advanceTimersByTime(1600) // advance to t=1600; first tap is now 1600ms ago (outside 1500ms)
      coordinator.recordTap() // t=1600 (first tap expired, window has only this one)
      vi.advanceTimersByTime(400)
      coordinator.recordTap() // t=2000; window has [1600, 2000] → only 2 taps, need 3

      expect(mockOpenSettings).not.toHaveBeenCalled()
    })

    it('fires at exactly the boundary: 1499ms between first and last tap', () => {
      const coordinator = createCoordinator()

      coordinator.recordTap() // t=0
      vi.advanceTimersByTime(700)
      coordinator.recordTap() // t=700
      vi.advanceTimersByTime(799)
      coordinator.recordTap() // t=1499; first tap is 1499ms ago (< 1500ms window)

      expect(mockOpenSettings).toHaveBeenCalledOnce()
    })

    it('does NOT fire when exactly 1500ms separate first and last tap', () => {
      const coordinator = createCoordinator()

      coordinator.recordTap() // t=0
      vi.advanceTimersByTime(750)
      coordinator.recordTap() // t=750
      vi.advanceTimersByTime(750)
      coordinator.recordTap() // t=1500; first tap is 1500ms ago (>= 1500ms, excluded)

      // Window now has [750, 1500] → only 2 taps
      expect(mockOpenSettings).not.toHaveBeenCalled()
    })

    it('resets tap counter after successful triple-tap fires', () => {
      const coordinator = createCoordinator()

      // Triple-tap fires → opens settings
      coordinator.recordTap()
      coordinator.recordTap()
      coordinator.recordTap()
      expect(mockOpenSettings).toHaveBeenCalledTimes(1)

      // Settings now open
      mockIsSettingsOpen.mockReturnValue(true)

      // Only 2 more taps — should NOT fire close (counter was reset)
      coordinator.recordTap()
      coordinator.recordTap()
      expect(mockCloseSettings).not.toHaveBeenCalled()
    })

    it('toggles to close when settings is already open on triple-tap', () => {
      mockIsSettingsOpen.mockReturnValue(true)
      const coordinator = createCoordinator()

      coordinator.recordTap()
      coordinator.recordTap()
      coordinator.recordTap()

      expect(mockOpenSettings).not.toHaveBeenCalled()
      expect(mockCloseSettings).toHaveBeenCalledOnce()
    })

    it('uses sliding window: expired tap is dropped and new taps can accumulate to 3', () => {
      const coordinator = createCoordinator()

      coordinator.recordTap() // t=0
      vi.advanceTimersByTime(800)
      coordinator.recordTap() // t=800
      vi.advanceTimersByTime(800) // t=1600; first tap (t=0) is 1600ms ago → expired
      coordinator.recordTap() // t=1600; window=[800, 1600] → 2 taps
      vi.advanceTimersByTime(400)
      coordinator.recordTap() // t=2000; window=[800, 1600, 2000] → 3 taps → fires!

      expect(mockOpenSettings).toHaveBeenCalledOnce()
    })

    it('does not fire on fewer than 3 taps', () => {
      const coordinator = createCoordinator()

      coordinator.recordTap()
      coordinator.recordTap()

      expect(mockOpenSettings).not.toHaveBeenCalled()
    })

    it('fires on the 3rd tap of rapid consecutive taps', () => {
      const coordinator = createCoordinator()

      coordinator.recordTap()
      coordinator.recordTap()
      coordinator.recordTap()

      expect(mockOpenSettings).toHaveBeenCalledOnce()
    })
  })

  // ---------------------------------------------------------------------------
  // Ctrl+G globalShortcut ラッパ (T21)
  // ---------------------------------------------------------------------------
  describe('Ctrl+G globalShortcut wrapper', () => {
    it('registers Control+G shortcut when registerShortcut() is called', () => {
      const coordinator = createCoordinator()
      coordinator.registerShortcut()

      expect(mockShortcutRegister).toHaveBeenCalledWith('Control+G', expect.any(Function))
    })

    it('opens settings when Ctrl+G is pressed and settings is closed', () => {
      mockIsSettingsOpen.mockReturnValue(false)
      const coordinator = createCoordinator()
      coordinator.registerShortcut()
      getRegisteredCallback()()

      expect(mockOpenSettings).toHaveBeenCalledOnce()
      expect(mockCloseSettings).not.toHaveBeenCalled()
    })

    it('closes settings when Ctrl+G is pressed and settings is open (toggle behavior)', () => {
      mockIsSettingsOpen.mockReturnValue(true)
      const coordinator = createCoordinator()
      coordinator.registerShortcut()
      getRegisteredCallback()()

      expect(mockCloseSettings).toHaveBeenCalledOnce()
      expect(mockOpenSettings).not.toHaveBeenCalled()
    })

    it('UT-12: does not re-open panel when Ctrl+G pressed while already open (multi-launch prevention)', () => {
      const coordinator = createCoordinator()
      coordinator.registerShortcut()
      const callback = getRegisteredCallback()

      // Press 1: settings closed → opens
      mockIsSettingsOpen.mockReturnValue(false)
      callback()
      expect(mockOpenSettings).toHaveBeenCalledTimes(1)

      // Press 2: settings open → closes (does NOT re-open)
      mockIsSettingsOpen.mockReturnValue(true)
      callback()
      expect(mockOpenSettings).toHaveBeenCalledTimes(1) // still only 1 open call
      expect(mockCloseSettings).toHaveBeenCalledTimes(1)

      // Press 3: settings closed again → opens
      mockIsSettingsOpen.mockReturnValue(false)
      callback()
      expect(mockOpenSettings).toHaveBeenCalledTimes(2)
    })

    it('prevents double registration when registerShortcut() is called twice', () => {
      const coordinator = createCoordinator()
      coordinator.registerShortcut()
      coordinator.registerShortcut() // second call must be no-op

      expect(mockShortcutRegister).toHaveBeenCalledOnce()
    })

    it('unregisters Ctrl+G shortcut via unregisterShortcut()', () => {
      const coordinator = createCoordinator()
      coordinator.registerShortcut()
      coordinator.unregisterShortcut()

      expect(mockShortcutUnregister).toHaveBeenCalledWith('Control+G')
    })

    it('allows re-registration after unregisterShortcut()', () => {
      const coordinator = createCoordinator()
      coordinator.registerShortcut()
      coordinator.unregisterShortcut()
      coordinator.registerShortcut()

      expect(mockShortcutRegister).toHaveBeenCalledTimes(2)
    })

    it('does not call unregister if shortcut was never registered', () => {
      const coordinator = createCoordinator()
      coordinator.unregisterShortcut() // no-op — nothing registered

      expect(mockShortcutUnregister).not.toHaveBeenCalled()
    })

    it('skips registration on Wayland and emits warn log with reason', () => {
      const coordinator = createCoordinator({ isWayland: true })
      coordinator.registerShortcut()

      expect(mockShortcutRegister).not.toHaveBeenCalled()
      expect(mockWarn).toHaveBeenCalledWith(
        'input.shortcutSkipped',
        expect.objectContaining({ reason: 'wayland' }),
      )
    })

    it('emits warn log when shortcut registration fails', () => {
      mockShortcutRegister.mockReturnValue(false)
      const coordinator = createCoordinator()
      coordinator.registerShortcut()

      expect(mockWarn).toHaveBeenCalledWith(
        'input.shortcutRegisterFailed',
        expect.objectContaining({ accelerator: 'Control+G' }),
      )
    })

    it('does not register shortcut when Wayland flag is true, even after multiple calls', () => {
      const coordinator = createCoordinator({ isWayland: true })
      coordinator.registerShortcut()
      coordinator.registerShortcut()

      expect(mockShortcutRegister).not.toHaveBeenCalled()
      // Warn logged each time (not de-duplicated — each is a separate attempt)
      expect(mockWarn).toHaveBeenCalledTimes(2)
    })
  })

  // ---------------------------------------------------------------------------
  // §7.1.4 Ctrl+L address bar shortcut (Phase B)
  // ---------------------------------------------------------------------------
  describe('Ctrl+L address bar shortcut (registerAddressBarShortcut / unregisterAddressBarShortcut / toggleAddressBarZone)', () => {
    /**
     * mockShortcutRegister.mock.calls から 'Control+L' に対応するコールバックを取得する。
     */
    function getAddressBarRegisteredCallback(): () => void {
      const ctrlLCall = mockShortcutRegister.mock.calls.find(
        (call: unknown[]) => call[0] === 'Control+L',
      )
      if (!ctrlLCall || ctrlLCall.length < 2) {
        throw new Error('Control+L shortcut has not been registered yet')
      }
      const cb = ctrlLCall[1]
      if (typeof cb !== 'function') {
        throw new Error('registered callback is not a function')
      }
      return cb as () => void
    }

    it('registers Control+L shortcut on X11', () => {
      const coordinator = createCoordinator({
        onToggleAddressBar: mockToggleAddressBar as () => void,
      })
      coordinator.registerAddressBarShortcut()

      expect(mockShortcutRegister).toHaveBeenCalledWith('Control+L', expect.any(Function))
    })

    it('skips Control+L registration on Wayland and emits warn log with accelerator', () => {
      const coordinator = createCoordinator({
        isWayland: true,
        onToggleAddressBar: mockToggleAddressBar as () => void,
      })
      coordinator.registerAddressBarShortcut()

      expect(mockShortcutRegister).not.toHaveBeenCalled()
      expect(mockWarn).toHaveBeenCalledWith(
        'input.shortcutSkipped',
        expect.objectContaining({ reason: 'wayland', accelerator: 'Control+L' }),
      )
    })

    it('prevents double registration: Control+L registered only once even when called twice', () => {
      const coordinator = createCoordinator({
        onToggleAddressBar: mockToggleAddressBar as () => void,
      })
      coordinator.registerAddressBarShortcut()
      coordinator.registerAddressBarShortcut()

      const ctrlLCalls = mockShortcutRegister.mock.calls.filter(
        (call: unknown[]) => call[0] === 'Control+L',
      )
      expect(ctrlLCalls).toHaveLength(1)
    })

    it('unregisterAddressBarShortcut() unregisters Control+L after registration', () => {
      const coordinator = createCoordinator({
        onToggleAddressBar: mockToggleAddressBar as () => void,
      })
      coordinator.registerAddressBarShortcut()
      coordinator.unregisterAddressBarShortcut()

      expect(mockShortcutUnregister).toHaveBeenCalledWith('Control+L')
    })

    it('unregisterAddressBarShortcut() is no-op when Control+L was never registered', () => {
      const coordinator = createCoordinator({
        onToggleAddressBar: mockToggleAddressBar as () => void,
      })
      coordinator.unregisterAddressBarShortcut()

      expect(mockShortcutUnregister).not.toHaveBeenCalled()
    })

    it('toggleAddressBarZone() calls onToggleAddressBar()', () => {
      const coordinator = createCoordinator({
        onToggleAddressBar: mockToggleAddressBar as () => void,
      })
      coordinator.toggleAddressBarZone()

      expect(mockToggleAddressBar).toHaveBeenCalledOnce()
    })

    it('toggleAddressBarZone() is no-op (no TypeError) when onToggleAddressBar is not defined', () => {
      const coordinator = createCoordinator() // no onToggleAddressBar
      expect(() => coordinator.toggleAddressBarZone()).not.toThrow()
    })

    it('Ctrl+L callback fires and calls onToggleAddressBar()', () => {
      const coordinator = createCoordinator({
        onToggleAddressBar: mockToggleAddressBar as () => void,
      })
      coordinator.registerAddressBarShortcut()
      const callback = getAddressBarRegisteredCallback()
      callback()

      expect(mockToggleAddressBar).toHaveBeenCalledOnce()
    })
  })

  // ---------------------------------------------------------------------------
  // 右クリック（コンテキストメニュー）経由の設定パネル開閉
  // ---------------------------------------------------------------------------
  describe('openSettingsByContextMenu()', () => {
    it('設定が閉じている場合 → onOpenSettings が1回呼ばれる', () => {
      mockIsSettingsOpen.mockReturnValue(false)
      const coordinator = createCoordinator()
      coordinator.openSettingsByContextMenu()

      expect(mockOpenSettings).toHaveBeenCalledOnce()
      expect(mockCloseSettings).not.toHaveBeenCalled()
    })

    it('設定が既に開いている場合 → no-op（onOpenSettings は呼ばれない）', () => {
      mockIsSettingsOpen.mockReturnValue(true)
      const coordinator = createCoordinator()
      coordinator.openSettingsByContextMenu()

      expect(mockOpenSettings).not.toHaveBeenCalled()
      expect(mockCloseSettings).not.toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // §B1. Ctrl+Q quit shortcut (registerQuitShortcut / unregisterQuitShortcut)
  // ---------------------------------------------------------------------------
  describe('Ctrl+Q quit shortcut (registerQuitShortcut / unregisterQuitShortcut)', () => {
    let mockOnQuit: ReturnType<typeof vi.fn>

    /**
     * mockShortcutRegister.mock.calls から 'Control+Q' に対応するコールバックを取得する。
     * I6 反映: accelerator でフィルタして取得（呼び出し順インデックス依存を避ける）。
     */
    function getQuitRegisteredCallback(): () => void {
      const ctrlQCall = mockShortcutRegister.mock.calls.find(
        (call: unknown[]) => call[0] === 'Control+Q',
      )
      if (!ctrlQCall || ctrlQCall.length < 2) {
        throw new Error('Control+Q shortcut has not been registered yet')
      }
      const cb = ctrlQCall[1]
      if (typeof cb !== 'function') {
        throw new Error('registered callback is not a function')
      }
      return cb as () => void
    }

    beforeEach(() => {
      mockOnQuit = vi.fn()
    })

    // B1-01: registerQuitShortcut() on X11 → 'Control+Q' が登録される
    it('B1-01: registerQuitShortcut() を X11 で呼ぶ → Control+Q が register される', () => {
      const coordinator = createCoordinator({ onQuit: mockOnQuit as () => void })
      coordinator.registerQuitShortcut()

      expect(mockShortcutRegister).toHaveBeenCalledWith('Control+Q', expect.any(Function))
    })

    // B1-02: Wayland → 登録スキップ + WARN（既存 Ctrl+L/Ctrl+G と同一パターン）
    it('B1-02: registerQuitShortcut() を Wayland で呼ぶ → 登録スキップ + WARN(input.shortcutSkipped, reason:wayland, accelerator:Control+Q)', () => {
      const coordinator = createCoordinator({
        isWayland: true,
        onQuit: mockOnQuit as () => void,
      })
      coordinator.registerQuitShortcut()

      const ctrlQCalls = mockShortcutRegister.mock.calls.filter(
        (call: unknown[]) => call[0] === 'Control+Q',
      )
      expect(ctrlQCalls).toHaveLength(0)
      expect(mockWarn).toHaveBeenCalledWith(
        'input.shortcutSkipped',
        expect.objectContaining({ reason: 'wayland', accelerator: 'Control+Q' }),
      )
    })

    // B1-03: globalShortcut.register が false を返す → WARN + 未登録
    it('B1-03: globalShortcut.register が false を返す → WARN(input.shortcutRegisterFailed) + 未登録状態', () => {
      mockShortcutRegister.mockReturnValue(false)
      const coordinator = createCoordinator({ onQuit: mockOnQuit as () => void })
      coordinator.registerQuitShortcut()

      expect(mockWarn).toHaveBeenCalledWith(
        'input.shortcutRegisterFailed',
        expect.objectContaining({ accelerator: 'Control+Q' }),
      )
    })

    // B1-04: 二重登録防止 → 2回呼んでも register は1回のみ
    it('B1-04: registerQuitShortcut() を2回呼ぶ → register は1回のみ（二重登録防止）', () => {
      const coordinator = createCoordinator({ onQuit: mockOnQuit as () => void })
      coordinator.registerQuitShortcut()
      coordinator.registerQuitShortcut()

      const ctrlQCalls = mockShortcutRegister.mock.calls.filter(
        (call: unknown[]) => call[0] === 'Control+Q',
      )
      expect(ctrlQCalls).toHaveLength(1)
    })

    // B1-05: 登録済みの場合 unregisterQuitShortcut() → unregister('Control+Q') 呼ばれる
    it('B1-05: 登録済みの unregisterQuitShortcut() → unregister("Control+Q") が呼ばれる', () => {
      const coordinator = createCoordinator({ onQuit: mockOnQuit as () => void })
      coordinator.registerQuitShortcut()
      coordinator.unregisterQuitShortcut()

      expect(mockShortcutUnregister).toHaveBeenCalledWith('Control+Q')
    })

    // B1-06: 未登録の場合 unregisterQuitShortcut() → no-op
    it('B1-06: 未登録状態で unregisterQuitShortcut() → unregister は呼ばれない（no-op）', () => {
      const coordinator = createCoordinator({ onQuit: mockOnQuit as () => void })
      coordinator.unregisterQuitShortcut()

      expect(mockShortcutUnregister).not.toHaveBeenCalled()
    })

    // B1-07: Ctrl+Q コールバック発火 → onQuit() が1回呼ばれる
    it('B1-07: Ctrl+Q コールバックが発火 → onQuit() が1回呼ばれる', () => {
      const coordinator = createCoordinator({ onQuit: mockOnQuit as () => void })
      coordinator.registerQuitShortcut()
      const callback = getQuitRegisteredCallback()
      callback()

      expect(mockOnQuit).toHaveBeenCalledOnce()
    })

    // B1-08: onQuit 未定義の場合に Ctrl+Q 発火 → エラーなし（no-op）
    it('B1-08: onQuit 未定義の状態で Ctrl+Q コールバック発火 → エラーなし（no-op）', () => {
      const coordinator = createCoordinator() // onQuit 未指定
      coordinator.registerQuitShortcut()
      const callback = getQuitRegisteredCallback()

      expect(() => callback()).not.toThrow()
    })
  })
})
