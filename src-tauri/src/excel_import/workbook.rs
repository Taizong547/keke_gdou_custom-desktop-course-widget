use super::{
    parser::parse_cell,
    types::{AuditEntry, ParseAudit, ParsedCourseEntry, ParsedWorkbook, SectionTime},
};
use calamine::{open_workbook_auto, Data, Reader};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, path::Path};

const MAX_LESSON_TIMES: usize = 24;

#[derive(Clone, Copy)]
struct Grid {
    header_row: usize,
    first_row: usize,
    last_row: usize,
    first_column: usize,
    last_column: usize,
    section_column: usize,
}

#[derive(Clone)]
struct SourcedEntry {
    entry: ParsedCourseEntry,
    worksheet_index: usize,
    row: usize,
    column: usize,
}

pub fn parse_xlsx(path: &Path) -> Result<ParsedWorkbook, String> {
    let (entries, warnings, lesson_times, _) = constrained_entries(path)?;
    let entries = deduplicate(entries);
    if entries.is_empty() {
        return Err("未识别到已排课程".into());
    }
    Ok(ParsedWorkbook {
        detected_term_text: None,
        scheduled_entries: entries.into_iter().map(|item| item.entry).collect(),
        warnings,
        lesson_times,
    })
}

/// Produces privacy-safe, aggregate parser diagnostics.  The returned entries
/// carry coordinates and fingerprints only; never raw workbook text.
pub fn audit_xlsx(path: &Path) -> Result<ParseAudit, String> {
    let (constrained, _, _, worksheet_count) = constrained_entries(path)?;
    let legacy = legacy_entries(path)?;
    let successful_parses = constrained.len();
    let final_entries = deduplicate(constrained);
    let allowed_sources = final_entries
        .iter()
        .map(source_coordinate)
        .collect::<HashSet<_>>();
    let outside_schedule_grid = legacy
        .iter()
        .filter(|item| !allowed_sources.contains(&source_coordinate(item)))
        .count();
    let exact_duplicates = legacy
        .len()
        .saturating_sub(deduplicate(legacy.clone()).len());

    Ok(ParseAudit {
        worksheet_count,
        original_candidates: legacy.len(),
        successful_parses,
        exact_duplicates,
        outside_schedule_grid,
        final_valid_entries: final_entries.len(),
        legacy_candidates: legacy.iter().map(to_audit_entry).collect(),
        entries: final_entries.iter().map(to_audit_entry).collect(),
    })
}

pub fn workbook_sheet_count(path: &Path) -> Result<usize, String> {
    ensure_xlsx(path)?;
    let workbook =
        open_workbook_auto(path).map_err(|error| format!("无法打开 Excel 工作簿：{error}"))?;
    Ok(workbook.sheet_names().len())
}

fn constrained_entries(
    path: &Path,
) -> Result<(Vec<SourcedEntry>, Vec<String>, Option<Vec<SectionTime>>, usize), String> {
    ensure_xlsx(path)?;
    let mut workbook = open_workbook_auto(path).map_err(|_| "无法打开 XLSX 文件".to_owned())?;
    let sheet_names = workbook.sheet_names().to_owned();
    let mut entries = Vec::new();
    let mut warnings = Vec::new();
    let mut detected_lesson_times: Option<Vec<SectionTime>> = None;

    for (worksheet_index, sheet_name) in sheet_names.iter().enumerate() {
        let range = workbook
            .worksheet_range(sheet_name)
            .map_err(|_| "无法读取课表工作表".to_owned())?;
        let rows = range.rows().collect::<Vec<_>>();
        let mut accepted_grid_signatures = HashSet::new();

        for grid in find_grids(&rows) {
            let grid_entries = scan_grid(&rows, grid, worksheet_index, &mut warnings);
            if grid_entries.is_empty() {
                continue;
            }
            let signature = grid_entries.iter().map(arrangement_key).collect::<Vec<_>>();
            if accepted_grid_signatures.insert(signature) {
                entries.extend(grid_entries);
            }
        }

        if detected_lesson_times.is_none() {
            detected_lesson_times = find_lesson_times(&rows);
        }
    }

    Ok((entries, warnings, detected_lesson_times, sheet_names.len()))
}

/// 定位侧表作息时间（表头含"作息"或"节次/开始/结束"；时间形如 HH:MM，节次为"第N节"或裸数字，从1连续）
fn find_lesson_times(rows: &[&[Data]]) -> Option<Vec<SectionTime>> {
    let mut anchor: Option<usize> = None;
    for (index, row) in rows.iter().enumerate() {
        let text = row
            .iter()
            .map(cell)
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase();
        if text.contains("作息")
            || (row.iter().any(|value| cell(value).contains("节次"))
                && row.iter().any(|value| cell(value).contains("开始"))
                && row.iter().any(|value| {
                    cell(value).contains("结束") || cell(value).contains("下课")
                }))
        {
            anchor = Some(index);
            break;
        }
    }
    let Some(anchor_row) = anchor else {
        return None;
    };

    let mut lesson_times = Vec::new();
    let mut consecutive_misses = 0;
    for row in rows.iter().skip(anchor_row + 1).take(60) {
        if lesson_times.len() >= MAX_LESSON_TIMES {
            break;
        }
        let values = row.iter().map(cell).collect::<Vec<_>>();
        let expected_section = (lesson_times.len() + 1) as u8;
        match parse_lesson_time_row(&values, expected_section) {
            Some(time) => {
                consecutive_misses = 0;
                lesson_times.push(time);
            }
            None if lesson_times.is_empty() => {
                // Skip stray header-like rows (e.g. "节次 开始 结束" itself).
            }
            None => {
                consecutive_misses += 1;
                if consecutive_misses >= 3 {
                    break;
                }
            }
        }
    }

    if lesson_times.is_empty() {
        return None;
    }
    lesson_times.sort_by_key(|item| item.section);
    for (index, item) in lesson_times.iter().enumerate() {
        let expected = (index + 1) as u8;
        if item.section != expected || !is_clock(&item.start) || !is_clock(&item.end) {
            return None;
        }
        let start_minutes = time_to_minutes(&item.start)?;
        let end_minutes = time_to_minutes(&item.end)?;
        if end_minutes <= start_minutes {
            return None;
        }
    }
    Some(lesson_times)
}

fn parse_lesson_time_row(values: &[&str], expected_section: u8) -> Option<SectionTime> {
    let clock_cells = values
        .iter()
        .filter(|value| is_clock(value))
        .map(|value| *value)
        .collect::<Vec<_>>();
    let (section, start, end) = match clock_cells.as_slice() {
        [start, end] => {
            // The section label usually sits right next to the start clock
            // cell (left, or right after the end clock). Prefer it so a grid
            // section label in the same physical row ("第2节") is not picked
            // over the lesson-time table's own label ("第1节").
            let section = lesson_section_number_for_row(values)
                .unwrap_or(expected_section);
            (section, start, end)
        }
        [section_text, start, end] => {
            let section = lesson_section_number(section_text)?;
            (section, start, end)
        }
        _ => return None,
    };
    let start_minutes = time_to_minutes(start)?;
    let end_minutes = time_to_minutes(end)?;
    if section == 0 || start_minutes >= end_minutes {
        return None;
    }
    Some(SectionTime {
        section,
        start: start.to_string(),
        end: end.to_string(),
    })
}

/// Finds the section label belonging to the lesson-time row, preferring cells
/// adjacent to the clock pair and only falling back to a whole-row scan.
fn lesson_section_number_for_row(values: &[&str]) -> Option<u8> {
    let start_index = values.iter().position(|value| is_clock(value))?;
    if start_index > 0 {
        if let Some(section) = lesson_section_number(values[start_index - 1]) {
            return Some(section);
        }
    }
    if let Some(next) = values.get(start_index + 2) {
        if let Some(section) = lesson_section_number(next) {
            return Some(section);
        }
    }
    values
        .iter()
        .find_map(|value| lesson_section_number(value))
}

fn lesson_section_number(value: &str) -> Option<u8> {
    // Prefer the explicit "第N节" form so "第1节-第2节" reads as 1, not 12.
    static SECTION_PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    if let Some(captures) = SECTION_PATTERN
        .get_or_init(|| regex::Regex::new(r"第(\d{1,2})节").expect("valid section regex"))
        .captures(value)
    {
        if let Some(matched) = captures.get(1) {
            if let Ok(section) = matched.as_str().parse::<u16>() {
                if section > 0 && section <= MAX_LESSON_TIMES as u16 {
                    return Some(section as u8);
                }
            }
        }
    }
    // Fallback: a bare number cell (e.g. "1", "3").
    let trimmed = value.trim();
    if !trimmed.is_empty()
        && trimmed.chars().all(|character| character.is_ascii_digit())
    {
        if let Ok(section) = trimmed.parse::<u16>() {
            if section > 0 && section <= MAX_LESSON_TIMES as u16 {
                return Some(section as u8);
            }
        }
    }
    None
}

/// Parses `HH:MM` into minutes since midnight; `None` when malformed.
fn time_to_minutes(value: &str) -> Option<u32> {
    let (hour, minute) = value.split_once(':')?;
    let hour: u32 = hour.parse().ok()?;
    let minute: u32 = minute.parse().ok()?;
    Some(hour * 60 + minute)
}

fn is_clock(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 5
        && bytes[2] == b':'
        && bytes[0].is_ascii_digit()
        && bytes[1].is_ascii_digit()
        && bytes[3].is_ascii_digit()
        && bytes[4].is_ascii_digit()
}

/// 仅供本地审计对比使用，不参与生产解析
fn legacy_entries(path: &Path) -> Result<Vec<SourcedEntry>, String> {
    ensure_xlsx(path)?;
    let mut workbook = open_workbook_auto(path).map_err(|_| "无法打开 XLSX 文件".to_owned())?;
    let sheet_names = workbook.sheet_names().to_owned();
    let mut entries = Vec::new();
    for (worksheet_index, sheet_name) in sheet_names.iter().enumerate() {
        let range = workbook
            .worksheet_range(sheet_name)
            .map_err(|_| "无法读取课表工作表".to_owned())?;
        let rows = range.rows().collect::<Vec<_>>();
        for (header_row, row) in rows.iter().enumerate() {
            let days = legacy_weekday_columns(row);
            if days.is_empty() {
                continue;
            }
            for source_row in header_row + 1..rows.len() {
                let sections = section(rows[source_row].first().map(cell).unwrap_or(""));
                if sections.is_none() && source_row > header_row + 40 {
                    break;
                }
                for (column, weekday) in &days {
                    let value = rows[source_row].get(*column).map(cell).unwrap_or("");
                    if let Ok(parsed) = parse_cell(value, *weekday, sections) {
                        // 与历史解析行为保持一致，便于审计对比
                        entries.extend(parsed.into_iter().take(1).map(|entry| SourcedEntry {
                            entry,
                            worksheet_index,
                            row: source_row + 1,
                            column: column + 1,
                        }));
                    }
                }
            }
        }
    }
    Ok(entries)
}

fn find_grids(rows: &[&[Data]]) -> Vec<Grid> {
    let mut grids = Vec::new();
    for (header_row, row) in rows.iter().enumerate() {
        let days = weekday_columns(row);
        if days.len() < 5 {
            continue;
        }
        let first_column = days.first().map(|(column, _)| *column).unwrap_or(0);
        let last_column = days.last().map(|(column, _)| *column).unwrap_or(0);
        let Some(section_column) = find_section_column(rows, header_row, first_column) else {
            continue;
        };
        let Some((first_row, last_row)) = section_row_span(rows, header_row, section_column) else {
            continue;
        };
        grids.push(Grid {
            header_row,
            first_row,
            last_row,
            first_column,
            last_column,
            section_column,
        });
    }
    grids
}

fn find_section_column(
    rows: &[&[Data]],
    header_row: usize,
    first_day_column: usize,
) -> Option<usize> {
    (0..first_day_column)
        .map(|column| {
            let score = rows
                .iter()
                .skip(header_row + 1)
                .take(30)
                .filter(|row| section(row.get(column).map(cell).unwrap_or("")).is_some())
                .count();
            (column, score)
        })
        .max_by_key(|(_, score)| *score)
        .filter(|(_, score)| *score >= 2)
        .map(|(column, _)| column)
}

fn section_row_span(
    rows: &[&[Data]],
    header_row: usize,
    section_column: usize,
) -> Option<(usize, usize)> {
    let mut first = None;
    let mut last = None;
    let mut gaps = 0;
    for row_index in header_row + 1..rows.len().min(header_row + 31) {
        if section(rows[row_index].get(section_column).map(cell).unwrap_or("")).is_some() {
            first.get_or_insert(row_index);
            last = Some(row_index);
            gaps = 0;
        } else if first.is_some() {
            gaps += 1;
            // Exporters commonly use vertically merged course cells. Their
            // section labels can therefore be separated by several physical
            // rows; eight empty rows ends the grid without reaching a later
            // notes/list area.
            if gaps >= 8 {
                break;
            }
        }
    }
    first.zip(last)
}

fn scan_grid(
    rows: &[&[Data]],
    grid: Grid,
    worksheet_index: usize,
    warnings: &mut Vec<String>,
) -> Vec<SourcedEntry> {
    let days = weekday_columns(rows[grid.header_row]);
    let mut entries = Vec::new();
    for row_index in grid.first_row..=grid.last_row {
        let Some(sections) = section(
            rows[row_index]
                .get(grid.section_column)
                .map(cell)
                .unwrap_or(""),
        ) else {
            continue;
        };
        for (column, weekday) in days
            .iter()
            .filter(|(column, _)| *column >= grid.first_column && *column <= grid.last_column)
        {
            let value = rows[row_index].get(*column).map(cell).unwrap_or("");
            match parse_cell(value, *weekday, Some(sections)) {
                Ok(parsed) => entries.extend(parsed.into_iter().map(|entry| SourcedEntry {
                    entry,
                    worksheet_index,
                    row: row_index + 1,
                    column: column + 1,
                })),
                Err(_) if !value.trim().is_empty() => {
                    warnings.push(format!("课表网格安排 {} 无法可靠解析", warnings.len() + 1))
                }
                Err(_) => {}
            }
        }
    }
    entries
}

fn deduplicate(entries: Vec<SourcedEntry>) -> Vec<SourcedEntry> {
    let mut seen = HashSet::new();
    entries
        .into_iter()
        .filter(|item| seen.insert(arrangement_key(item)))
        .collect()
}

fn arrangement_key(item: &SourcedEntry) -> String {
    let entry = &item.entry;
    format!(
        "{}|{}|{}|{}|{:?}|{}|{}",
        normalized(entry.code.as_deref().unwrap_or(&entry.name)),
        entry.weekday,
        entry.start_section,
        entry.end_section,
        entry.weeks,
        entry.parity,
        normalized(entry.location.as_deref().unwrap_or("")),
    )
}

fn source_coordinate(item: &SourcedEntry) -> (usize, usize, usize) {
    (item.worksheet_index, item.row, item.column)
}

fn to_audit_entry(item: &SourcedEntry) -> AuditEntry {
    let entry = &item.entry;
    AuditEntry {
        worksheet_index: item.worksheet_index,
        row: item.row,
        column: item.column,
        weekday: entry.weekday,
        start_section: entry.start_section,
        end_section: entry.end_section,
        weeks: entry.weeks.clone(),
        parity: entry.parity.clone(),
        location_is_empty: entry.location.as_deref().unwrap_or("").is_empty(),
        location_fingerprint: short_hash(&normalized(entry.location.as_deref().unwrap_or(""))),
        course_fingerprint: short_hash(&normalized(entry.name.as_str())),
    }
}

fn weekday_columns(row: &[Data]) -> Vec<(usize, u8)> {
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    for (column, value) in row.iter().enumerate() {
        if let Some(day) = weekday(cell(value)) {
            if seen.insert(day) {
                found.push((column, day));
            }
        }
    }
    found
}

fn legacy_weekday_columns(row: &[Data]) -> Vec<(usize, u8)> {
    row.iter()
        .enumerate()
        .filter_map(|(column, value)| legacy_weekday(cell(value)).map(|day| (column, day)))
        .collect()
}

fn cell(value: &Data) -> &str {
    match value {
        Data::String(value) => value,
        Data::Empty => "",
        _ => "",
    }
}

fn weekday(value: &str) -> Option<u8> {
    if !value.contains("星期") {
        return None;
    }
    [
        ("一", 1),
        ("二", 2),
        ("三", 3),
        ("四", 4),
        ("五", 5),
        ("六", 6),
        ("日", 7),
        ("天", 7),
    ]
    .iter()
    .find_map(|(needle, day)| value.contains(needle).then_some(*day))
}

fn legacy_weekday(value: &str) -> Option<u8> {
    [
        ("一", 1),
        ("二", 2),
        ("三", 3),
        ("四", 4),
        ("五", 5),
        ("六", 6),
        ("日", 7),
        ("天", 7),
    ]
    .iter()
    .find_map(|(needle, day)| value.contains(needle).then_some(*day))
}

fn section(value: &str) -> Option<(u8, u8)> {
    let numbers = value
        .split(|character: char| !character.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<u8>().ok())
        .collect::<Vec<_>>();
    match numbers.as_slice() {
        [single] if *single > 0 => Some((*single, *single)),
        [start, end, ..] if *start > 0 && *end >= *start => Some((*start, *end)),
        _ => None,
    }
}

fn normalized(value: &str) -> String {
    value.split_whitespace().collect::<String>().to_lowercase()
}

fn short_hash(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn ensure_xlsx(path: &Path) -> Result<(), String> {
    if path.extension().and_then(|extension| extension.to_str()) == Some("xlsx") {
        Ok(())
    } else {
        Err("当前版本仅支持 .xlsx 文件".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sourced(weekday: u8, weeks: Vec<u8>) -> SourcedEntry {
        SourcedEntry {
            entry: ParsedCourseEntry {
                code: Some("C001".into()),
                name: "Anonymous course".into(),
                weekday,
                start_section: 1,
                end_section: 2,
                weeks,
                parity: "all".into(),
                location: Some("Building A101".into()),
            },
            worksheet_index: 0,
            row: 1,
            column: 1,
        }
    }

    #[test]
    fn deduplicates_only_identical_arrangements() {
        let same = sourced(1, vec![1, 2]);
        let different_weeks = sourced(1, vec![3, 4]);
        let different_day = sourced(2, vec![1, 2]);
        assert_eq!(
            deduplicate(vec![same.clone(), same, different_weeks, different_day]).len(),
            3
        );
    }

    #[test]
    fn finds_lesson_time_table_after_作息_header() {
        let rows = vec![
            vec![Data::Empty, Data::Empty],
            vec![
                Data::String("作息时间".into()),
                Data::Empty,
                Data::Empty,
            ],
            vec![
                Data::String("节次".into()),
                Data::String("开始".into()),
                Data::String("结束".into()),
            ],
            vec![
                Data::String("第1节".into()),
                Data::String("08:00".into()),
                Data::String("08:45".into()),
            ],
            vec![
                Data::String("第2节".into()),
                Data::String("08:55".into()),
                Data::String("09:40".into()),
            ],
            vec![
                Data::String("第3节".into()),
                Data::String("10:00".into()),
                Data::String("10:45".into()),
            ],
        ];
        let borrowed = rows.iter().map(Vec::as_slice).collect::<Vec<_>>();
        let times = find_lesson_times(&borrowed).expect("lesson times detected");
        assert_eq!(times.len(), 3);
        assert_eq!(times[0].section, 1);
        assert_eq!(times[0].start, "08:00");
        assert_eq!(times[0].end, "08:45");
        assert_eq!(times[2].section, 3);
        assert_eq!(times[2].end, "10:45");
    }

    #[test]
    fn compares_clock_strings_by_minutes_not_lexicographic_order() {
        // "10:05" < "09:20" lexicographically but later in time: the pair must
        // be accepted because 10:05 > 09:20 numerically.
        let rows = vec![
            vec![
                Data::String("作息时间".into()),
                Data::Empty,
                Data::Empty,
            ],
            vec![
                Data::String("第1节".into()),
                Data::String("08:30".into()),
                Data::String("09:15".into()),
            ],
            vec![
                Data::String("第2节".into()),
                Data::String("09:20".into()),
                Data::String("10:05".into()),
            ],
            vec![
                Data::String("第3节".into()),
                Data::String("10:25".into()),
                Data::String("11:10".into()),
            ],
        ];
        let borrowed = rows.iter().map(Vec::as_slice).collect::<Vec<_>>();
        let times = find_lesson_times(&borrowed).expect("lesson times detected");
        assert_eq!(times.len(), 3);
        assert_eq!(times[1].section, 2);
        assert_eq!(times[1].start, "09:20");
        assert_eq!(times[1].end, "10:05");
    }

    #[test]
    fn ignores_lesson_times_with_invalid_rows() {
        // Trailing noise after the last valid row (a malformed row followed by
        // blank rows) is tolerated: the valid prefix is still returned.
        let rows = vec![
            vec![
                Data::String("作息时间".into()),
                Data::Empty,
                Data::Empty,
            ],
            vec![
                Data::String("第1节".into()),
                Data::String("08:00".into()),
                Data::String("08:45".into()),
            ],
            // Reversed clocks: skipped, then two blank rows push the miss count
            // to three and stop the scan.
            vec![
                Data::String("第2节".into()),
                Data::String("09:40".into()),
                Data::String("08:55".into()),
            ],
            vec![Data::Empty, Data::Empty, Data::Empty],
            vec![Data::Empty, Data::Empty, Data::Empty],
        ];
        let borrowed = rows.iter().map(Vec::as_slice).collect::<Vec<_>>();
        let times = find_lesson_times(&borrowed).expect("valid rows still detected");
        assert_eq!(times.len(), 1);
        assert_eq!(times[0].section, 1);
        assert_eq!(times[0].start, "08:00");
        assert_eq!(times[0].end, "08:45");
    }

    #[test]
    fn rejects_lesson_times_when_every_data_row_is_invalid() {
        // If three consecutive rows fail to parse, the whole table is rejected
        // so a foreign grid can never masquerade as a lesson-time table.
        let rows = vec![
            vec![
                Data::String("作息时间".into()),
                Data::Empty,
                Data::Empty,
            ],
            vec![
                Data::String("第1节".into()),
                Data::String("09:40".into()),
                Data::String("08:55".into()),
            ],
            vec![
                Data::String("第2节".into()),
                Data::String("10:45".into()),
                Data::String("10:00".into()),
            ],
            vec![
                Data::String("第3节".into()),
                Data::String("11:45".into()),
                Data::String("11:00".into()),
            ],
        ];
        let borrowed = rows.iter().map(Vec::as_slice).collect::<Vec<_>>();
        assert!(find_lesson_times(&borrowed).is_none());
    }

    #[test]
    fn bare_number_section_cells_are_accepted() {
        let rows = vec![
            vec![
                Data::String("作息时间".into()),
                Data::Empty,
                Data::Empty,
            ],
            vec![
                Data::String("1".into()),
                Data::String("08:00".into()),
                Data::String("08:45".into()),
            ],
            vec![
                Data::String("2".into()),
                Data::String("08:55".into()),
                Data::String("09:40".into()),
            ],
        ];
        let borrowed = rows.iter().map(Vec::as_slice).collect::<Vec<_>>();
        let times = find_lesson_times(&borrowed).expect("lesson times detected");
        assert_eq!(times.len(), 2);
        assert_eq!(times[1].section, 2);
    }

    #[test]
    fn grid_detection_requires_a_full_weekday_header() {
        let rows = vec![
            vec![Data::String("notes 星期1".into())],
            vec![
                Data::String("节次".into()),
                Data::String("星期一".into()),
                Data::String("星期二".into()),
                Data::String("星期三".into()),
                Data::String("星期四".into()),
                Data::String("星期五".into()),
            ],
            vec![
                Data::String("第1节-第2节".into()),
                Data::Empty,
                Data::Empty,
                Data::Empty,
                Data::Empty,
                Data::Empty,
            ],
            vec![
                Data::String("第3节-第4节".into()),
                Data::Empty,
                Data::Empty,
                Data::Empty,
                Data::Empty,
                Data::Empty,
            ],
        ];
        let borrowed = rows.iter().map(Vec::as_slice).collect::<Vec<_>>();
        let grids = find_grids(&borrowed);
        assert_eq!(grids.len(), 1);
        assert_eq!(grids[0].header_row, 1);
    }
}
