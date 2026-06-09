// electron-vite build config for Stigmergy Studio (ADR-15). Three targets: the Electron main
// process, the preload bridge, and the React renderer. externalizeDepsPlugin keeps the native
// better-sqlite3 and the workspace packages out of the bundle so they load from node_modules.
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve('src/main/index.ts') } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve('src/preload/index.ts') } },
    },
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } },
    },
    plugins: [react()],
  },
})
