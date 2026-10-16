use tauri::{Emitter, LogicalSize, Manager};

const MAIN_WINDOW_LABEL: &str = "main";
const SETTINGS_WINDOW_LABEL: &str = "settings";
const PRESENTATION_WINDOW_LABEL: &str = "presentation";
const MAIN_WINDOW_WIDTH: f64 = 392.0;
const MAIN_WINDOW_MIN_HEIGHT: f64 = 160.0;
const MAIN_WINDOW_MAX_HEIGHT: f64 = 1200.0;
const MAIN_WINDOW_MIN_WIDTH: f64 = 240.0;
const MAIN_WINDOW_MAX_WIDTH: f64 = 800.0;
const BALL_SIZE: f64 = 84.0;
const MIN_OPACITY: f64 = 0.0;
const MAX_OPACITY: f64 = 1.0;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MainWindowMetrics {
    logical_width: f64,
    logical_height: f64,
    physical_width: f64,
    physical_height: f64,
    scale_factor: f64,
}

fn require_window_label(
    window: &tauri::WebviewWindow,
    expected: &str,
) -> Result<(), String> {
    if window.label() == expected {
        Ok(())
    } else {
        Err(format!(
            "window command rejected for caller {}",
            window.label()
        ))
    }
}

/// 允许设置窗口调用组件相关命令（改外观/模式即时生效），主窗口点击悬浮球也可切换
fn require_window_label_any(
    window: &tauri::WebviewWindow,
    expected: &[&str],
) -> Result<(), String> {
    if expected.iter().any(|label| window.label() == *label) {
        Ok(())
    } else {
        Err(format!(
            "window command rejected for caller {}",
            window.label()
        ))
    }
}

#[tauri::command]
pub fn open_presentation_controller(window: tauri::WebviewWindow) -> Result<(), String> {
    require_window_label(&window, MAIN_WINDOW_LABEL)?;
    let controller = window
        .app_handle()
        .get_webview_window(PRESENTATION_WINDOW_LABEL)
        .ok_or_else(|| "presentation controller window is unavailable".to_owned())?;
    controller.show().map_err(|error| error.to_string())?;
    controller.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn configure_main_widget(window: tauri::WebviewWindow) -> Result<(), String> {
    require_window_label(&window, MAIN_WINDOW_LABEL)?;
    window
        .set_min_size(Some(LogicalSize::new(
            MAIN_WINDOW_WIDTH,
            MAIN_WINDOW_MIN_HEIGHT,
        )))
        .map_err(|error| error.to_string())?;
    window
        .set_max_size(Some(LogicalSize::new(
            MAIN_WINDOW_WIDTH,
            MAIN_WINDOW_MAX_HEIGHT,
        )))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn resize_main_widget(
    window: tauri::WebviewWindow,
    height: f64,
    width: Option<f64>,
) -> Result<MainWindowMetrics, String> {
    require_window_label(&window, MAIN_WINDOW_LABEL)?;
    let w = width.unwrap_or(MAIN_WINDOW_WIDTH);
    if !w.is_finite() || !(MAIN_WINDOW_MIN_WIDTH..=MAIN_WINDOW_MAX_WIDTH).contains(&w) {
        return Err(format!(
            "main window width must be between {MAIN_WINDOW_MIN_WIDTH} and {MAIN_WINDOW_MAX_WIDTH}"
        ));
    }
    if !height.is_finite() || !(MAIN_WINDOW_MIN_HEIGHT..=MAIN_WINDOW_MAX_HEIGHT).contains(&height) {
        return Err(format!(
            "main window height must be between {MAIN_WINDOW_MIN_HEIGHT} and {MAIN_WINDOW_MAX_HEIGHT}"
        ));
    }

    window
        .set_size(LogicalSize::new(w, height))
        .map_err(|error| error.to_string())?;

    let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;

    Ok(MainWindowMetrics {
        logical_width: w,
        logical_height: height,
        physical_width: w * scale_factor,
        physical_height: height * scale_factor,
        scale_factor,
    })
}

#[tauri::command]
pub fn show_main_widget(window: tauri::WebviewWindow) -> Result<(), String> {
    require_window_label(&window, MAIN_WINDOW_LABEL)?;
    super::show_main_window(window.app_handle()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn hide_main_widget(window: tauri::WebviewWindow) -> Result<(), String> {
    require_window_label(&window, MAIN_WINDOW_LABEL)?;
    super::hide_main_window(window.app_handle()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn start_main_widget_drag(window: tauri::WebviewWindow) -> Result<(), String> {
    require_window_label(&window, MAIN_WINDOW_LABEL)?;
    window.start_dragging().map_err(|error| error.to_string())
}

/// 窗口拖动时保持可见：允许跨越多个屏幕（扩展显示器中间可跨越），
/// 仅当窗口完全移出所有屏幕时才拉回最近屏幕的可见区域。
pub(crate) fn clamp_off_screen(window: &tauri::WebviewWindow) {
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let Ok(monitors) = window.available_monitors() else {
        return;
    };
    let (x, y) = (position.x, position.y);
    let (w, h) = (size.width as i32, size.height as i32);
    let win_right = x + w;
    let win_bottom = y + h;

    // 检查窗口是否与任一屏幕有交集（允许跨屏，只要有一部分可见即可）
    let mut visible = false;
    for monitor in &monitors {
        let m = monitor.position();
        let ms = monitor.size();
        let m_right = m.x + ms.width as i32;
        let m_bottom = m.y + ms.height as i32;
        if x < m_right && win_right > m.x && y < m_bottom && win_bottom > m.y {
            visible = true;
            break;
        }
    }
    if visible {
        return;
    }

    // 完全不可见：拉回距离最近的屏幕
    if let Some(primary) = window.primary_monitor().ok().flatten() {
        let m = primary.position();
        let ms = primary.size();
        let m_right = m.x + ms.width as i32;
        let m_bottom = m.y + ms.height as i32;
        let new_x = x.clamp(m.x, (m_right - w).max(m.x));
        let new_y = y.clamp(m.y, (m_bottom - h).max(m.y));
        if new_x != x || new_y != y {
            let _ = window.set_position(tauri::PhysicalPosition::new(new_x, new_y));
        }
    }
}

#[tauri::command]
pub fn hide_settings_window(window: tauri::WebviewWindow) -> Result<(), String> {
    require_window_label(&window, SETTINGS_WINDOW_LABEL)?;
    window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn hide_presentation_window(window: tauri::WebviewWindow) -> Result<(), String> {
    require_window_label(&window, PRESENTATION_WINDOW_LABEL)?;
    window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_main_widget_opacity(
    window: tauri::WebviewWindow,
    opacity: f64,
) -> Result<(), String> {
    require_window_label_any(&window, &[MAIN_WINDOW_LABEL, SETTINGS_WINDOW_LABEL])?;
    if !opacity.is_finite() || !(MIN_OPACITY..=MAX_OPACITY).contains(&opacity) {
        return Err("组件透明度必须在 0%～100% 之间".into());
    }
    window
        .app_handle()
        .emit("widget:opacity-changed", opacity)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_main_widget_mode(
    window: tauri::WebviewWindow,
    ball_mode: bool,
) -> Result<(), String> {
    require_window_label_any(&window, &[MAIN_WINDOW_LABEL, SETTINGS_WINDOW_LABEL])?;
    // 始终操作 main 窗口，避免从 settings 调用时误改设置窗口尺寸
    let main = window
        .app_handle()
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "main widget window is unavailable".to_owned())?;
    apply_widget_mode(&main, ball_mode)?;
    window
        .app_handle()
        .emit("widget:mode-changed", ball_mode)
        .map_err(|error| error.to_string())
}

fn apply_widget_mode(window: &tauri::WebviewWindow, ball_mode: bool) -> Result<(), String> {
    if ball_mode {
        window
            .set_size(LogicalSize::new(BALL_SIZE, BALL_SIZE))
            .map_err(|error| error.to_string())?;
        window
            .set_always_on_top(true)
            .map_err(|error| error.to_string())?;
    } else {
        let card_height = if let Ok(Some(monitor)) = window.current_monitor() {
            let work_area = monitor.work_area();
            let dpr = window.scale_factor().unwrap_or(1.0);
            let avail_logical = work_area.size.height as f64 / dpr;
            (avail_logical - 48.0).clamp(320.0, 600.0)
        } else {
            480.0
        };
        window
            .set_size(LogicalSize::new(MAIN_WINDOW_WIDTH, card_height))
            .map_err(|error| error.to_string())?;
        window
            .set_always_on_top(false)
            .map_err(|error| error.to_string())?;
        window
            .set_always_on_bottom(false)
            .map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// 将已保存的视觉设置（透明度/球模式）应用到主窗口，启动与保存时调用
pub fn apply_main_widget_appearance(window: &tauri::WebviewWindow, _opacity: f64, ball_mode: bool) {
    if let Err(error) = apply_widget_mode(window, ball_mode) {
        eprintln!("[widget] could not apply widget mode: {error}");
    }
}
