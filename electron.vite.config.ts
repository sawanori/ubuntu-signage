import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          overlay: resolve(__dirname, 'src/preload/overlay.ts'),
          settings: resolve(__dirname, 'src/preload/settings.ts'),
          hotspot: resolve(__dirname, 'src/preload/hotspot.ts'),
          addressbar: resolve(__dirname, 'src/preload/addressbar.ts'),
        },
      },
    },
  },
  renderer: {
    build: {
      rollupOptions: {
        input: {
          overlay: resolve(__dirname, 'src/renderer/overlay/index.html'),
          settings: resolve(__dirname, 'src/renderer/settings/index.html'),
          hotspot: resolve(__dirname, 'src/renderer/hotspot/index.html'),
          addressbar: resolve(__dirname, 'src/renderer/addressbar/index.html'),
          start: resolve(__dirname, 'src/renderer/start/index.html'),
        },
      },
    },
  },
})
