/**
 * {{PROJECT_NAME}} — Electron main process.
 *
 * Creates the BrowserWindow and loads the Vue renderer. The
 * renderer runs Noydb directly with `@noy-db/to-file`, reading
 * and writing a local directory — the classic offline-first
 * "USB stick" workflow.
 *
 * Node integration is enabled so the renderer can import
 * `node:fs` (used internally by `@noy-db/to-file`). If you need
 * stricter isolation, move the Noydb handle to this process and
 * bridge a narrow API via `contextBridge` in `electron/preload.ts`.
 */

import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1024,
    height: 720,
    webPreferences: {
      // Pragmatic default for local-first apps — renderer needs
      // access to `node:fs` for `@noy-db/to-file`. Turn this off
      // and add a preload bridge if you're shipping to production
      // with untrusted content.
      nodeIntegration: true,
      contextIsolation: false,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

void app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
