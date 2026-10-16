import { invoke } from '@tauri-apps/api/core'

// 窗口尺寸由 Rust 侧统一管理，前端不做高度泵
export async function startDesktopShell(_app: HTMLDivElement) {
  await invoke('configure_main_widget').catch((error: unknown) =>
    console.error('[desktop-shell] window bounds setup failed', error),
  )
  await invoke('show_main_widget').catch((error: unknown) =>
    console.error('[desktop-shell] widget show failed', error),
  )
}
