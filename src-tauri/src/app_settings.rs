use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    data_transaction::{self, FileChange},
    excel_import::types::SectionTime,
};

const SETTINGS_FILE: &str = "settings.json";
const MAX_LESSONS: usize = 24;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpecialScheduleRule {
    pub keywords: Vec<String>,
    pub section_start: String,
    pub section_end: String,
    pub actual_start: String,
    pub actual_end: String,
    pub color: String,
}

fn default_special_rules() -> Vec<SpecialScheduleRule> {
    vec![
        SpecialScheduleRule {
            keywords: vec!["广学楼".into(), "明德楼".into()],
            section_start: "10:15".into(),
            section_end: "11:50".into(),
            actual_start: "10:05".into(),
            actual_end: "11:35".into(),
            color: "#8fb8aa".into(),
        },
        SpecialScheduleRule {
            keywords: vec!["广学楼".into(), "明德楼".into()],
            section_start: "16:30".into(),
            section_end: "18:05".into(),
            actual_start: "16:25".into(),
            actual_end: "17:55".into(),
            color: "#5b7c99".into(),
        },
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "schema_version")]
    pub schema_version: u8,
    #[serde(default)]
    pub onboarding_completed: bool,
    #[serde(default = "default_lesson_times")]
    pub lesson_times: Vec<SectionTime>,
    #[serde(default)]
    pub equal_duration: bool,
    #[serde(default = "default_widget_opacity")]
    pub widget_opacity: f32,
    #[serde(default = "default_ball_mode")]
    pub ball_mode: bool,
    #[serde(default = "default_widget_theme")]
    pub widget_theme: String,
    #[serde(default = "default_widget_background")]
    pub widget_background: String,
    #[serde(default = "default_widget_radius")]
    pub widget_radius: f32,
    #[serde(default = "default_widget_font_scale")]
    pub widget_font_scale: f32,
    #[serde(default = "default_app_font_scale")]
    pub app_font_scale: f32,
    #[serde(default = "default_special_rules")]
    pub special_schedule_rules: Vec<SpecialScheduleRule>,
}

fn schema_version() -> u8 {
    1
}

fn default_widget_opacity() -> f32 {
    1.0
}

fn default_ball_mode() -> bool {
    true
}

fn default_widget_theme() -> String {
    "dark".into()
}

fn default_widget_background() -> String {
    "dark".into()
}

fn default_widget_radius() -> f32 {
    22.0
}

fn default_widget_font_scale() -> f32 {
    1.0
}

fn default_app_font_scale() -> f32 {
    1.0
}

pub fn default_lesson_times() -> Vec<SectionTime> {
    [
        (1, "08:10", "08:55"),
        (2, "09:00", "09:45"),
        (3, "10:15", "11:00"),
        (4, "11:05", "11:50"),
        (5, "14:30", "15:15"),
        (6, "15:20", "16:05"),
        (7, "16:30", "17:15"),
        (8, "17:20", "18:05"),
        (9, "19:30", "20:15"),
        (10, "20:25", "21:10"),
    ]
    .into_iter()
    .map(|(section, start, end)| SectionTime {
        section,
        start: start.into(),
        end: end.into(),
    })
    .collect()
}

fn default_settings(onboarding_completed: bool) -> AppSettings {
    AppSettings {
        schema_version: schema_version(),
        onboarding_completed,
        lesson_times: default_lesson_times(),
        equal_duration: false,
        widget_opacity: default_widget_opacity(),
        ball_mode: default_ball_mode(),
        widget_theme: default_widget_theme(),
        widget_background: default_widget_background(),
        widget_radius: default_widget_radius(),
        widget_font_scale: default_widget_font_scale(),
        app_font_scale: default_app_font_scale(),
        special_schedule_rules: default_special_rules(),
    }
}

pub(crate) fn resolve_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join(SETTINGS_FILE))
}

pub fn ensure_app_settings(
    app: &AppHandle,
    migrated_onboarding_completed: bool,
) -> Result<AppSettings, String> {
    let path = resolve_settings_path(app)?;
    if path.exists() {
        return read_from_path(&path);
    }

    let settings = default_settings(migrated_onboarding_completed);
    write_atomic(&path, &settings)?;
    Ok(settings)
}

pub fn read_app_settings(app: &AppHandle) -> Result<AppSettings, String> {
    let path = resolve_settings_path(app)?;
    if !path.exists() {
        return ensure_app_settings(app, false);
    }
    read_from_path(&path)
}

pub(crate) fn prepare_lesson_times(
    app: &AppHandle,
    lesson_times: Vec<SectionTime>,
    equal_duration: bool,
    complete_onboarding: bool,
) -> Result<(AppSettings, Vec<u8>), String> {
    let path = resolve_settings_path(app)?;
    let mut settings = if path.exists() {
        read_from_path(&path)?
    } else {
        default_settings(false)
    };
    settings.lesson_times = normalize_lesson_times(lesson_times)?;
    settings.equal_duration = equal_duration;
    if complete_onboarding {
        settings.onboarding_completed = true;
    }
    let bytes = serialize_settings(&settings)?;
    let check = read_from_bytes(&bytes)?;
    if check != settings {
        return Err("设置序列化校验失败".into());
    }
    Ok((settings, bytes))
}

pub fn save_lesson_times(
    app: &AppHandle,
    lesson_times: Vec<SectionTime>,
    equal_duration: bool,
    complete_onboarding: bool,
) -> Result<AppSettings, String> {
    let (settings, bytes) =
        prepare_lesson_times(app, lesson_times, equal_duration, complete_onboarding)?;
    data_transaction::commit(
        app,
        vec![FileChange::write(resolve_settings_path(app)?, bytes)],
    )?;
    Ok(settings)
}

/// Persists the main widget window opacity (0.00–1.00). Returns the updated
/// settings, keeping every other field untouched.
pub fn save_widget_opacity(app: &AppHandle, opacity: f32) -> Result<AppSettings, String> {
    if !opacity.is_finite() || !(0.0..=1.0).contains(&opacity) {
        return Err("组件透明度必须在 0%～100% 之间".into());
    }
    let path = resolve_settings_path(app)?;
    let mut settings = if path.exists() {
        read_from_path(&path)?
    } else {
        default_settings(false)
    };
    settings.widget_opacity = opacity;
    let bytes = serialize_settings(&settings)?;
    let check = read_from_bytes(&bytes)?;
    if check != settings {
        return Err("设置序列化校验失败".into());
    }
    data_transaction::commit(app, vec![FileChange::write(path, bytes)])?;
    Ok(settings)
}

/// Persists whether the main window starts as the floating ball.
pub fn save_ball_mode(app: &AppHandle, ball_mode: bool) -> Result<AppSettings, String> {
    let path = resolve_settings_path(app)?;
    let mut settings = if path.exists() {
        read_from_path(&path)?
    } else {
        default_settings(false)
    };
    settings.ball_mode = ball_mode;
    let bytes = serialize_settings(&settings)?;
    let check = read_from_bytes(&bytes)?;
    if check != settings {
        return Err("设置序列化校验失败".into());
    }
    data_transaction::commit(app, vec![FileChange::write(path, bytes)])?;
    Ok(settings)
}

/// Persists widget visual style (theme / background / corner radius / font
/// scale). Values are validated against the known option sets.
pub fn save_widget_style(
    app: &AppHandle,
    theme: String,
    background: String,
    radius: f32,
    font_scale: f32,
) -> Result<AppSettings, String> {
    if !matches!(theme.as_str(), "light" | "dark") {
        return Err("主题必须是 light 或 dark".into());
    }
    if !matches!(background.as_str(), "blue" | "light" | "dark" | "colorful") {
        return Err("背景风格无效".into());
    }
    if !(8.0..=40.0).contains(&radius) {
        return Err("圆角必须在 8～40 之间".into());
    }
    if !(0.8..=1.3).contains(&font_scale) {
        return Err("字号必须在 0.8～1.3 之间".into());
    }
    let path = resolve_settings_path(app)?;
    let mut settings = if path.exists() {
        read_from_path(&path)?
    } else {
        default_settings(false)
    };
    settings.widget_theme = theme;
    settings.widget_background = background;
    settings.widget_radius = radius;
    settings.widget_font_scale = font_scale;
    let bytes = serialize_settings(&settings)?;
    let check = read_from_bytes(&bytes)?;
    if check != settings {
        return Err("设置序列化校验失败".into());
    }
    data_transaction::commit(app, vec![FileChange::write(path, bytes)])?;
    Ok(settings)
}

pub fn save_app_font_scale(app: &AppHandle, font_scale: f32) -> Result<AppSettings, String> {
    if !(0.8..=1.3).contains(&font_scale) {
        return Err("字号必须在 0.8～1.3 之间".into());
    }
    let path = resolve_settings_path(app)?;
    let mut settings = if path.exists() {
        read_from_path(&path)?
    } else {
        default_settings(false)
    };
    settings.app_font_scale = font_scale;
    let bytes = serialize_settings(&settings)?;
    let check = read_from_bytes(&bytes)?;
    if check != settings {
        return Err("设置序列化校验失败".into());
    }
    data_transaction::commit(app, vec![FileChange::write(path, bytes)])?;
    Ok(settings)
}

/// Persists the special schedule rules list (keyword-triggered time labels).
pub fn save_special_rules(
    app: &AppHandle,
    rules: Vec<SpecialScheduleRule>,
) -> Result<AppSettings, String> {
    for rule in &rules {
        if rule.keywords.is_empty() {
            return Err("关键词不能为空".into());
        }
        if rule.section_start.is_empty() || rule.section_end.is_empty() {
            return Err("节次时间不能为空".into());
        }
    }
    let path = resolve_settings_path(app)?;
    let mut settings = if path.exists() {
        read_from_path(&path)?
    } else {
        default_settings(false)
    };
    settings.special_schedule_rules = rules;
    let bytes = serialize_settings(&settings)?;
    let check = read_from_bytes(&bytes)?;
    if check != settings {
        return Err("设置序列化校验失败".into());
    }
    data_transaction::commit(app, vec![FileChange::write(path, bytes)])?;
    let _ = app.emit("schedule:updated", ());
    Ok(settings)
}

fn read_from_path(path: &Path) -> Result<AppSettings, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    read_from_bytes(&bytes)
}

fn read_from_bytes(bytes: &[u8]) -> Result<AppSettings, String> {
    let mut settings: AppSettings =
        serde_json::from_slice(bytes).map_err(|error| format!("设置文件格式错误：{error}"))?;
    if settings.schema_version != schema_version() {
        return Err("设置文件版本不受支持".into());
    }
    settings.lesson_times = normalize_lesson_times(settings.lesson_times)?;
    Ok(settings)
}

fn serialize_settings(settings: &AppSettings) -> Result<Vec<u8>, String> {
    Ok(format!(
        "{}\n",
        serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?
    )
    .into_bytes())
}

fn write_atomic(path: &Path, settings: &AppSettings) -> Result<(), String> {
    let bytes = serialize_settings(settings)?;
    let check = read_from_bytes(&bytes)?;
    if &check != settings {
        return Err("临时设置校验失败".into());
    }
    data_transaction::replace_file(path, &bytes)
}

fn normalize_lesson_times(mut lesson_times: Vec<SectionTime>) -> Result<Vec<SectionTime>, String> {
    lesson_times.sort_by_key(|item| item.section);
    if lesson_times.is_empty() || lesson_times.len() > MAX_LESSONS {
        return Err(format!("作息时间必须包含 1～{MAX_LESSONS} 节"));
    }

    for (index, item) in lesson_times.iter().enumerate() {
        let expected = (index + 1) as u8;
        if item.section != expected {
            return Err(format!("缺少第 {expected} 节作息时间"));
        }
        let start = time_to_minutes(&item.start)
            .ok_or_else(|| format!("第 {expected} 节开始时间格式无效"))?;
        let end = time_to_minutes(&item.end)
            .ok_or_else(|| format!("第 {expected} 节结束时间格式无效"))?;
        if end <= start {
            return Err(format!("第 {expected} 节结束时间必须晚于开始时间"));
        }
    }

    Ok(lesson_times)
}

fn time_to_minutes(value: &str) -> Option<u16> {
    let (hours, minutes) = value.split_once(':')?;
    if hours.len() != 2 || minutes.len() != 2 {
        return None;
    }
    let hours: u16 = hours.parse().ok()?;
    let minutes: u16 = minutes.parse().ok()?;
    (hours < 24 && minutes < 60).then_some(hours * 60 + minutes)
}

#[allow(dead_code)]
fn invalid_backup_name() -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    format!("settings-invalid-{stamp}.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_dynamic_contiguous_lesson_times() {
        assert_eq!(
            normalize_lesson_times(default_lesson_times())
                .unwrap()
                .len(),
            10
        );
        assert_eq!(
            normalize_lesson_times(default_lesson_times().into_iter().take(6).collect())
                .unwrap()
                .len(),
            6
        );
    }

    #[test]
    fn rejects_empty_missing_or_reversed_lesson_times() {
        assert!(normalize_lesson_times(vec![]).is_err());

        let mut missing = default_lesson_times();
        missing.remove(4);
        assert!(normalize_lesson_times(missing).is_err());

        let mut reversed = default_lesson_times();
        reversed[0].end = "07:59".into();
        assert!(normalize_lesson_times(reversed).is_err());
    }

    #[test]
    fn rejects_out_of_range_clock_values() {
        let mut invalid_minutes = default_lesson_times();
        invalid_minutes[0].start = "08:60".into();
        assert!(normalize_lesson_times(invalid_minutes).is_err());

        let mut invalid_hours = default_lesson_times();
        invalid_hours[0].start = "24:00".into();
        assert!(normalize_lesson_times(invalid_hours).is_err());
    }

    #[test]
    fn serialized_settings_round_trip_before_replacement() {
        let settings = default_settings(true);
        let bytes = serialize_settings(&settings).unwrap();
        assert_eq!(read_from_bytes(&bytes).unwrap(), settings);
    }
}
