mod app_settings;
mod data_transaction;
pub mod excel_import;
mod import_draft;
mod runtime_capabilities;
mod schedule_apply;
mod schedule_catalog;
mod schedule_store;
mod screenshot_import;
mod window_commands;

use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Listener, Manager, PhysicalPosition, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::DialogExt;

struct RuntimeState {
    quitting: AtomicBool,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            quitting: AtomicBool::new(false),
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyImportedScheduleRequest {
    first_week_monday: String,
    courses: Vec<excel_import::types::ParsedCourseEntry>,
    times: Vec<excel_import::types::SectionTime>,
    #[serde(default)]
    equal_duration: Option<bool>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveLessonTimesRequest {
    times: Vec<excel_import::types::SectionTime>,
    equal_duration: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplyImportedScheduleResult {
    course_count: usize,
    missing_location_count: usize,
    warnings: Vec<String>,
}

fn position_is_visible(window: &tauri::WebviewWindow) -> tauri::Result<bool> {
    let position = window.outer_position()?;
    let size = window.outer_size()?;

    Ok(window.available_monitors()?.iter().any(|monitor| {
        let monitor_position = monitor.position();
        let monitor_size = monitor.size();
        let right = monitor_position.x + monitor_size.width as i32;
        let bottom = monitor_position.y + monitor_size.height as i32;
        let window_right = position.x + size.width as i32;
        let window_bottom = position.y + size.height as i32;

        window_right > monitor_position.x
            && position.x < right
            && window_bottom > monitor_position.y
            && position.y < bottom
    }))
}

fn move_window_to_primary_monitor(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    if position_is_visible(window)? {
        return Ok(());
    }

    let Some(monitor) = window.primary_monitor()? else {
        return Ok(());
    };
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let window_size = window.outer_size()?;
    let x = monitor_position.x + (monitor_size.width.saturating_sub(window_size.width) / 2) as i32;
    let y =
        monitor_position.y + (monitor_size.height.saturating_sub(window_size.height) / 2) as i32;

    window.set_position(PhysicalPosition::new(x, y))
}

fn main_window(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    app.get_webview_window("main")
        .ok_or_else(|| tauri::Error::AssetNotFound("main widget window".into()))
}

fn settings_window(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    app.get_webview_window("settings")
        .ok_or_else(|| tauri::Error::AssetNotFound("settings window".into()))
}

fn onboarding_completed(app: &AppHandle) -> bool {
    app_settings::read_app_settings(app)
        .map(|settings| settings.onboarding_completed)
        .unwrap_or(true)
}

fn show_main_window(app: &AppHandle) -> tauri::Result<()> {
    let window = main_window(app)?;

    if let Err(error) = move_window_to_primary_monitor(&window) {
        eprintln!("[widget] visible-position check failed: {error}");
    }

    if let Ok(settings) = app_settings::read_app_settings(app) {
        let ball_mode = settings.ball_mode;
        window_commands::apply_main_widget_appearance(
            &window,
            f64::from(settings.widget_opacity),
            ball_mode,
        );
        if let Err(error) = app.emit("widget:mode-changed", ball_mode) {
            eprintln!("[widget] mode sync emit failed: {error}");
        }
    }

    window.show()?;
    if let Err(error) = app.emit("widget:visibility-changed", ()) {
        eprintln!("[widget] could not refresh the tray visibility label: {error}");
    }
    let app_for_delay = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(120));
        if let Err(error) = app_for_delay.emit("widget:shown", ()) {
            eprintln!("[widget] delayed shown emit failed: {error}");
        }
    });
    Ok(())
}

fn hide_main_window(app: &AppHandle) -> tauri::Result<()> {
    main_window(app)?.hide()?;
    if let Err(error) = app.emit("widget:visibility-changed", ()) {
        eprintln!("[widget] could not refresh the tray visibility label: {error}");
    }
    Ok(())
}

fn show_settings_window(app: &AppHandle) -> tauri::Result<()> {
    let window = settings_window(app)?;

    if let Err(error) = move_window_to_primary_monitor(&window) {
        eprintln!("[settings] visible-position check failed: {error}");
    }

    window.show()?;
    window.set_focus()?;
    Ok(())
}

fn show_primary_experience(app: &AppHandle) -> tauri::Result<()> {
    if onboarding_completed(app) {
        show_main_window(app)
    } else {
        show_settings_window(app)
    }
}

fn toggle_main_window(app: &AppHandle) -> tauri::Result<()> {
    if !onboarding_completed(app) {
        return show_settings_window(app);
    }

    let window = main_window(app)?;
    if window.is_visible()? {
        hide_main_window(app)
    } else {
        show_main_window(app)
    }
}

fn quit_application(app: &AppHandle) {
    app.state::<RuntimeState>()
        .quitting
        .store(true, Ordering::SeqCst);
    app.exit(0);
}

fn autostart_enabled<R: tauri::Runtime>(app: &AppHandle<R>) -> bool {
    if cfg!(debug_assertions) {
        return false;
    }

    match app.autolaunch().is_enabled() {
        Ok(enabled) => enabled,
        Err(error) => {
            eprintln!("[widget] could not read autostart state: {error}");
            false
        }
    }
}

fn toggle_autostart<R: tauri::Runtime>(app: &AppHandle<R>, menu_item: &CheckMenuItem<R>) {
    if cfg!(debug_assertions) {
        eprintln!("[widget] 请在 Release 版本测试开机启动");
        if let Err(error) = menu_item.set_checked(false) {
            eprintln!("[widget] could not reset debug autostart menu state: {error}");
        }
        return;
    }

    let result = match app.autolaunch().is_enabled() {
        Ok(true) => app.autolaunch().disable().map(|()| false),
        Ok(false) => app.autolaunch().enable().map(|()| true),
        Err(error) => Err(error),
    };

    match result {
        Ok(enabled) => {
            if let Err(error) = menu_item.set_checked(enabled) {
                eprintln!("[widget] could not update autostart menu state: {error}");
            }
        }
        Err(error) => {
            eprintln!("[widget] could not update autostart state: {error}");
            if let Err(menu_error) = menu_item.set_checked(autostart_enabled(app)) {
                eprintln!("[widget] could not restore autostart state: {menu_error}");
            }
        }
    }
}

fn sync_toggle_widget_menu_item<R: tauri::Runtime>(app: &AppHandle<R>, menu_item: &MenuItem<R>) {
    let visible = app
        .get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    let text = if visible {
        "隐藏组件"
    } else {
        "显示组件"
    };
    if let Err(error) = menu_item.set_text(text) {
        eprintln!("[widget] could not update tray visibility label: {error}");
    }
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let initial_toggle_text = if onboarding_completed(app.handle()) {
        "隐藏组件"
    } else {
        "显示组件"
    };
    let toggle_widget = MenuItem::with_id(
        app,
        "toggle-widget",
        initial_toggle_text,
        true,
        None::<&str>,
    )?;
    let settings = MenuItem::with_id(app, "open-settings", "课表与设置…", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(
        app,
        "toggle-autostart",
        "开机启动",
        true,
        autostart_enabled(app.handle()),
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit-application", "退出程序", true, None::<&str>)?;
    let separator_one = PredefinedMenuItem::separator(app)?;
    let separator_two = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &toggle_widget,
            &settings,
            &separator_one,
            &autostart,
            &separator_two,
            &quit,
        ],
    )?;

    let visibility_app = app.handle().clone();
    let visibility_menu_item = toggle_widget.clone();
    app.listen("widget:visibility-changed", move |_| {
        sync_toggle_widget_menu_item(&visibility_app, &visibility_menu_item);
    });

    let autostart_menu_item = autostart.clone();
    let tray_toggle_menu_item = toggle_widget.clone();
    // 区分单击/双击：单击延迟 250ms 执行，期间若有第二次点击则视为双击打开设置
    let pending_single_click = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let _tray = TrayIconBuilder::with_id("course-widget-tray")
        .icon(
            app.default_window_icon()
                .expect("application icon is configured")
                .clone(),
        )
        .tooltip("课刻-广东海洋大学定制版")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "toggle-widget" => {
                if let Err(error) = toggle_main_window(app) {
                    eprintln!("[widget] tray toggle failed: {error}");
                }
            }
            "open-settings" => {
                if let Err(error) = show_settings_window(app) {
                    eprintln!("[settings] tray show failed: {error}");
                }
            }
            "toggle-autostart" => toggle_autostart(app, &autostart_menu_item),
            "quit-application" => quit_application(app),
            _ => {}
        })
        .on_tray_icon_event(move |tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app_handle = tray.app_handle();
                if pending_single_click.load(Ordering::SeqCst) {
                    // 第二次点击（双击）→ 切换设置窗口显隐，取消待执行的单击
                    pending_single_click.store(false, Ordering::SeqCst);
                    if let Ok(window) = settings_window(&app_handle) {
                        if window.is_visible().unwrap_or(false) {
                            if let Err(error) = window.hide() {
                                eprintln!("[settings] tray double-click hide failed: {error}");
                            }
                        } else if let Err(error) = show_settings_window(&app_handle) {
                            eprintln!("[settings] tray double-click show failed: {error}");
                        }
                    }
                } else {
                    // 第一次点击 → 标记待执行，延迟 250ms 看是否有第二次
                    pending_single_click.store(true, Ordering::SeqCst);
                    let pending = pending_single_click.clone();
                    let app_for_timer = app_handle.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(250));
                        if pending.load(Ordering::SeqCst) {
                            pending.store(false, Ordering::SeqCst);
                            if let Err(error) = toggle_main_window(&app_for_timer) {
                                eprintln!("[widget] tray single-click toggle failed: {error}");
                            }
                        }
                    });
                }
            } else if let TrayIconEvent::Click {
                button: MouseButton::Right,
                button_state: MouseButtonState::Down,
                ..
            } = event
            {
                sync_toggle_widget_menu_item(tray.app_handle(), &tray_toggle_menu_item);
            }
        })
        .build(app)?;

    Ok(())
}

#[tauri::command]
fn read_schedule(app: AppHandle) -> Result<schedule_store::Schedule, String> {
    schedule_store::read_user_schedule(&app)
}

#[tauri::command]
fn read_app_settings(app: AppHandle) -> Result<app_settings::AppSettings, String> {
    app_settings::read_app_settings(&app)
}

#[tauri::command]
fn get_runtime_capabilities() -> runtime_capabilities::RuntimeCapabilities {
    runtime_capabilities::current()
}

#[tauri::command]
fn save_lesson_times(
    app: AppHandle,
    request: SaveLessonTimesRequest,
) -> Result<app_settings::AppSettings, String> {
    app_settings::save_lesson_times(&app, request.times, request.equal_duration, false)
}

#[tauri::command]
fn save_widget_opacity(
    app: AppHandle,
    opacity: f64,
) -> Result<app_settings::AppSettings, String> {
    app_settings::save_widget_opacity(&app, opacity as f32)
}

#[tauri::command]
fn save_ball_mode(app: AppHandle, ball_mode: bool) -> Result<app_settings::AppSettings, String> {
    app_settings::save_ball_mode(&app, ball_mode)
}

#[tauri::command]
fn save_widget_style(
    app: AppHandle,
    theme: String,
    background: String,
    radius: f64,
    font_scale: f64,
) -> Result<app_settings::AppSettings, String> {
    app_settings::save_widget_style(&app, theme, background, radius as f32, font_scale as f32)
}

#[tauri::command]
fn save_special_rules(
    app: AppHandle,
    rules: Vec<app_settings::SpecialScheduleRule>,
) -> Result<app_settings::AppSettings, String> {
    app_settings::save_special_rules(&app, rules)
}

#[tauri::command]
fn save_app_font_scale(app: AppHandle, font_scale: f64) -> Result<app_settings::AppSettings, String> {
    app_settings::save_app_font_scale(&app, font_scale as f32)
}

#[tauri::command]
fn apply_widget_style(
    window: tauri::WebviewWindow,
    theme: String,
    background: String,
    radius: f64,
    font_scale: f64,
) -> Result<(), String> {
    let payload = WidgetStylePayload {
        theme,
        background,
        radius,
        font_scale,
    };
    window
        .app_handle()
        .emit("widget:style-changed", payload)
        .map_err(|error| error.to_string())
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WidgetStylePayload {
    theme: String,
    background: String,
    radius: f64,
    font_scale: f64,
}

/// 将 PDF 页面 base64 写入临时文件并走截图 OCR 管线，返回导入草稿
#[tauri::command]
async fn recognize_png_data(
    app: AppHandle,
    data_url: String,
    source_name: String,
) -> Result<import_draft::ImportDraft, String> {
    let Some((_, encoded)) = data_url.split_once(',') else {
        return Err("无效的图片数据".into());
    };
    let bytes = decode_base64(encoded).map_err(|_| "图片数据解码失败".to_owned())?;
    if bytes.is_empty() {
        return Err("图片数据为空".into());
    }
    if bytes.len() > 40 * 1024 * 1024 {
        return Err("图片数据过大（超过 40MB）".into());
    }

    let temp_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("无法创建临时目录：{error}"))?;
    std::fs::create_dir_all(&temp_dir).map_err(|error| error.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let path = temp_dir.join(format!("widget-pdf-page-{stamp}.png"));
    std::fs::write(&path, &bytes).map_err(|error| error.to_string())?;

    let path_for_task = path.clone();
    let recognized = tauri::async_runtime::spawn_blocking(move || {
        screenshot_import::recognize_screenshot(&path_for_task)
    })
    .await
    .map_err(|error| format!("课表识别任务异常结束：{error}"))??;

    if let Err(error) = std::fs::remove_file(&path) {
        eprintln!("[pdf-import] could not remove temp page image: {error}");
    }

    let mut draft = recognized;
    let clean_name = source_name
        .trim()
        .split(" 第")
        .next()
        .unwrap_or("")
        .trim()
        .trim_end_matches(".png")
        .trim_end_matches(".pdf")
        .trim_end_matches('.')
        .trim();
    if !clean_name.is_empty() {
        draft.suggested_name = clean_name.to_owned();
    }
    draft.source_name = source_name.trim().to_owned();
    if draft.source_name.is_empty() {
        draft.source_name = "PDF 课表".into();
    }
    Ok(draft)
}

fn decode_base64(encoded: &str) -> Result<Vec<u8>, ()> {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut lookup = [255u8; 128];
    for (index, byte) in TABLE.iter().enumerate() {
        lookup[*byte as usize] = index as u8;
    }

    let mut output = Vec::with_capacity(encoded.len() / 4 * 3);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for character in encoded.bytes() {
        if character == b'=' {
            break;
        }
        let index = character as usize;
        if index >= lookup.len() {
            return Err(());
        }
        let value = lookup[index];
        if value == 255 {
            return Err(());
        }
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((buffer >> bits) as u8);
        }
    }
    // Padding handling: trailing bytes are already emitted; nothing to flush.
    Ok(output)
}

#[tauri::command]
async fn choose_and_parse_screenshot(
    app: AppHandle,
) -> Result<Option<import_draft::ImportDraft>, String> {
    let capability = runtime_capabilities::current().screenshot_import;
    if !capability.available {
        return Err(capability
            .unavailable_reason
            .unwrap_or_else(|| screenshot_import::RELEASE_UNAVAILABLE_REASON.into()));
    }

    let selected = app
        .dialog()
        .file()
        .add_filter("课表截图", &["png", "jpg", "jpeg"])
        .blocking_pick_file();

    let Some(selected) = selected else {
        return Ok(None);
    };

    let path = selected
        .into_path()
        .map_err(|_| "无法读取所选课表截图路径".to_owned())?;
    let draft = tauri::async_runtime::spawn_blocking(move || {
        screenshot_import::recognize_screenshot(&path)
    })
    .await
    .map_err(|error| format!("截图识别任务异常结束：{error}"))??;
    Ok(Some(draft))
}

#[tauri::command]
async fn choose_and_parse_excel(
    app: AppHandle,
) -> Result<Option<import_draft::ImportDraft>, String> {
    let selected = app
        .dialog()
        .file()
        .add_filter("Excel 课表", &["xlsx"])
        .blocking_pick_file();

    let Some(selected) = selected else {
        return Ok(None);
    };

    let path = selected
        .into_path()
        .map_err(|_| "无法读取所选 Excel 文件路径".to_owned())?;
    let parsed = excel_import::workbook::parse_xlsx(&path)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("已选择课表.xlsx")
        .to_owned();
    let draft = import_draft::ImportDraft::from_excel(file_name, parsed);
    draft.validate()?;
    Ok(Some(draft))
}

#[tauri::command]
fn apply_imported_schedule(
    app: AppHandle,
    request: ApplyImportedScheduleRequest,
) -> Result<ApplyImportedScheduleResult, String> {
    if request.courses.is_empty() {
        return Err("没有可应用的课程安排".into());
    }

    let equal_duration = request.equal_duration.unwrap_or_else(|| {
        app_settings::read_app_settings(&app)
            .map(|settings| settings.equal_duration)
            .unwrap_or(false)
    });
    let missing_location_count = request
        .courses
        .iter()
        .filter(|course| {
            course
                .location
                .as_deref()
                .is_none_or(|location| location.trim().is_empty())
        })
        .count();
    let parsed = excel_import::types::ParsedWorkbook {
        detected_term_text: None,
        scheduled_entries: request.courses,
        warnings: vec![],
        lesson_times: None,
    };
    let schedule = excel_import::converter::preview_schedule(
        &parsed,
        &request.first_week_monday,
        &request.times,
    )?;
    let course_count = schedule.courses.len();
    let warnings = schedule_catalog::replace_active_schedule_from_legacy(
        &app,
        schedule,
        request.times,
        equal_duration,
    )?;

    if let Err(error) = app.emit("schedule:updated", ()) {
        eprintln!("[schedule] update event failed after commit: {error}");
    }
    if let Err(error) = app.emit("onboarding:completed", ()) {
        eprintln!("[schedule] onboarding event failed after commit: {error}");
    }

    Ok(ApplyImportedScheduleResult {
        course_count,
        missing_location_count,
        warnings,
    })
}

fn schedule_startup_safety_fallback(app: &tauri::App) {
    let app_handle = app.handle().clone();

    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(3));
        let fallback_handle = app_handle.clone();
        let _ = app_handle.run_on_main_thread(move || {
            let window = match main_window(&fallback_handle) {
                Ok(window) => window,
                Err(error) => {
                    eprintln!(
                        "[widget] startup visibility fallback could not find the window: {error}"
                    );
                    return;
                }
            };

            match window.is_visible() {
                Ok(false) => {
                    eprintln!(
                        "[widget] frontend did not show the window before the visibility fallback"
                    );
                    if let Err(error) = show_main_window(&fallback_handle) {
                        eprintln!("[widget] visibility fallback failed: {error}");
                    }
                }
                Ok(true) => {}
                Err(error) => eprintln!("[widget] could not read window visibility: {error}"),
            }
        });
    });
}

fn intercept_main_close(app: &AppHandle, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        if !app.state::<RuntimeState>().quitting.load(Ordering::SeqCst) {
            api.prevent_close();
            if let Err(error) = hide_main_window(app) {
                eprintln!("[widget] close-to-tray hide failed: {error}");
            }
        }
    }
}

fn intercept_settings_close(app: &AppHandle, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        if !app.state::<RuntimeState>().quitting.load(Ordering::SeqCst) {
            api.prevent_close();
            if let Err(error) = app.emit("settings:close-requested", ()) {
                eprintln!("[settings] close request emit failed: {error}");
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(RuntimeState::default())
        // The single-instance plugin must be registered before every other plugin.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Err(error) = show_primary_experience(app) {
                eprintln!("[widget] secondary launch could not show the existing window: {error}");
            }
        }));

    builder
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tauri_plugin_window_state::StateFlags::POSITION)
                .build(),
        )
        .plugin(schedule_catalog::init())
        .setup(|app| {
            if let Err(error) = data_transaction::recover_pending(app.handle()) {
                return Err(std::io::Error::other(error).into());
            }
            let had_schedule_before_start = schedule_store::resolve_schedule_path(app.handle())
                .map(|path| path.exists())
                .unwrap_or(false);
            if let Err(error) = schedule_store::ensure_schedule_storage(app.handle()) {
                eprintln!("[schedule] startup storage failed: {error}");
            }
            let onboarding_completed =
                match app_settings::ensure_app_settings(app.handle(), had_schedule_before_start) {
                    Ok(settings) => settings.onboarding_completed,
                    Err(error) => {
                        eprintln!("[settings] startup storage failed: {error}");
                        true
                    }
                };
            if let Err(error) = schedule_catalog::initialize(app.handle()) {
                return Err(std::io::Error::other(error).into());
            }

            setup_tray(app)?;

            let main_close_app = app.handle().clone();
            main_window(app.handle())?
                .on_window_event(move |event| {
                    intercept_main_close(&main_close_app, event);
                    match event {
                        tauri::WindowEvent::Moved(_) => {
                            // Keep the widget from being dragged entirely off-screen.
                            if let Some(win) = main_close_app.get_webview_window("main") {
                                window_commands::clamp_off_screen(&win);
                            }
                            let _ = main_close_app.emit("widget:moved", ());
                        }
                        tauri::WindowEvent::ScaleFactorChanged { .. } => {
                            let _ = main_close_app.emit("widget:scale-changed", ());
                        }
                        _ => {}
                    }
                });

            let settings_close_app = app.handle().clone();
            settings_window(app.handle())?
                .on_window_event(move |event| intercept_settings_close(&settings_close_app, event));

            if onboarding_completed {
                schedule_startup_safety_fallback(app);
            } else {
                show_settings_window(app.handle())?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_schedule,
            read_app_settings,
            get_runtime_capabilities,
            window_commands::open_presentation_controller,
            window_commands::configure_main_widget,
            window_commands::resize_main_widget,
            window_commands::show_main_widget,
            window_commands::hide_main_widget,
            window_commands::start_main_widget_drag,
            window_commands::hide_settings_window,
            window_commands::hide_presentation_window,
            window_commands::set_main_widget_opacity,
            window_commands::set_main_widget_mode,
            save_lesson_times,
            save_widget_opacity,
            save_ball_mode,
            save_widget_style,
            save_special_rules,
            save_app_font_scale,
            apply_widget_style,
            choose_and_parse_excel,
            choose_and_parse_screenshot,
            recognize_png_data,
            apply_imported_schedule,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
