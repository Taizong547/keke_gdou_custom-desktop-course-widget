import { getVersion } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { ImportCourse, ImportDraft } from './import-draft'
import { parseWeeksText, refreshImportDraftSummary, validateImportCourse, validateImportDraft, weeksToText } from './import-review'
import { requestSettingsWindowClose } from './window-close-behavior'
import { choosePdfFile } from './pdf-import'
import {
  defaultSpecialScheduleRules,
  matchSpecialRule,
  type SpecialScheduleRule,
} from './special-times'
import scheduleData from './data/schedule.json'
import './settings.css'

type Parity = 'all' | 'odd' | 'even'
type Surface = 'course' | 'schedule' | 'import' | 'times' | 'special' | 'appearance' | 'data' | 'help' | 'about' | null

type LessonTime = {
  section: number
  start: string
  end: string
}

type WidgetTheme = 'light' | 'dark'
type WidgetBackground = 'blue' | 'light' | 'dark' | 'colorful'

type AppSettings = {
  schemaVersion: number
  onboardingCompleted: boolean
  lessonTimes: LessonTime[]
  equalDuration: boolean
  widgetOpacity: number
  ballMode: boolean
  widgetTheme: WidgetTheme
  widgetBackground: WidgetBackground
  widgetRadius: number
  widgetFontScale: number
  appFontScale: number
  specialScheduleRules: SpecialScheduleRule[]
}

type CatalogCourse = {
  id: string
  name: string
  color: string
  teacher: string
  weekday: number
  start: string
  end: string
  location: string
  weeks: number[]
  parity: Parity
}

type CatalogSchedule = {
  id: string
  name: string
  semesterStart: string
  semesterEnd?: string | null
  courses: CatalogCourse[]
}

type ScheduleSummary = {
  id: string
  name: string
  semesterStart: string
  semesterEnd?: string | null
  courseCount: number
  active: boolean
}

type DraftSlot = {
  key: string
  weekday: number
  startSection: number
  endSection: number
  startWeek: number
  endWeek: number
  parity: Parity
  customWeeks: boolean
  selectedWeeks: number[]
  location: string
  teacher: string
}

type CourseDraft = {
  courseId?: string
  name: string
  color: string
  slots: DraftSlot[]
}

type ScheduleDraft = {
  id: string
  name: string
  semesterStart: string
  totalWeeks: number
  courseCount: number
  active: boolean
}

type SaveCourseRequest = {
  courseId?: string
  name: string
  color: string
  slots: Array<{
    weekday: number
    start: string
    end: string
    weeks: number[]
    parity: Parity
    location: string
    teacher: string
  }>
}

type PositionedCourse = {
  course: CatalogCourse
  startIndex: number
  endIndex: number
  lane: number
  laneCount: number
}

const desktopRuntime = '__TAURI_INTERNALS__' in window
const plugin = (command: string) => `plugin:schedule-catalog|${command}`
const weekdays = ['一', '二', '三', '四', '五', '六', '日']
const weekdayLabels = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const palette = ['#CFE1FF', '#D8EBCF', '#F8D8D2', '#E5D9F7', '#F9E3B7', '#CFE9E8', '#F2D6E6', '#D9E1F2', '#E4E7C9', '#F4DCC5']
const rowHeight = 66
const completeTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const defaultLessonTimes: LessonTime[] = [
  { section: 1, start: '08:10', end: '08:55' },
  { section: 2, start: '09:00', end: '09:45' },
  { section: 3, start: '10:15', end: '11:00' },
  { section: 4, start: '11:05', end: '11:50' },
  { section: 5, start: '14:30', end: '15:15' },
  { section: 6, start: '15:20', end: '16:05' },
  { section: 7, start: '16:30', end: '17:15' },
  { section: 8, start: '17:20', end: '18:05' },
  { section: 9, start: '19:30', end: '20:15' },
  { section: 10, start: '20:25', end: '21:10' },
]

const app = document.querySelector<HTMLDivElement>('#app')!

let schedule = browserSchedule()
let summaries: ScheduleSummary[] = [summaryFromSchedule(schedule, true)]
let settings: AppSettings = {
  schemaVersion: 1,
  onboardingCompleted: true,
  lessonTimes: structuredClone(defaultLessonTimes),
  equalDuration: false,
  widgetOpacity: 1,
  ballMode: true,
  widgetTheme: 'dark',
  widgetBackground: 'dark',
  widgetRadius: 22,
  widgetFontScale: 1,
  appFontScale: 1,
  specialScheduleRules: structuredClone(defaultSpecialScheduleRules),
}
let currentWeek = initialWeek(schedule)
let surface: Surface = null
let menuOpen = false
let scheduleMenuOpen = false
let selectedCourseId: string | null = null
let courseDraft: CourseDraft | null = null
let initialDraftSnapshot = ''
let scheduleDraft: ScheduleDraft | null = null
let initialScheduleDraftSnapshot = ''
let importDraft: ImportDraft | null = null
let importNameDraft = ''
let importFirstWeekDraft = ''
let expandedImportCourseIndex = 0
let importRequestId = ''
let importCreatePending = false
let surfaceMessage = ''
let applicationVersion = desktopRuntime ? '' : '浏览器预览'
let autostartEnabled = false
let timeDraft = structuredClone(settings.lessonTimes)
let timeEqualDuration = settings.equalDuration
let specialDraftOpen = false
let specialEditIndex: number | null = null
let specialDraft: SpecialScheduleRule | null = null
let confirmRequest: { message: string; onConfirm: () => void } | null = null

const SPECIAL_COLORS = [
  '#3a5a78', '#5b7c99', '#7d9a8f', '#9aab9b', '#c2a68c', '#b58e8e', '#8f82b5', '#6f8fa8',
  '#5e7d8c', '#8fb8aa', '#c4b7a3', '#d4b0a8', '#a5b3c2', '#7c8fa6', '#4f6f7f', '#101826',
  '#4a7fb5', '#2f9e8f', '#34a26a', '#d9893a', '#c96a5a', '#b3568a', '#7a5cc0', '#3aa0c9',
  '#5cb87f', '#e0a83f', '#e2708a', '#8a6fd0', '#58b2a0', '#d0894f', '#a08bd4', '#6a97d0',
]

function defaultRuleColor(): string {
  const used = settings.specialScheduleRules.map((rule) => rule.color)
  for (const color of SPECIAL_COLORS) {
    if (color === '#101826') continue
    if (!used.includes(color)) return color
  }
  return SPECIAL_COLORS[1]
}

function browserSchedule(): CatalogSchedule {
  const source = scheduleData as {
    semesterStart: string
    semesterEnd?: string
    courses: Array<Omit<CatalogCourse, 'id' | 'color'>>
  }
  const ids = new Map<string, string>()
  return {
    id: 'browser-sample',
    name: '示例课表',
    semesterStart: source.semesterStart,
    semesterEnd: source.semesterEnd,
    courses: source.courses.map((course, index) => {
      const key = course.name.trim()
      const id = ids.get(key) ?? `sample-course-${ids.size + 1}`
      ids.set(key, id)
      return { ...course, id, color: palette[index % palette.length] }
    }),
  }
}

function summaryFromSchedule(value: CatalogSchedule, active: boolean): ScheduleSummary {
  return {
    id: value.id,
    name: value.name,
    semesterStart: value.semesterStart,
    semesterEnd: value.semesterEnd,
    courseCount: new Set(value.courses.map((course) => course.id)).size,
    active,
  }
}

function parseLocalDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function addDays(value: Date, days: number): Date {
  const result = new Date(value.getFullYear(), value.getMonth(), value.getDate())
  result.setDate(result.getDate() + days)
  return result
}

function dateKey(value: Date): string {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function initialWeek(value: CatalogSchedule): number {
  const start = parseLocalDate(value.semesterStart)
  const now = new Date()
  const week = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - start.getTime()) / 604_800_000) + 1
  return clamp(week, 1, maximumWeek(value))
}

function courseMaximumWeek(value: CatalogSchedule): number {
  return Math.max(1, ...value.courses.flatMap((course) => course.weeks))
}

function calendarWeekCount(semesterStart: string, semesterEnd?: string | null): number | null {
  if (!semesterEnd) return null
  const start = parseLocalDate(semesterStart)
  const end = parseLocalDate(semesterEnd)
  const days = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1
  if (!Number.isFinite(days) || days <= 0) return null
  return clamp(Math.ceil(days / 7), 1, 30)
}

function maximumWeek(value: CatalogSchedule): number {
  return Math.max(courseMaximumWeek(value), calendarWeekCount(value.semesterStart, value.semesterEnd) ?? 1)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function isValidClockTime(value: string): boolean {
  return completeTimePattern.test(value)
}

function timeToMinutes(value: string): number {
  if (!isValidClockTime(value)) return Number.NaN
  const [hours, minutes] = value.split(':').map(Number)
  return hours * 60 + minutes
}

function lessonIndexForStart(value: string): number {
  const exact = settings.lessonTimes.findIndex((item) => item.start === value)
  if (exact >= 0) return exact
  const target = timeToMinutes(value)
  const next = settings.lessonTimes.findIndex((item) => timeToMinutes(item.start) >= target)
  return next >= 0 ? next : settings.lessonTimes.length - 1
}

function lessonIndexForEnd(value: string): number {
  const exact = settings.lessonTimes.findIndex((item) => item.end === value)
  if (exact >= 0) return exact
  const target = timeToMinutes(value)
  // 找第一个 end >= target 的节次（课程结束时间落在该节内）
  const next = settings.lessonTimes.findIndex((item) => timeToMinutes(item.end) >= target)
  return next >= 0 ? next : settings.lessonTimes.length - 1
}

function weekDates(): Date[] {
  const start = addDays(parseLocalDate(schedule.semesterStart), (currentWeek - 1) * 7)
  return Array.from({ length: 7 }, (_, index) => addDays(start, index))
}

function isCourseVisible(course: CatalogCourse): boolean {
  if (!course.weeks.includes(currentWeek)) return false
  if (course.parity === 'odd' && currentWeek % 2 === 0) return false
  if (course.parity === 'even' && currentWeek % 2 === 1) return false
  return true
}

function positionCourses(courses: CatalogCourse[]): PositionedCourse[] {
  const source = courses
    .map((course) => {
      const startIndex = lessonIndexForStart(course.start)
      let endIndex = lessonIndexForEnd(course.end)
      // 一节课占两个时间段（单节课程扩展为两格）
      if (endIndex < startIndex + 1) {
        endIndex = Math.min(startIndex + 1, settings.lessonTimes.length - 1)
      }
      return { course, startIndex, endIndex }
    })
    .sort((left, right) => left.startIndex - right.startIndex || left.endIndex - right.endIndex)
  const result: PositionedCourse[] = []
  let cursor = 0

  while (cursor < source.length) {
    const cluster = [source[cursor]]
    let clusterEnd = source[cursor].endIndex
    let nextIndex = cursor + 1
    while (nextIndex < source.length && source[nextIndex].startIndex <= clusterEnd) {
      cluster.push(source[nextIndex])
      clusterEnd = Math.max(clusterEnd, source[nextIndex].endIndex)
      nextIndex += 1
    }

    const laneEnds: number[] = []
    const assigned = cluster.map((item) => {
      let lane = laneEnds.findIndex((end) => end < item.startIndex)
      if (lane < 0) lane = laneEnds.length
      laneEnds[lane] = item.endIndex
      return { ...item, lane }
    })
    const laneCount = Math.max(1, laneEnds.length)
    result.push(...assigned.map((item) => ({ ...item, laneCount })))
    cursor = nextIndex
  }

  return result
}

function render(): void {
  const surfaceScrollTop = document.querySelector('.surface-scroll')?.scrollTop ?? 0
  const scheduleScrollTop = document.querySelector('.schedule-scroll')?.scrollTop ?? 0
  app.innerHTML = `
    <main class="settings-app${surface ? ' has-surface' : ''}">
      <header class="schedule-toolbar">
        <div class="schedule-selector-wrap">
          <button
            class="schedule-selector"
            type="button"
            data-action="toggle-schedule-menu"
            aria-label="切换课表，当前为 ${escapeHtml(schedule.name)}"
            aria-expanded="${scheduleMenuOpen}"
          >
            <span class="schedule-selector-copy">
              <strong title="${escapeHtml(schedule.name)}">${escapeHtml(schedule.name)}</strong>
            </span>
            <span class="schedule-selector-chevron" aria-hidden="true"></span>
          </button>
          ${scheduleMenuOpen ? scheduleMenuMarkup() : ''}
        </div>
        <div class="week-switcher" aria-label="教学周切换">
          <button class="icon-button week-button" type="button" data-action="previous-week" aria-label="上一教学周">‹</button>
          <span class="week-label">第 ${currentWeek} 教学周</span>
          <button class="icon-button week-button" type="button" data-action="next-week" aria-label="下一教学周">›</button>
        </div>
        <div class="toolbar-actions">
          <button class="icon-button toolbar-button" type="button" data-action="add-course" aria-label="新增课程">＋</button>
          <button class="icon-button toolbar-button" type="button" data-action="toggle-menu" aria-label="更多设置" aria-expanded="${menuOpen}">⋯</button>
          ${menuOpen ? menuMarkup() : ''}
        </div>
      </header>
      <section class="schedule-stage">
        ${scheduleMarkup()}
        ${surface ? '<div class="schedule-dimmer" aria-hidden="true"></div>' : ''}
        ${surfaceMarkup()}
      </section>
      <div class="toast" id="toast" role="status" aria-live="polite"></div>
      ${confirmRequest ? `<div class="confirm-mask" role="dialog" aria-modal="true"><div class="confirm-dialog"><p class="confirm-text">${escapeHtml(confirmRequest.message)}</p><div class="confirm-actions"><button class="secondary-button" type="button" data-action="confirm-no">取消</button><button class="danger-button" type="button" data-action="confirm-yes">删除</button></div></div></div>` : ''}
    </main>
  `
  bindEvents()
  requestAnimationFrame(() => {
    const surface = document.querySelector('.surface-scroll')
    if (surface) surface.scrollTop = surfaceScrollTop
    const schedule = document.querySelector('.schedule-scroll')
    if (schedule) schedule.scrollTop = scheduleScrollTop
  })
}

function menuMarkup(): string {
  return `
    <div class="more-menu" role="menu">
      <button type="button" role="menuitem" data-open-surface="times"><span>作息时间</span></button>
      <button type="button" role="menuitem" data-open-surface="special"><span>特殊标注</span></button>
      <button type="button" role="menuitem" data-open-surface="appearance"><span>组件外观</span></button>
      <div class="menu-separator"></div>
      <button type="button" role="menuitemcheckbox" aria-checked="${autostartEnabled}" data-action="toggle-autostart">
        <span>开机启动</span><span class="menu-check">${autostartEnabled ? '✓' : ''}</span>
      </button>
      <div class="menu-separator"></div>
      <button type="button" role="menuitem" data-open-surface="help"><span>使用帮助</span></button>
      <button type="button" role="menuitem" data-open-surface="about"><span>关于</span></button>
    </div>
  `
}

function scheduleMenuMarkup(): string {
  const items = summaries.map((item) => `
    <button
      class="schedule-menu-item${item.active ? ' is-active' : ''}"
      type="button"
      role="menuitemradio"
      aria-checked="${item.active}"
      ${item.active ? 'data-action="close-schedule-menu"' : `data-activate-schedule="${escapeHtml(item.id)}"`}
    >
      <span class="schedule-menu-item-copy">
        <strong>${escapeHtml(item.name)}</strong>
        <span>${item.courseCount} 门课程 · ${escapeHtml(item.semesterStart)}</span>
      </span>
      <span class="schedule-menu-check">${item.active ? '✓' : ''}</span>
    </button>
  `).join('')
  return `
    <div class="schedule-menu" role="menu" aria-label="切换课表">
      <header><strong>切换课表</strong><span>${summaries.length} 份</span></header>
      <div class="schedule-menu-list">${items}</div>
      <div class="menu-separator"></div>
      <button class="schedule-menu-command" type="button" role="menuitem" data-open-surface="import">导入新课表</button>
      <button class="schedule-menu-command" type="button" role="menuitem" data-open-surface="data">管理课表与数据</button>
    </div>
  `
}

function scheduleMarkup(): string {
  const dates = weekDates()
  const today = dateKey(new Date())
  const month = dates[0].getMonth() + 1
  const bodyHeight = settings.lessonTimes.length * rowHeight
  const visible = schedule.courses.filter(isCourseVisible)

  const headers = dates.map((date, index) => {
    const current = dateKey(date) === today
    return `
      <div class="day-heading${current ? ' is-today' : ''}">
        <span>${weekdays[index]}</span>
        <strong>${date.getDate()}</strong>
      </div>
    `
  }).join('')

  const timeLabels = (() => {
    const labels: string[] = []
    const times = settings.lessonTimes
    for (let i = 0; i < times.length; i++) {
      const t = times[i]
      labels.push(`<div class="lesson-label" style="height:${rowHeight}px"><strong>${i + 1}</strong><span>${t.start}–${t.end}</span></div>`)
    }
    return labels.join('')
  })()

  const dayColumns = Array.from({ length: 7 }, (_, dayIndex) => {
    const dayCourses = visible.filter((course) => course.weekday === dayIndex + 1)
    const cards = positionCourses(dayCourses).map(({ course, startIndex, endIndex, lane, laneCount }) => {
      const height = (endIndex - startIndex + 1) * rowHeight - 6
      const top = startIndex * rowHeight + 3
      const width = 100 / laneCount
      const singleLesson = startIndex === endIndex
      const selected = selectedCourseId === course.id
      const lessonStart = settings.lessonTimes[startIndex]?.start ?? course.start
      const special = matchSpecialRule(settings.specialScheduleRules, course.location, lessonStart)
      return `
        <button
          class="course-card${selected ? ' is-selected' : ''}"
          type="button"
          data-course-id="${escapeHtml(course.id)}"
          style="--course-color:${escapeHtml(course.color)};top:${top}px;height:${height}px;left:calc(${lane * width}% + 3px);width:calc(${width}% - 6px)"
          aria-label="编辑 ${escapeHtml(course.name)}"
        >
          ${special ? `<span class="special-time" style="background:${escapeHtml(special.color)}">${special.actualStart}</span>` : ''}
          <strong>${escapeHtml(course.name.replace(/[*$#@~^&%!？?。.\s]+$/g, '').trim())}</strong>
          ${singleLesson || !course.location ? '' : `<span>${escapeHtml(course.location)}</span>`}
        </button>
      `
    }).join('')
    return `<div class="day-column" style="height:${bodyHeight}px">${cards}</div>`
  }).join('')

  const empty = visible.length === 0
    ? `<div class="week-empty">第 ${currentWeek} 教学周没有课程</div>`
    : ''

  return `
    <div class="schedule-scroll">
      <div class="schedule-head">
        <div class="month-heading"><strong>${month}</strong><span>月</span></div>
        ${headers}
      </div>
      <div class="schedule-body" style="--lesson-count:${settings.lessonTimes.length};--row-height:${rowHeight}px">
        <div class="lesson-column">${timeLabels}</div>
        ${dayColumns}
        ${empty}
      </div>
    </div>
  `
}

function surfaceMarkup(): string {
  if (!surface) return ''
  if (surface === 'course') return courseSurfaceMarkup()
  if (surface === 'schedule') return scheduleSurfaceMarkup()
  if (surface === 'import') return importSurfaceMarkup()
  if (surface === 'times') return timesSurfaceMarkup()
  if (surface === 'special') return specialSurfaceMarkup()
  if (surface === 'appearance') return appearanceSurfaceMarkup()
  if (surface === 'data') return dataSurfaceMarkup()
  if (surface === 'help') return helpSurfaceMarkup()
  return aboutSurfaceMarkup()
}

function surfaceShell(title: string, content: string, wide = false): string {
  return `
    <aside class="side-surface${wide ? ' side-surface--wide' : ''}" aria-label="${escapeHtml(title)}">
      <header class="surface-header">
        <h2>${escapeHtml(title)}</h2>
        <button class="icon-button surface-close" type="button" data-action="close-surface" aria-label="关闭">×</button>
      </header>
      ${content}
    </aside>
  `
}

function courseSurfaceMarkup(): string {
  if (!courseDraft) return ''
  const editing = Boolean(courseDraft.courseId)
  const maxWeek = Math.max(maximumWeek(schedule), 20)
  const slots = courseDraft.slots.map((slot, index) => slotMarkup(slot, index, maxWeek)).join('')
  return surfaceShell(editing ? '编辑课程' : '新增课程', `
    <div class="surface-scroll course-form">
      <label class="field field--full">
        <span>课程名称</span>
        <input id="course-name" value="${escapeHtml(courseDraft.name)}" maxlength="160" placeholder="输入课程名称" />
      </label>
      <fieldset class="color-field">
        <legend>课程颜色</legend>
        <div class="color-options">
          ${palette.map((color) => `<button class="color-swatch${courseDraft?.color === color ? ' is-active' : ''}" type="button" data-color="${color}" style="--swatch:${color}" aria-label="选择颜色 ${color}"></button>`).join('')}
        </div>
      </fieldset>
      <div class="section-heading">
        <div><h3>上课时间</h3><p>一门课程可以添加多个时间段。</p></div>
      </div>
      <div class="slot-list">${slots}</div>
      <button class="text-button add-slot" type="button" data-action="add-slot">＋ 添加时间段</button>
      <p class="surface-message" role="status">${escapeHtml(surfaceMessage)}</p>
    </div>
    <footer class="surface-actions">
      ${editing ? '<button class="danger-button" type="button" data-action="delete-course">删除课程</button>' : '<span></span>'}
      <div class="action-group">
        <button class="secondary-button" type="button" data-action="cancel-course">取消</button>
        <button class="primary-button" type="button" data-action="save-course">${editing ? '保存修改' : '保存课程'}</button>
      </div>
    </footer>
  `, true)
}

function slotMarkup(slot: DraftSlot, index: number, maxWeek: number): string {
  const lessonOptions = settings.lessonTimes.map((item) => `<option value="${item.section}">${item.section}</option>`).join('')
  const weekButtons = Array.from({ length: maxWeek }, (_, offset) => offset + 1).map((week) => `
    <button class="week-chip${slot.selectedWeeks.includes(week) ? ' is-selected' : ''}" type="button" data-slot-week="${slot.key}:${week}">${week}</button>
  `).join('')
  return `
    <section class="slot-card" data-slot-key="${slot.key}">
      <header>
        <strong>时间段 ${index + 1}</strong>
        ${courseDraft && courseDraft.slots.length > 1 ? `<button class="slot-remove" type="button" data-remove-slot="${slot.key}" aria-label="删除时间段 ${index + 1}">×</button>` : ''}
      </header>
      <div class="form-grid">
        <label class="field">
          <span>星期</span>
          <select data-slot-field="weekday" data-slot="${slot.key}">
            ${weekdayLabels.map((label, day) => `<option value="${day + 1}"${slot.weekday === day + 1 ? ' selected' : ''}>${label}</option>`).join('')}
          </select>
        </label>
        <div class="field section-range">
          <span>节次</span>
          <div>
            <select data-slot-field="startSection" data-slot="${slot.key}">${lessonOptions.replace(`value="${slot.startSection}"`, `value="${slot.startSection}" selected`)}</select>
            <span>至</span>
            <select data-slot-field="endSection" data-slot="${slot.key}">${lessonOptions.replace(`value="${slot.endSection}"`, `value="${slot.endSection}" selected`)}</select>
          </div>
        </div>
        <label class="field">
          <span>起始周</span>
          <input type="number" min="1" max="30" value="${slot.startWeek}" data-slot-field="startWeek" data-slot="${slot.key}" />
        </label>
        <label class="field">
          <span>结束周</span>
          <input type="number" min="1" max="30" value="${slot.endWeek}" data-slot-field="endWeek" data-slot="${slot.key}" />
        </label>
        <label class="field field--full">
          <span>重复</span>
          <select data-slot-field="parity" data-slot="${slot.key}">
            <option value="all"${slot.parity === 'all' ? ' selected' : ''}>每周</option>
            <option value="odd"${slot.parity === 'odd' ? ' selected' : ''}>单周</option>
            <option value="even"${slot.parity === 'even' ? ' selected' : ''}>双周</option>
          </select>
        </label>
        <label class="field field--full">
          <span>地点</span>
          <input value="${escapeHtml(slot.location)}" data-slot-field="location" data-slot="${slot.key}" placeholder="选填" maxlength="160" />
        </label>
        <label class="field field--full">
          <span>老师</span>
          <input value="${escapeHtml(slot.teacher)}" data-slot-field="teacher" data-slot="${slot.key}" placeholder="选填" maxlength="160" />
        </label>
      </div>
      <button class="custom-weeks-toggle" type="button" data-toggle-weeks="${slot.key}">${slot.customWeeks ? '收起自定义周次' : '展开自定义周次'}</button>
      ${slot.customWeeks ? `
        <div class="custom-weeks">
          <div class="week-chip-grid">${weekButtons}</div>
          <div class="custom-week-actions">
            <button type="button" data-week-action="all:${slot.key}">全选</button>
            <button type="button" data-week-action="clear:${slot.key}">清空</button>
          </div>
        </div>
      ` : ''}
    </section>
  `
}

function importCourseReviewMarkup(course: ImportCourse, index: number): string {
  const issues = validateImportCourse(course, settings.lessonTimes.length)
  const weekday = weekdayLabels[course.weekday - 1] ?? '星期待确认'
  const sectionText = course.startSection === course.endSection
    ? `第 ${course.startSection} 节`
    : `第 ${course.startSection}–${course.endSection} 节`
  const weekText = weeksToText(course.weeks)
  const lessonOptions = settings.lessonTimes.map((item) => `<option value="${item.section}">${item.section}</option>`).join('')
  const startOptions = lessonOptions.replace(`value="${course.startSection}"`, `value="${course.startSection}" selected`)
  const endOptions = lessonOptions.replace(`value="${course.endSection}"`, `value="${course.endSection}" selected`)
  return `
    <details class="import-course-review${issues.length ? ' has-issues' : ''}" data-import-course-details="${index}"${expandedImportCourseIndex === index ? ' open' : ''}>
      <summary>
        <span class="import-course-copy">
          <strong>${escapeHtml(course.name.trim() || `未命名课程 ${index + 1}`)}</strong>
          <small>${escapeHtml(`${weekday} · ${sectionText} · ${weekText || '周次待确认'}周`)}</small>
        </span>
        <span class="import-course-state">${issues.length ? `${issues.length} 项待确认` : '信息完整'}</span>
      </summary>
      <div class="import-course-review-grid">
        <label class="field field--full">
          <span>课程名称</span>
          <input value="${escapeHtml(course.name)}" maxlength="160" data-import-course="${index}" data-import-field="name" />
        </label>
        <label class="field">
          <span>星期</span>
          <select data-import-course="${index}" data-import-field="weekday">
            ${weekdayLabels.map((label, offset) => `<option value="${offset + 1}"${course.weekday === offset + 1 ? ' selected' : ''}>${label}</option>`).join('')}
          </select>
        </label>
        <label class="field">
          <span>重复</span>
          <select data-import-course="${index}" data-import-field="parity">
            <option value="all"${course.parity === 'all' ? ' selected' : ''}>每周</option>
            <option value="odd"${course.parity === 'odd' ? ' selected' : ''}>单周</option>
            <option value="even"${course.parity === 'even' ? ' selected' : ''}>双周</option>
          </select>
        </label>
        <label class="field">
          <span>开始节次</span>
          <select data-import-course="${index}" data-import-field="startSection">${startOptions}</select>
        </label>
        <label class="field">
          <span>结束节次</span>
          <select data-import-course="${index}" data-import-field="endSection">${endOptions}</select>
        </label>
        <label class="field field--full">
          <span>教学周</span>
          <input value="${escapeHtml(weekText)}" placeholder="例如 1-8, 10-16" data-import-course="${index}" data-import-field="weeks" />
        </label>
        <label class="field">
          <span>地点</span>
          <input value="${escapeHtml(course.location ?? '')}" maxlength="160" placeholder="选填" data-import-course="${index}" data-import-field="location" />
        </label>
        <label class="field">
          <span>老师</span>
          <input value="${escapeHtml(course.teacher ?? '')}" maxlength="160" placeholder="选填" data-import-course="${index}" data-import-field="teacher" />
        </label>
      </div>
      ${issues.length ? `<ul class="import-course-issues">${issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join('')}</ul>` : ''}
    </details>
  `
}

function importSurfaceMarkup(): string {
  const draft = importDraft
  const issueCount = draft
    ? draft.courses.reduce((total, course) => total + validateImportCourse(course, settings.lessonTimes.length).length, 0)
    : 0
  const reviewCards = draft?.courses.map(importCourseReviewMarkup).join('') ?? ''
  return surfaceShell('检查并导入课表', `
    <div class="surface-scroll simple-surface import-review-surface">
      <div class="surface-intro">
        <h3 class="import-step-title">1 · 选择文件</h3>
        <p>先逐项检查识别结果，再创建新课表；已有课表不会被覆盖。</p>
      </div>
      <button class="import-picker" type="button" data-action="choose-excel">
        <strong>${escapeHtml(draft?.sourceName ?? '选择一份 .xlsx 课表')}</strong>
        <span>${desktopRuntime ? '文件只在本机解析，不会上传' : '浏览器预览中不会读取本机文件'}</span>
      </button>
      <button class="import-picker import-picker--pdf" type="button" data-action="choose-pdf">
        <strong>选择 PDF 课表（识别）</strong>
        <span>PDF 会渲染成图片后识别，适合扫描版/截图版课表</span>
      </button>
      ${draft?.lessonTimes?.length ? `
        <div class="import-lesson-times-note">
          <strong>检测到作息时间（${draft.lessonTimes.length} 节）</strong>
          <p>第${draft.lessonTimes[0].section}～第${draft.lessonTimes[draft.lessonTimes.length - 1].section}节：${draft.lessonTimes.map((time) => `${time.start}–${time.end}`).join('、')}</p>
          <p>确认创建课表时会自动应用到桌面组件。</p>
        </div>
      ` : ''}
      ${draft ? `
        <div class="import-summary">
          <div><span>课程安排</span><strong>${draft.summary.arrangements} 项</strong></div>
          <div><span>最高教学周</span><strong>${draft.summary.highestWeek} 周</strong></div>
          <div><span>待确认</span><strong>${issueCount} 项</strong></div>
        </div>
        <div class="import-basics">
          <label class="field field--full"><span>课表名称</span><input id="import-name" value="${escapeHtml(importNameDraft || draft.suggestedName)}" /></label>
          <label class="field field--full"><span>第一周星期一</span><input id="import-first-week" type="date" value="${escapeHtml(importFirstWeekDraft || schedule.semesterStart)}" /></label>
        </div>
        ${draft.warnings.length ? `
          <section class="import-parser-warnings">
            <strong>解析提示</strong>
            <ul>${draft.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>
          </section>
        ` : ''}
        <div class="import-review-heading">
          <div><h3>2 · 检查解析结果</h3><p>展开课程可修改星期、节次、周次、地点和老师。</p></div>
          <span>${draft.courses.length} 项</span>
        </div>
        <div class="import-review-list">${reviewCards}</div>
      ` : ''}
      <p class="surface-message" role="status">${escapeHtml(surfaceMessage)}</p>
    </div>
    <footer class="surface-actions surface-actions--end">
      <span class="import-step-label">3 · 确认创建</span>
      <button class="primary-button" type="button" data-action="create-imported-schedule"${draft && issueCount === 0 && !importCreatePending ? '' : ' disabled'}>确认并创建课表</button>
    </footer>
  `, true)
}

function fontScaleLabel(value: number): string {
  if (value >= 1.15) return '大'
  if (value > 1) return '标准'
  return '小'
}

const RADIUS_STEPS = [12, 22, 32]
const FONT_STEPS = [0.9, 1.05, 1.2]
const APP_FONT_STEPS = [0.92, 1, 1.15]
function appFontLabel(value: number): string {
  if (value >= 1.1) return '大'
  if (value > 0.96) return '标准'
  return '小'
}
function appFontToStep(value: number): number {
  let best = 0
  let bestDist = Infinity
  APP_FONT_STEPS.forEach((f, i) => {
    const d = Math.abs(f - value)
    if (d < bestDist) { bestDist = d; best = i }
  })
  return best
}
function radiusLabel(value: number): string {
  if (value >= 28) return '大'
  if (value >= 17) return '中'
  return '小'
}
function radiusToStep(value: number): number {
  let best = 0
  let bestDist = Infinity
  RADIUS_STEPS.forEach((r, i) => {
    const d = Math.abs(r - value)
    if (d < bestDist) { bestDist = d; best = i }
  })
  return best
}
function fontToStep(value: number): number {
  let best = 0
  let bestDist = Infinity
  FONT_STEPS.forEach((f, i) => {
    const d = Math.abs(f - value)
    if (d < bestDist) { bestDist = d; best = i }
  })
  return best
}

function appearanceSurfaceMarkup(): string {
  const opacityPercent = Math.round(settings.widgetOpacity * 100)
  const themePills = ([
    ['light', '浅色'],
    ['dark', '深色'],
  ] as const).map(([value, label]) => `
    <button type="button" class="style-pill${settings.widgetTheme === value ? ' is-selected' : ''}" data-action="set-widget-theme" data-value="${value}" aria-pressed="${settings.widgetTheme === value}">
      <span class="style-pill-swatch style-swatch--theme-${value}"></span>${label}
    </button>`).join('')
  const backgroundPills = ([
    ['blue', '蓝色'],
    ['light', '浅白'],
    ['dark', '深黑'],
    ['colorful', '多彩'],
  ] as const).map(([value, label]) => `
    <button type="button" class="style-pill${settings.widgetBackground === value ? ' is-selected' : ''}" data-action="set-widget-background" data-value="${value}" aria-pressed="${settings.widgetBackground === value}">
      <span class="style-pill-swatch style-swatch--bg-${value}"></span>${label}
    </button>`).join('')
  const radius = settings.widgetRadius
  const fontScale = settings.widgetFontScale
  const appFontScale = settings.appFontScale
  const ballModePills = ([
    ['true', '悬浮球'],
    ['false', '桌面组件'],
  ] as const).map(([value, label]) => `
    <button type="button" class="style-pill${settings.ballMode === (value === 'true') ? ' is-selected' : ''}" data-action="set-ball-mode" data-value="${value}" aria-pressed="${settings.ballMode === (value === 'true')}">${label}</button>`).join('')
  return surfaceShell('组件外观', `
    <div class="surface-scroll simple-surface">
      <fieldset class="appearance-fieldset">
        <legend>主题</legend>
        <div class="style-pill-grid">${themePills}</div>
      </fieldset>
      <fieldset class="appearance-fieldset">
        <legend>背景风格</legend>
        <div class="style-pill-grid">${backgroundPills}</div>
      </fieldset>
      <fieldset class="appearance-fieldset">
        <legend>圆角 <output class="style-range-output" id="radius-output">${radiusLabel(radius)}</output></legend>
        <input type="range" min="0" max="2" step="1" value="${radiusToStep(radius)}" data-action="set-widget-radius" />
      </fieldset>
      <fieldset class="appearance-fieldset">
        <legend>字号 <output class="style-range-output" id="font-output">${fontScaleLabel(fontScale)}</output></legend>
        <input type="range" min="0" max="2" step="1" value="${fontToStep(fontScale)}" data-action="set-widget-font" />
      </fieldset>
      <div class="surface-intro" style="margin-top:10px"><h3>悬浮球与透明度</h3></div>
      <fieldset class="appearance-fieldset">
        <legend>桌面形态</legend>
        <div class="style-pill-grid">${ballModePills}</div>
      </fieldset>
      <div class="appearance-opacity">
        <label class="field field--full"><span>组件卡片透明度 <output id="opacity-output">${opacityPercent}%</output></span>
          <input type="range" min="0" max="100" step="1" value="${opacityPercent}" data-action="set-opacity" />
        </label>
      </div>
      <fieldset class="appearance-fieldset">
        <legend>软件字号 <output class="style-range-output" id="app-font-output">${appFontLabel(appFontScale)}</output></legend>
        <input type="range" min="0" max="2" step="1" value="${appFontToStep(appFontScale)}" data-action="set-app-font" />
      </fieldset>
      <p class="surface-message" role="status">${escapeHtml(surfaceMessage)}</p>
    </div>
  `)
}

function timesSurfaceMarkup(): string {
  const rows = timeDraft.map((item) => `
    <div class="time-row">
      <strong>${item.section}</strong>
      <label><span>开始</span><input type="time" min="00:00" max="23:59" step="60" value="${item.start}" data-time-start="${item.section}" /></label>
      <label><span>结束</span><input type="time" min="00:00" max="23:59" step="60" value="${item.end}" data-time-end="${item.section}" /></label>
    </div>
  `).join('')
  return surfaceShell('作息时间', `
    <div class="surface-scroll simple-surface">
      <div class="surface-intro"><h3>逐节设置时间</h3><p>课表显示多少节由这里的节次数量决定。</p></div>
      <label class="switch-row"><span>每节课时长相同</span><input id="equal-duration" type="checkbox"${timeEqualDuration ? ' checked' : ''} /></label>
      <div class="time-list">${rows}</div>
      <div class="inline-actions">
        <button class="secondary-button" type="button" data-action="add-lesson">＋ 添加节次</button>
        <button class="secondary-button" type="button" data-action="remove-lesson"${timeDraft.length <= 1 ? ' disabled' : ''}>删除末节</button>
      </div>
      <button class="text-button" type="button" data-action="restore-times">恢复默认作息</button>
      <p class="surface-message" role="status">${escapeHtml(surfaceMessage)}</p>
    </div>
    <footer class="surface-actions surface-actions--end"><button class="primary-button" type="button" data-action="save-times">保存作息时间</button></footer>
  `)
}

function sectionIndexOf(time: string): number {
  return settings.lessonTimes.findIndex((item) => item.start === time || item.end === time)
}

function specialSurfaceMarkup(): string {
  const items = settings.specialScheduleRules.map((rule, index) => {
    const from = sectionIndexOf(rule.sectionStart)
    const to = sectionIndexOf(rule.sectionEnd)
    const range = from >= 0 && to >= 0
      ? `第${from + 1}–${to + 1}节（${rule.sectionStart}–${rule.sectionEnd}）`
      : `${rule.sectionStart}–${rule.sectionEnd}`
    return `
      <li class="special-rule">
        <div class="special-rule-body" data-action="edit-special" data-index="${index}" role="button" title="点击编辑">
          <strong>${escapeHtml(rule.keywords.join('、'))}</strong>
          <span>${escapeHtml(range)} → 实际 ${rule.actualStart}–${rule.actualEnd}</span>
        </div>
        <span class="rule-swatch" style="background:${escapeHtml(rule.color)}" title="标注颜色"></span>
        <button class="trash-lg" type="button" data-action="delete-special" data-index="${index}" aria-label="删除" style="cursor:pointer;background:none;border:none;padding:6px;margin:0;line-height:0;display:inline-flex;align-items:center;justify-content:center;color:#8a919c"><svg viewBox="0 0 16 16" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5h11M6.5 2.5h3M4 4.5l.6 8.6a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.6-8.6M6.5 6.7v4M9.5 6.7v4"/></svg></button>
      </li>
    `
  }).join('')
  const form = specialDraftOpen ? specialFormMarkup() : `<button class="text-button" type="button" data-action="add-special">＋ 添加规则</button>`
  return surfaceShell('特殊标注', `
    <div class="surface-scroll special-surface">
      <p class="surface-hint">地点含关键词且在该节次的课程，卡片顶部标注实际时间</p>
      <ul class="special-list">${items || '<li class="special-empty">暂无规则</li>'}</ul>
      ${form}
      <p class="surface-message" role="status">${escapeHtml(surfaceMessage)}</p>
    </div>
  `)
}

function specialFormMarkup(): string {
  const draft = specialDraft ?? { keywords: [], sectionStart: '10:15', sectionEnd: '11:50', actualStart: '10:05', actualEnd: '11:35', color: '#101826' }
  const count = settings.lessonTimes.length
  const from = Math.max(1, Math.min(count, sectionIndexOf(draft.sectionStart) + 1))
  const to = Math.max(from, Math.min(count, sectionIndexOf(draft.sectionEnd) + 1))
  const sectionOptions = (selected: number) => Array.from({ length: count }, (_, index) => index + 1)
    .map((num) => `<option value="${num}"${num === selected ? ' selected' : ''}>${num}</option>`).join('')
  const swatches = SPECIAL_COLORS.map((color) =>
    `<button class="color-swatch${draft.color === color ? ' is-active' : ''}" type="button" data-special-color="${color}" style="--swatch:${color}" aria-label="选择颜色 ${color}"></button>`,
  ).join('')
  return `
    <div class="special-form">
      <label class="field">
        <span>关键词（逗号分隔）</span>
        <input id="special-keywords" value="${escapeHtml(draft.keywords.join(','))}" placeholder="如：广学楼,明德楼" />
      </label>
      <div class="special-form-row">
        <label class="field">
          <span>起始节</span>
          <select id="special-section-from">${sectionOptions(from)}</select>
        </label>
        <label class="field">
          <span>结束节</span>
          <select id="special-section-to">${sectionOptions(to)}</select>
        </label>
      </div>
      <div class="special-form-row">
        <label class="field">
          <span>实际开始</span>
          <input id="special-actual-start" value="${escapeHtml(draft.actualStart)}" placeholder="10:05" />
        </label>
        <label class="field">
          <span>实际结束</span>
          <input id="special-actual-end" value="${escapeHtml(draft.actualEnd)}" placeholder="11:35" />
        </label>
      </div>
      <fieldset class="color-field">
        <legend>标注颜色</legend>
        <div class="color-options">${swatches}</div>
      </fieldset>
      <div class="inline-actions">
        <button class="secondary-button" type="button" data-action="cancel-special">取消</button>
        <button class="primary-button" type="button" data-action="save-special">保存规则</button>
      </div>
    </div>
  `
}

function scheduleSurfaceMarkup(): string {
  if (!scheduleDraft) return ''
  const minimumWeeks = scheduleDraft.id === schedule.id ? courseMaximumWeek(schedule) : 1
  return surfaceShell('编辑课表', `
    <div class="surface-scroll simple-surface schedule-editor">
      <div class="surface-intro">
        <h3>课表信息</h3>
        <p>教学周会根据第一周星期一自动计算，修改后不会改变课程本身的周次。</p>
      </div>
      <div class="schedule-editor-form">
        <label class="field field--full">
          <span>课表名称</span>
          <input id="schedule-name" value="${escapeHtml(scheduleDraft.name)}" maxlength="80" placeholder="输入课表名称" />
        </label>
        <label class="field">
          <span>第一周星期一</span>
          <input id="schedule-semester-start" type="date" value="${escapeHtml(scheduleDraft.semesterStart)}" />
        </label>
        <label class="field">
          <span>学期总周数</span>
          <input id="schedule-total-weeks" type="number" min="${minimumWeeks}" max="30" value="${scheduleDraft.totalWeeks}" />
        </label>
      </div>
      <div class="schedule-metadata">
        <div><span>课程数量</span><strong>${scheduleDraft.courseCount} 门</strong></div>
        <div><span>当前状态</span><strong>${scheduleDraft.active ? '正在使用' : '未启用'}</strong></div>
      </div>
      ${minimumWeeks > 1 ? `<p class="editor-note">该课表的课程已使用到第 ${minimumWeeks} 周，因此总周数不能更少。</p>` : ''}
      <p class="surface-message" role="status">${escapeHtml(surfaceMessage)}</p>
    </div>
    <footer class="surface-actions">
      <button class="danger-button" type="button" data-action="delete-edited-schedule"${summaries.length <= 1 ? ' disabled title="至少保留一份课表"' : ''}>删除课表</button>
      <div class="action-group">
        <button class="secondary-button" type="button" data-action="cancel-schedule">取消</button>
        <button class="primary-button" type="button" data-action="save-schedule">保存修改</button>
      </div>
    </footer>
  `)
}

function dataSurfaceMarkup(): string {
  const items = summaries.map((item) => {
    const weeks = calendarWeekCount(item.semesterStart, item.semesterEnd)
    return `
      <article class="schedule-record${item.active ? ' is-active' : ''}">
        <div class="record-copy">
          <div class="record-title"><strong>${escapeHtml(item.name)}</strong>${item.active ? '<span>当前</span>' : ''}</div>
          <p>${escapeHtml(item.semesterStart)} · ${weeks ? `${weeks} 周 · ` : ''}${item.courseCount} 门课程</p>
        </div>
        <div class="record-actions">
          ${item.active ? '' : `<button type="button" data-activate-schedule="${escapeHtml(item.id)}">设为当前</button>`}
          <button type="button" data-edit-schedule="${escapeHtml(item.id)}">编辑</button>
          <button class="record-delete" type="button" data-delete-schedule="${escapeHtml(item.id)}"${summaries.length <= 1 ? ' disabled title="至少保留一份课表"' : ''}>删除</button>
        </div>
      </article>
    `
  }).join('')
  return surfaceShell('课表与数据', `
    <div class="surface-scroll simple-surface">
      <div class="schedule-records">${items}</div>
      <div class="data-card">
        <h3>本地数据</h3>
        <button class="secondary-button" type="button" data-action="open-data-location">打开数据位置</button>
      </div>
      <p class="surface-message" role="status">${escapeHtml(surfaceMessage)}</p>
    </div>
  `)
}
function helpSurfaceMarkup(): string {
  return surfaceShell('使用帮助', `
    <div class="surface-scroll simple-surface help-list">
      <section><h3>悬浮球操作</h3><p>单击悬浮球展开课表卡片；点击卡片右上角“◉”收起为悬浮球。</p></section>
      <section><h3>系统托盘操作</h3><p>单击托盘图标：显示 / 隐藏课表窗口。双击托盘图标：打开 / 收起设置窗口。右键托盘图标：退出程序。</p></section>
      <section><h3>查看其他教学周</h3><p>点击顶部左右箭头切换教学周，星期栏同步显示对应日期。</p></section>
      <section><h3>新增或修改课程</h3><p>点击右上角“＋”新增课程；点击课程块后在右侧修改多个上课时间段。</p></section>
      <section><h3>管理多份课表</h3><p>点击左上角课表名称快速切换；也可进入“课表与数据”删除课表。</p></section>
    </div>
  `)
}

function aboutSurfaceMarkup(): string {
  return surfaceShell('关于', `
    <div class="surface-scroll simple-surface about-panel">
      <div class="about-icon">课</div>
      <h3>课刻-广东海洋大学定制版</h3>
      <p>By 权爷 · 适配广东海洋大学教务系统</p>
      <span>版本 ${escapeHtml(applicationVersion || '读取中…')}</span>
      <p class="about-note">课表数据仅保存在本机，不会上传到服务器。<br>搭配 GDOU_课表导出_ICS_Excel.user.js 使用。</p>
    </div>
  `)
}

async function refreshAboutVersion(): Promise<void> {
  if (!desktopRuntime || applicationVersion) return
  try {
    applicationVersion = await getVersion()
  } catch {
    applicationVersion = '未知'
  }
  if (surface === 'about') render()
}

function bindEvents(): void {
  document.querySelector('[data-action="toggle-menu"]')?.addEventListener('click', () => {
    scheduleMenuOpen = false
    menuOpen = !menuOpen
    render()
  })
  document.querySelector('[data-action="toggle-schedule-menu"]')?.addEventListener('click', () => {
    menuOpen = false
    scheduleMenuOpen = !scheduleMenuOpen
    render()
  })
  document.querySelector('[data-action="close-schedule-menu"]')?.addEventListener('click', () => {
    scheduleMenuOpen = false
    render()
  })
  document.querySelector('[data-action="add-course"]')?.addEventListener('click', () => openNewCourse())
  document.querySelector('[data-action="previous-week"]')?.addEventListener('click', () => changeWeek(-1))
  document.querySelector('[data-action="next-week"]')?.addEventListener('click', () => changeWeek(1))
  document.querySelector<HTMLElement>('.schedule-scroll')?.addEventListener('click', (event) => {
    if (scheduleMenuOpen || menuOpen) {
      scheduleMenuOpen = false
      menuOpen = false
      render()
      return
    }
    if (!surface) return
    const target = event.target as HTMLElement
    if (target.closest('[data-course-id]')) return
    closeSurface('backdrop')
  })
  document.querySelector('[data-action="close-surface"]')?.addEventListener('click', () => closeSurface('explicit'))

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-open-surface]')) {
    button.addEventListener('click', () => openSurface(button.dataset.openSurface as Exclude<Surface, 'course' | null>))
  }
  document.querySelector('[data-action="choose-pdf"]')?.addEventListener('click', () => void choosePdf())
  for (const input of document.querySelectorAll<HTMLInputElement>('[data-action="set-opacity"]')) {
    const output = document.querySelector<HTMLOutputElement>('#opacity-output')
    input.addEventListener('input', () => {
      if (output) output.textContent = `${input.value}%`
    })
    input.addEventListener('change', () => void saveOpacity(Number(input.value) / 100))
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action="set-ball-mode"]')) {
    button.addEventListener('click', () => {
      void saveBallMode(button.dataset.value === 'true')
    })
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action="set-widget-theme"]')) {
    button.addEventListener('click', () => {
      void saveWidgetStyle({ widgetTheme: button.dataset.value as WidgetTheme })
    })
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action="set-widget-background"]')) {
    button.addEventListener('click', () => {
      void saveWidgetStyle({ widgetBackground: button.dataset.value as WidgetBackground })
    })
  }
  for (const input of document.querySelectorAll<HTMLInputElement>('[data-action="set-widget-radius"]')) {
    const output = document.querySelector<HTMLOutputElement>('#radius-output')
    input.addEventListener('input', () => {
      const idx = Math.min(2, Math.max(0, Math.round(Number(input.value))))
      if (output) output.textContent = radiusLabel(RADIUS_STEPS[idx])
    })
    input.addEventListener('change', () => {
      const idx = Math.min(2, Math.max(0, Math.round(Number(input.value))))
      void saveWidgetStyle({ widgetRadius: RADIUS_STEPS[idx] })
    })
  }
  for (const input of document.querySelectorAll<HTMLInputElement>('[data-action="set-widget-font"]')) {
    const output = document.querySelector<HTMLOutputElement>('#font-output')
    input.addEventListener('input', () => {
      const idx = Math.min(2, Math.max(0, Math.round(Number(input.value))))
      if (output) output.textContent = fontScaleLabel(FONT_STEPS[idx])
    })
    input.addEventListener('change', () => {
      const idx = Math.min(2, Math.max(0, Math.round(Number(input.value))))
      void saveWidgetStyle({ widgetFontScale: FONT_STEPS[idx] })
    })
  }
  for (const input of document.querySelectorAll<HTMLInputElement>('[data-action="set-app-font"]')) {
    const output = document.querySelector<HTMLOutputElement>('#app-font-output')
    input.addEventListener('input', () => {
      const idx = Math.min(2, Math.max(0, Math.round(Number(input.value))))
      if (output) output.textContent = appFontLabel(APP_FONT_STEPS[idx])
    })
    input.addEventListener('change', () => {
      const idx = Math.min(2, Math.max(0, Math.round(Number(input.value))))
      void saveAppFontScale(APP_FONT_STEPS[idx])
    })
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-course-id]')) {
    button.addEventListener('click', () => openExistingCourse(button.dataset.courseId ?? ''))
  }

  document.querySelector('[data-action="toggle-autostart"]')?.addEventListener('click', () => void toggleAutostart())
  document.querySelector('[data-action="add-special"]')?.addEventListener('click', () => {
    specialDraft = { keywords: [], sectionStart: '10:15', sectionEnd: '11:50', actualStart: '10:05', actualEnd: '11:35', color: defaultRuleColor() }
    specialEditIndex = null
    specialDraftOpen = true
    render()
  })
  document.querySelector('[data-action="cancel-special"]')?.addEventListener('click', () => {
    specialDraftOpen = false
    specialEditIndex = null
    render()
  })
  document.querySelector('[data-action="save-special"]')?.addEventListener('click', () => void saveSpecialRule())
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action="delete-special"]')) {
    button.addEventListener('click', () => requestDeleteSpecialRule(Number(button.dataset.index)))
  }
  document.querySelector('[data-action="confirm-no"]')?.addEventListener('click', () => {
    confirmRequest = null
    render()
  })
  document.querySelector('[data-action="confirm-yes"]')?.addEventListener('click', () => {
    const action = confirmRequest?.onConfirm
    confirmRequest = null
    action?.()
  })
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action="edit-special"]')) {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.index)
      specialDraft = structuredClone(settings.specialScheduleRules[index])
      specialEditIndex = index
      specialDraftOpen = true
      render()
    })
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-special-color]')) {
    button.addEventListener('click', () => {
      if (specialDraft) specialDraft.color = button.dataset.specialColor ?? SPECIAL_COLORS[0]
      document.querySelectorAll('[data-special-color]').forEach((swatch) => {
        swatch.classList.toggle('is-active', swatch === button)
      })
    })
  }
  bindCourseEvents()
  bindScheduleEvents()
  bindImportEvents()
  bindTimeEvents()
  bindDataEvents()
}

function changeWeek(delta: number): void {
  if (!canLeaveCourse('切换教学周')) return
  scheduleMenuOpen = false
  menuOpen = false
  currentWeek = clamp(currentWeek + delta, 1, maximumWeek(schedule))
  selectedCourseId = null
  render()
}

function openSurface(next: Exclude<Surface, 'course' | null>): void {
  if (!canLeaveCourse('打开其他设置')) return
  surface = next
  menuOpen = false
  scheduleMenuOpen = false
  selectedCourseId = null
  surfaceMessage = ''
  if (next === 'times') {
    timeDraft = structuredClone(settings.lessonTimes)
    timeEqualDuration = settings.equalDuration
  }
  if (next === 'special') {
    specialDraftOpen = false
    specialEditIndex = null
    specialDraft = null
  }
  render()
  if (next === 'about') void refreshAboutVersion()
}

function closeSurface(reason: 'backdrop' | 'explicit'): void {
  if (hasUnsavedChanges()) {
    if (reason === 'backdrop') return
    if (!window.confirm('放弃未保存的修改？')) return
  }
  surface = null
  selectedCourseId = null
  courseDraft = null
  initialDraftSnapshot = ''
  scheduleDraft = null
  initialScheduleDraftSnapshot = ''
  surfaceMessage = ''
  render()
}

function canLeaveCourse(action: string): boolean {
  if (!hasUnsavedChanges()) return true
  return window.confirm(`${action}会放弃当前未保存的修改，是否继续？`)
}

function hasUnsavedChanges(): boolean {
  return draftDirty() || scheduleDraftDirty()
}

function draftDirty(): boolean {
  return surface === 'course' && Boolean(courseDraft && JSON.stringify(courseDraft) !== initialDraftSnapshot)
}

function scheduleDraftDirty(): boolean {
  if (surface !== 'schedule' || !scheduleDraft) return false
  const currentDraft = {
    ...scheduleDraft,
    name: document.querySelector<HTMLInputElement>('#schedule-name')?.value ?? scheduleDraft.name,
    semesterStart: document.querySelector<HTMLInputElement>('#schedule-semester-start')?.value ?? scheduleDraft.semesterStart,
    totalWeeks: Number(document.querySelector<HTMLInputElement>('#schedule-total-weeks')?.value ?? scheduleDraft.totalWeeks),
  }
  return JSON.stringify(currentDraft) !== initialScheduleDraftSnapshot
}

function createSlot(source?: DraftSlot): DraftSlot {
  if (source) return { ...structuredClone(source), key: crypto.randomUUID() }
  return {
    key: crypto.randomUUID(),
    weekday: 1,
    startSection: settings.lessonTimes[0]?.section ?? 1,
    endSection: settings.lessonTimes[Math.min(1, settings.lessonTimes.length - 1)]?.section ?? 1,
    startWeek: 1,
    endWeek: maximumWeek(schedule),
    parity: 'all',
    customWeeks: false,
    selectedWeeks: rangeWeeks(1, maximumWeek(schedule), 'all'),
    location: '',
    teacher: '',
  }
}

function openNewCourse(): void {
  if (!canLeaveCourse('新增课程')) return
  selectedCourseId = null
  courseDraft = { name: '', color: palette[nextColorIndex()], slots: [createSlot()] }
  initialDraftSnapshot = JSON.stringify(courseDraft)
  surface = 'course'
  menuOpen = false
  scheduleMenuOpen = false
  surfaceMessage = ''
  render()
}

function nextColorIndex(): number {
  const counts = palette.map((color) => schedule.courses.filter((course) => course.color === color).length)
  return counts.indexOf(Math.min(...counts))
}

function openExistingCourse(courseId: string): void {
  if (!courseId || (selectedCourseId === courseId && surface === 'course')) return
  if (!canLeaveCourse('切换课程')) return
  selectedCourseId = courseId
  const courses = schedule.courses.filter((course) => course.id === courseId)
  const first = courses[0]
  if (!first) return
  courseDraft = {
    courseId,
    name: first.name,
    color: first.color,
    slots: courses.map((course) => draftSlotFromCourse(course)),
  }
  initialDraftSnapshot = JSON.stringify(courseDraft)
  surface = 'course'
  menuOpen = false
  scheduleMenuOpen = false
  surfaceMessage = ''
  render()
}

function draftSlotFromCourse(course: CatalogCourse): DraftSlot {
  const startSection = settings.lessonTimes[lessonIndexForStart(course.start)]?.section ?? 1
  const endSection = settings.lessonTimes[lessonIndexForEnd(course.end)]?.section ?? startSection
  const startWeek = Math.min(...course.weeks)
  const endWeek = Math.max(...course.weeks)
  const expected = rangeWeeks(startWeek, endWeek, course.parity)
  return {
    key: crypto.randomUUID(),
    weekday: course.weekday,
    startSection,
    endSection,
    startWeek,
    endWeek,
    parity: course.parity,
    customWeeks: expected.join(',') !== course.weeks.join(','),
    selectedWeeks: [...course.weeks],
    location: course.location,
    teacher: course.teacher,
  }
}

function rangeWeeks(start: number, end: number, parity: Parity): number[] {
  const weeks: number[] = []
  for (let week = start; week <= end; week += 1) {
    if (parity === 'all' || (parity === 'odd' ? week % 2 === 1 : week % 2 === 0)) weeks.push(week)
  }
  return weeks
}

function bindCourseEvents(): void {
  if (surface !== 'course' || !courseDraft) return
  document.querySelector<HTMLInputElement>('#course-name')?.addEventListener('input', (event) => {
    if (courseDraft) courseDraft.name = (event.currentTarget as HTMLInputElement).value
  })
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-color]')) {
    button.addEventListener('click', () => {
      if (!courseDraft) return
      courseDraft.color = button.dataset.color ?? palette[0]
      render()
    })
  }
  for (const input of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-slot-field]')) {
    input.addEventListener('input', () => updateSlotField(input))
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-remove-slot]')) {
    button.addEventListener('click', () => {
      if (!courseDraft) return
      courseDraft.slots = courseDraft.slots.filter((slot) => slot.key !== button.dataset.removeSlot)
      render()
    })
  }
  document.querySelector('[data-action="add-slot"]')?.addEventListener('click', () => {
    if (!courseDraft) return
    courseDraft.slots.push(createSlot(courseDraft.slots.at(-1)))
    render()
  })
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-toggle-weeks]')) {
    button.addEventListener('click', () => {
      const slot = findSlot(button.dataset.toggleWeeks)
      if (!slot) return
      slot.customWeeks = !slot.customWeeks
      if (slot.customWeeks && slot.selectedWeeks.length === 0) slot.selectedWeeks = rangeWeeks(slot.startWeek, slot.endWeek, slot.parity)
      render()
    })
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-slot-week]')) {
    button.addEventListener('click', () => {
      const [key, value] = (button.dataset.slotWeek ?? '').split(':')
      const slot = findSlot(key)
      const week = Number(value)
      if (!slot || !week) return
      slot.selectedWeeks = slot.selectedWeeks.includes(week)
        ? slot.selectedWeeks.filter((item) => item !== week)
        : [...slot.selectedWeeks, week].sort((left, right) => left - right)
      render()
    })
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-week-action]')) {
    button.addEventListener('click', () => {
      const [action, key] = (button.dataset.weekAction ?? '').split(':')
      const slot = findSlot(key)
      if (!slot) return
      slot.selectedWeeks = action === 'all' ? Array.from({ length: Math.max(maximumWeek(schedule), 20) }, (_, index) => index + 1) : []
      render()
    })
  }
  document.querySelector('[data-action="cancel-course"]')?.addEventListener('click', () => closeSurface('explicit'))
  document.querySelector('[data-action="save-course"]')?.addEventListener('click', () => void saveCourse())
  document.querySelector('[data-action="delete-course"]')?.addEventListener('click', () => void deleteCourse())
}

function findSlot(key?: string): DraftSlot | undefined {
  return courseDraft?.slots.find((slot) => slot.key === key)
}

function updateSlotField(input: HTMLInputElement | HTMLSelectElement): void {
  const slot = findSlot(input.dataset.slot)
  const field = input.dataset.slotField
  if (!slot || !field) return
  if (field === 'weekday') slot.weekday = Number(input.value)
  if (field === 'startSection') slot.startSection = Number(input.value)
  if (field === 'endSection') slot.endSection = Number(input.value)
  if (field === 'startWeek') slot.startWeek = clamp(Number(input.value), 1, 30)
  if (field === 'endWeek') slot.endWeek = clamp(Number(input.value), 1, 30)
  if (field === 'parity') slot.parity = input.value as Parity
  if (field === 'location') slot.location = input.value
  if (field === 'teacher') slot.teacher = input.value
  if (['startWeek', 'endWeek', 'parity'].includes(field) && !slot.customWeeks) {
    slot.selectedWeeks = rangeWeeks(slot.startWeek, slot.endWeek, slot.parity)
  }
}

function buildCourseRequest(): SaveCourseRequest {
  if (!courseDraft) throw new Error('没有可保存的课程')
  const name = courseDraft.name.trim()
  if (!name) throw new Error('请填写课程名称')
  if (courseDraft.slots.length === 0) throw new Error('至少需要一个上课时间段')
  return {
    courseId: courseDraft.courseId,
    name,
    color: courseDraft.color,
    slots: courseDraft.slots.map((slot, index) => {
      if (slot.endSection < slot.startSection) throw new Error(`时间段 ${index + 1} 的结束节次不能早于开始节次`)
      const start = settings.lessonTimes.find((item) => item.section === slot.startSection)
      const end = settings.lessonTimes.find((item) => item.section === slot.endSection)
      if (!start || !end) throw new Error(`时间段 ${index + 1} 的节次不存在`)
      const weeks = slot.customWeeks ? slot.selectedWeeks : rangeWeeks(slot.startWeek, slot.endWeek, slot.parity)
      if (weeks.length === 0) throw new Error(`时间段 ${index + 1} 至少选择一个教学周`)
      return {
        weekday: slot.weekday,
        start: start.start,
        end: end.end,
        weeks,
        parity: slot.customWeeks ? 'all' : slot.parity,
        location: slot.location.trim(),
        teacher: slot.teacher.trim(),
      }
    }),
  }
}

async function saveCourse(): Promise<void> {
  try {
    const request = buildCourseRequest()
    if (desktopRuntime) {
      schedule = await invoke<CatalogSchedule>(plugin('save_course'), { request })
      summaries = await invoke<ScheduleSummary[]>(plugin('list_schedules'))
    } else {
      const id = request.courseId ?? `browser-${Date.now()}`
      schedule.courses = schedule.courses.filter((course) => course.id !== request.courseId)
      schedule.courses.push(...request.slots.map((slot) => ({ ...slot, id, name: request.name, color: request.color })))
      summaries = [summaryFromSchedule(schedule, true)]
    }
    selectedCourseId = request.courseId ?? schedule.courses.at(-1)?.id ?? null
    surface = null
    courseDraft = null
    initialDraftSnapshot = ''
    render()
    showToast('已保存')
  } catch (error) {
    surfaceMessage = errorText(error)
    render()
  }
}

async function deleteCourse(): Promise<void> {
  if (!courseDraft?.courseId || !window.confirm('确定删除这门课程及其全部上课时间段吗？')) return
  try {
    if (desktopRuntime) {
      schedule = await invoke<CatalogSchedule>(plugin('delete_course'), { courseId: courseDraft.courseId })
      summaries = await invoke<ScheduleSummary[]>(plugin('list_schedules'))
    } else {
      const remaining = schedule.courses.filter((course) => course.id !== courseDraft?.courseId)
      if (remaining.length === 0) throw new Error('示例模式暂不允许删除最后一门课程')
      schedule.courses = remaining
      summaries = [summaryFromSchedule(schedule, true)]
    }
    surface = null
    selectedCourseId = null
    courseDraft = null
    render()
    showToast('课程已删除')
  } catch (error) {
    surfaceMessage = errorText(error)
    render()
  }
}


async function openScheduleEditor(id: string): Promise<void> {
  if (!id || !canLeaveCourse('编辑课表')) return
  try {
    let target: CatalogSchedule
    if (desktopRuntime) {
      target = await invoke<CatalogSchedule>(plugin('get_schedule'), { scheduleId: id })
    } else {
      target = schedule
    }
    const summary = summaries.find((item) => item.id === id) ?? summaryFromSchedule(target, id === schedule.id)
    scheduleDraft = {
      id: target.id,
      name: target.name,
      semesterStart: target.semesterStart,
      totalWeeks: maximumWeek(target),
      courseCount: summary.courseCount,
      active: summary.active,
    }
    initialScheduleDraftSnapshot = JSON.stringify(scheduleDraft)
    surface = 'schedule'
    selectedCourseId = null
    courseDraft = null
    initialDraftSnapshot = ''
    menuOpen = false
    scheduleMenuOpen = false
    surfaceMessage = ''
    render()
  } catch (error) {
    surfaceMessage = errorText(error)
    render()
  }
}

function bindScheduleEvents(): void {
  if (surface !== 'schedule' || !scheduleDraft) return
  document.querySelector<HTMLInputElement>('#schedule-name')?.addEventListener('input', (event) => {
    if (scheduleDraft) scheduleDraft.name = (event.currentTarget as HTMLInputElement).value
  })
  document.querySelector<HTMLInputElement>('#schedule-semester-start')?.addEventListener('input', (event) => {
    if (scheduleDraft) scheduleDraft.semesterStart = (event.currentTarget as HTMLInputElement).value
  })
  document.querySelector<HTMLInputElement>('#schedule-total-weeks')?.addEventListener('input', (event) => {
    if (scheduleDraft) scheduleDraft.totalWeeks = clamp(Number((event.currentTarget as HTMLInputElement).value), 1, 30)
  })
  document.querySelector('[data-action="cancel-schedule"]')?.addEventListener('click', () => closeSurface('explicit'))
  document.querySelector('[data-action="save-schedule"]')?.addEventListener('click', () => void saveSchedule())
  document.querySelector('[data-action="delete-edited-schedule"]')?.addEventListener('click', () => {
    if (scheduleDraft) void deleteSchedule(scheduleDraft.id)
  })
}

async function saveSchedule(): Promise<void> {
  if (!scheduleDraft) return
  try {
    const name = scheduleDraft.name.trim()
    if (!name) throw new Error('请填写课表名称')
    if (!scheduleDraft.semesterStart) throw new Error('请选择第一周星期一')
    const minimumWeeks = scheduleDraft.id === schedule.id ? courseMaximumWeek(schedule) : 1
    if (scheduleDraft.totalWeeks < minimumWeeks) throw new Error(`学期总周数不能少于 ${minimumWeeks} 周`)
    const semesterEnd = dateKey(addDays(parseLocalDate(scheduleDraft.semesterStart), scheduleDraft.totalWeeks * 7 - 1))

    if (desktopRuntime) {
      const updated = await invoke<CatalogSchedule>(plugin('update_schedule'), {
        request: {
          scheduleId: scheduleDraft.id,
          name,
          semesterStart: scheduleDraft.semesterStart,
          semesterEnd,
        },
      })
      if (updated.id === schedule.id) schedule = updated
      summaries = await invoke<ScheduleSummary[]>(plugin('list_schedules'))
    } else {
      schedule = { ...schedule, name, semesterStart: scheduleDraft.semesterStart, semesterEnd }
      summaries = [summaryFromSchedule(schedule, true)]
    }

    if (scheduleDraft.id === schedule.id) currentWeek = initialWeek(schedule)
    surface = 'data'
    scheduleDraft = null
    initialScheduleDraftSnapshot = ''
    surfaceMessage = ''
    render()
    showToast('课表信息已保存')
  } catch (error) {
    surfaceMessage = errorText(error)
    render()
  }
}

function bindImportEvents(): void {
  document.querySelector('[data-action="choose-excel"]')?.addEventListener('click', () => void chooseExcel())
  document.querySelector('[data-action="create-imported-schedule"]')?.addEventListener('click', () => void createImportedSchedule())
  document.querySelector<HTMLInputElement>('#import-name')?.addEventListener('input', (event) => {
    importNameDraft = (event.currentTarget as HTMLInputElement).value
  })
  document.querySelector<HTMLInputElement>('#import-first-week')?.addEventListener('input', (event) => {
    importFirstWeekDraft = (event.currentTarget as HTMLInputElement).value
  })
  for (const details of document.querySelectorAll<HTMLDetailsElement>('[data-import-course-details]')) {
    details.addEventListener('toggle', () => {
      if (details.open) expandedImportCourseIndex = Number(details.dataset.importCourseDetails ?? 0)
    })
  }
  for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-import-field]')) {
    control.addEventListener('change', () => updateImportCourseField(control))
  }
}

function updateImportCourseField(control: HTMLInputElement | HTMLSelectElement): void {
  if (!importDraft) return
  const index = Number(control.dataset.importCourse)
  const field = control.dataset.importField
  const course = importDraft.courses[index]
  if (!course || !field) return
  expandedImportCourseIndex = index
  try {
    if (field === 'name') course.name = control.value
    if (field === 'weekday') course.weekday = Number(control.value)
    if (field === 'startSection') course.startSection = Number(control.value)
    if (field === 'endSection') course.endSection = Number(control.value)
    if (field === 'weeks') course.weeks = parseWeeksText(control.value)
    if (field === 'parity') course.parity = control.value as ImportCourse['parity']
    if (field === 'location') course.location = control.value
    if (field === 'teacher') course.teacher = control.value
    refreshImportDraftSummary(importDraft)
    surfaceMessage = ''
  } catch (error) {
    surfaceMessage = errorText(error)
  }
  render()
}

async function chooseExcel(): Promise<void> {
  if (!desktopRuntime) {
    surfaceMessage = '浏览器预览不会读取本机文件，请在桌面应用中测试。'
    render()
    return
  }
  surfaceMessage = '等待选择或解析…'
  render()
  try {
    importDraft = await invoke<ImportDraft | null>('choose_and_parse_excel')
    if (importDraft) {
      importNameDraft = importDraft.suggestedName
      importFirstWeekDraft = schedule.semesterStart
      expandedImportCourseIndex = 0
      refreshImportDraftSummary(importDraft)
      importRequestId = crypto.randomUUID()
    } else {
      importNameDraft = ''
      importFirstWeekDraft = ''
      importRequestId = ''
    }
    surfaceMessage = importDraft
      ? importDraft.lessonTimes?.length
        ? `解析完成。检测到 ${importDraft.lessonTimes.length} 节作息时间，创建课表时将自动应用。`
        : '解析完成，请逐项检查课程信息。'
      : '已取消选择。'
  } catch (error) {
    surfaceMessage = `解析失败：${errorText(error)}`
  }
  render()
}


async function choosePdf(): Promise<void> {
  if (!desktopRuntime) {
    surfaceMessage = '浏览器预览不会读取本机文件，请在桌面应用中测试。'
    render()
    return
  }
  surfaceMessage = '正在渲染 PDF 并识别课表…'
  render()
  try {
    const picked = await choosePdfFile()
    if (!picked) {
      surfaceMessage = '已取消选择。'
      render()
      return
    }
    let bestDraft: ImportDraft | null = null
    let bestCount = 0
    for (const page of picked.pages) {
      const pageName = `${picked.name.replace(/\.pdf$/i, '')} 第${page.pageNumber}页`
      const draft = await invoke<ImportDraft | null>('recognize_png_data', {
        dataUrl: page.dataUrl,
        sourceName: pageName,
      })
      if (draft && draft.courses.length > bestCount) {
        bestDraft = draft
        bestCount = draft.courses.length
      }
    }
    if (!bestDraft || bestCount === 0) {
      surfaceMessage = '未从 PDF 中识别到课表，请确认课表清晰完整。'
      render()
      return
    }
    importDraft = bestDraft
    importNameDraft = importDraft.suggestedName
    importFirstWeekDraft = schedule.semesterStart
    expandedImportCourseIndex = 0
    refreshImportDraftSummary(importDraft)
    importRequestId = crypto.randomUUID()
    surfaceMessage = `PDF 识别完成（共识别 ${bestCount} 项课程安排），请逐项检查。`
  } catch (error) {
    surfaceMessage = `解析失败：${errorText(error)}`
  }
  render()
}

async function saveOpacity(opacity: number): Promise<void> {
  if (!desktopRuntime) {
    surfaceMessage = '浏览器预览中无法调节桌面组件透明度。'
    render()
    return
  }
  try {
    await invoke('save_widget_opacity', { opacity })
    await invoke('set_main_widget_opacity', { opacity })
    settings.widgetOpacity = opacity
  } catch (error) {
    surfaceMessage = `保存失败：${errorText(error)}`
    render()
    return
  }
  const output = document.querySelector<HTMLOutputElement>('#opacity-output')
  if (output) output.textContent = `${Math.round(opacity * 100)}%`
}

async function saveBallMode(ballMode: boolean): Promise<void> {
  if (!desktopRuntime) {
    render()
    return
  }
  try {
    await invoke('save_ball_mode', { ballMode })
    await invoke('set_main_widget_mode', { ballMode })
    settings.ballMode = ballMode
  } catch (error) {
    surfaceMessage = `保存失败：${errorText(error)}`
    render()
    return
  }
  updateAppearanceControls()
}

async function saveWidgetStyle(patch: Partial<Pick<AppSettings, 'widgetTheme' | 'widgetBackground' | 'widgetRadius' | 'widgetFontScale'>>): Promise<void> {
  if (!desktopRuntime) {
    surfaceMessage = '浏览器预览中无法保存组件样式。'
    render()
    return
  }
  const next = { ...settings, ...patch }
  try {
    await invoke('save_widget_style', {
      theme: next.widgetTheme,
      background: next.widgetBackground,
      radius: next.widgetRadius,
      fontScale: next.widgetFontScale,
    })
    await invoke('apply_widget_style', {
      theme: next.widgetTheme,
      background: next.widgetBackground,
      radius: next.widgetRadius,
      fontScale: next.widgetFontScale,
    })
    settings.widgetTheme = next.widgetTheme
    settings.widgetBackground = next.widgetBackground
    settings.widgetRadius = next.widgetRadius
    settings.widgetFontScale = next.widgetFontScale
  } catch (error) {
    surfaceMessage = `保存失败：${errorText(error)}`
    render()
    return
  }
  updateAppearanceControls()
}

function applyAppFontScale(scale: number): void {
  const root = document.getElementById('app')
  if (root) root.style.zoom = String(scale)
}

function updateAppearanceControls(): void {
  const toggle = (action: string, value: string): void => {
    document.querySelectorAll<HTMLButtonElement>(`[data-action="${action}"]`).forEach((button) => {
      const selected = button.dataset.value === value
      button.classList.toggle('is-selected', selected)
      button.setAttribute('aria-pressed', String(selected))
    })
  }
  toggle('set-widget-theme', settings.widgetTheme)
  toggle('set-widget-background', settings.widgetBackground)
  toggle('set-ball-mode', String(settings.ballMode))
  const radiusOut = document.querySelector<HTMLOutputElement>('#radius-output')
  if (radiusOut) radiusOut.textContent = radiusLabel(settings.widgetRadius)
  const fontOut = document.querySelector<HTMLOutputElement>('#font-output')
  if (fontOut) fontOut.textContent = fontScaleLabel(settings.widgetFontScale)
  const appFontOut = document.querySelector<HTMLOutputElement>('#app-font-output')
  if (appFontOut) appFontOut.textContent = appFontLabel(settings.appFontScale)
}

async function saveAppFontScale(scale: number): Promise<void> {
  if (!desktopRuntime) {
    render()
    return
  }
  try {
    await invoke('save_app_font_scale', { fontScale: scale })
    settings.appFontScale = scale
    applyAppFontScale(scale)
  } catch (error) {
    surfaceMessage = `保存失败：${errorText(error)}`
    render()
    return
  }
  updateAppearanceControls()
}

async function saveSpecialRule(): Promise<void> {
  const keywordsInput = document.querySelector<HTMLInputElement>('#special-keywords')
  const fromInput = document.querySelector<HTMLSelectElement>('#special-section-from')
  const toInput = document.querySelector<HTMLSelectElement>('#special-section-to')
  const startInput = document.querySelector<HTMLInputElement>('#special-actual-start')
  const endInput = document.querySelector<HTMLInputElement>('#special-actual-end')
  if (!keywordsInput || !fromInput || !toInput || !startInput || !endInput) return
  const keywords = keywordsInput.value.split(/[,，、]/).map((part) => part.trim()).filter(Boolean)
  const from = Number(fromInput.value)
  const to = Number(toInput.value)
  const actualStart = startInput.value.trim()
  const actualEnd = endInput.value.trim()
  if (keywords.length === 0) {
    surfaceMessage = '请输入关键词'
    render()
    return
  }
  if (from > to) {
    surfaceMessage = '起始节不能大于结束节'
    render()
    return
  }
  if (!/^\d{1,2}:\d{2}$/.test(actualStart) || !/^\d{1,2}:\d{2}$/.test(actualEnd)) {
    surfaceMessage = '时间格式应为 HH:MM'
    render()
    return
  }
  const rule: SpecialScheduleRule = {
    keywords,
    sectionStart: settings.lessonTimes[from - 1]?.start ?? '',
    sectionEnd: settings.lessonTimes[to - 1]?.end ?? '',
    actualStart,
    actualEnd,
    color: specialDraft?.color ?? SPECIAL_COLORS[1],
  }
  if (!rule.sectionStart || !rule.sectionEnd) {
    surfaceMessage = '节次无效'
    render()
    return
  }
  const rules = structuredClone(settings.specialScheduleRules)
  if (specialEditIndex !== null && rules[specialEditIndex]) rules[specialEditIndex] = rule
  else rules.push(rule)
  if (!desktopRuntime) {
    settings.specialScheduleRules = rules
    specialDraftOpen = false
    specialEditIndex = null
    surfaceMessage = ''
    render()
    return
  }
  try {
    await invoke('save_special_rules', { rules })
    settings.specialScheduleRules = rules
    specialDraftOpen = false
    specialEditIndex = null
    surfaceMessage = ''
  } catch (error) {
    surfaceMessage = `保存失败：${errorText(error)}`
  }
  render()
}

function requestDeleteSpecialRule(index: number): void {
  const rule = settings.specialScheduleRules[index]
  if (!rule) return
  confirmRequest = {
    message: `删除规则「${rule.keywords.join('、')}」？`,
    onConfirm: () => void deleteSpecialRule(index),
  }
  render()
}

async function deleteSpecialRule(index: number): Promise<void> {
  const rules = structuredClone(settings.specialScheduleRules)
  if (index < 0 || index >= rules.length) return
  rules.splice(index, 1)
  if (!desktopRuntime) {
    settings.specialScheduleRules = rules
    surfaceMessage = ''
    render()
    return
  }
  try {
    await invoke('save_special_rules', { rules })
    settings.specialScheduleRules = rules
    surfaceMessage = ''
  } catch (error) {
    surfaceMessage = `保存失败：${errorText(error)}`
  }
  render()
}

async function createImportedSchedule(): Promise<void> {
  if (!importDraft || importCreatePending) return
  const name = importNameDraft.trim()
  const firstWeekMonday = importFirstWeekDraft
  try {
    if (!name) throw new Error('请填写课表名称')
    if (!firstWeekMonday) throw new Error('请确认第一周星期一')
    const issues = validateImportDraft(importDraft, settings.lessonTimes.length)
    if (issues.length) throw new Error(issues.slice(0, 3).join('；'))
    refreshImportDraftSummary(importDraft)
    importCreatePending = true
    render()
    if (desktopRuntime) {
      const times = importDraft.lessonTimes ?? settings.lessonTimes
      if (!importRequestId) importRequestId = crypto.randomUUID()
      await invoke(plugin('create_schedule_from_import'), {
        request: {
          name,
          firstWeekMonday,
          draft: importDraft,
          times,
          equalDuration: settings.equalDuration,
          requestId: importRequestId,
        },
      })
      await reloadDesktopState()
    }
    importDraft = null
    importNameDraft = ''
    importFirstWeekDraft = ''
    importRequestId = ''
    expandedImportCourseIndex = 0
    surface = null
    currentWeek = initialWeek(schedule)
    render()
    showToast('新课表已创建并启用')
  } catch (error) {
    surfaceMessage = errorText(error)
    render()
  } finally {
    importCreatePending = false
    if (importDraft) render()
  }
}

function bindLessonTimeInput(input: HTMLInputElement, field: 'start' | 'end'): void {
  const section = Number(field === 'start' ? input.dataset.timeStart : input.dataset.timeEnd)
  const item = timeDraft.find((value) => value.section === section)
  if (!item) return
  let valueBeforeEdit = item[field]
  input.addEventListener('focus', () => {
    valueBeforeEdit = item[field]
  })
  input.addEventListener('input', () => {
    if (!isValidClockTime(input.value) || !input.validity.valid) return
    item[field] = input.value
    if (timeEqualDuration && (field === 'start' || section === 1)) applyEqualDuration()
  })
  input.addEventListener('blur', () => {
    if (isValidClockTime(input.value) && input.validity.valid) return
    input.value = valueBeforeEdit
    item[field] = valueBeforeEdit
    if (timeEqualDuration && (field === 'start' || section === 1)) applyEqualDuration()
  })
}

function bindTimeEvents(): void {
  for (const input of document.querySelectorAll<HTMLInputElement>('[data-time-start]')) {
    bindLessonTimeInput(input, 'start')
  }
  for (const input of document.querySelectorAll<HTMLInputElement>('[data-time-end]')) {
    bindLessonTimeInput(input, 'end')
  }
  document.querySelector<HTMLInputElement>('#equal-duration')?.addEventListener('change', (event) => {
    timeEqualDuration = (event.currentTarget as HTMLInputElement).checked
    if (timeEqualDuration) applyEqualDuration()
    render()
  })
  document.querySelector('[data-action="add-lesson"]')?.addEventListener('click', () => {
    if (timeDraft.length >= 24) return
    const last = timeDraft.at(-1) ?? { section: 0, start: '08:00', end: '08:45' }
    const duration = Math.max(1, timeToMinutes(last.end) - timeToMinutes(last.start))
    const startMinutes = Math.min(23 * 60, timeToMinutes(last.end) + 10)
    timeDraft.push({ section: last.section + 1, start: minutesToTime(startMinutes), end: minutesToTime(Math.min(23 * 60 + 59, startMinutes + duration)) })
    render()
  })
  document.querySelector('[data-action="remove-lesson"]')?.addEventListener('click', () => {
    if (timeDraft.length > 1) timeDraft.pop()
    render()
  })
  document.querySelector('[data-action="restore-times"]')?.addEventListener('click', () => {
    timeDraft = structuredClone(defaultLessonTimes)
    timeEqualDuration = false
    render()
  })
  document.querySelector('[data-action="save-times"]')?.addEventListener('click', () => void saveTimes())
}

function applyEqualDuration(): void {
  const first = timeDraft[0]
  if (!first) return
  const duration = timeToMinutes(first.end) - timeToMinutes(first.start)
  if (duration <= 0) return
  timeDraft.forEach((item) => {
    item.end = minutesToTime(Math.min(23 * 60 + 59, timeToMinutes(item.start) + duration))
  })
}

function minutesToTime(total: number): string {
  const safe = clamp(total, 0, 23 * 60 + 59)
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`
}

async function saveTimes(): Promise<void> {
  try {
    for (const item of timeDraft) {
      if (!isValidClockTime(item.start) || !isValidClockTime(item.end)) throw new Error(`第 ${item.section} 节时间必须在 00:00～23:59 之间`)
      if (timeToMinutes(item.end) <= timeToMinutes(item.start)) throw new Error(`第 ${item.section} 节结束时间必须晚于开始时间`)
    }
    if (desktopRuntime) {
      settings = await invoke<AppSettings>('save_lesson_times', {
        request: { times: timeDraft, equalDuration: timeEqualDuration },
      })
    } else {
      settings = { ...settings, lessonTimes: structuredClone(timeDraft), equalDuration: timeEqualDuration }
    }
    surface = null
    render()
    showToast('作息时间已保存')
  } catch (error) {
    surfaceMessage = errorText(error)
    render()
  }
}

function bindDataEvents(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-edit-schedule]')) {
    button.addEventListener('click', () => void openScheduleEditor(button.dataset.editSchedule ?? ''))
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-activate-schedule]')) {
    button.addEventListener('click', () => void activateSchedule(button.dataset.activateSchedule ?? ''))
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-delete-schedule]')) {
    button.addEventListener('click', () => void deleteSchedule(button.dataset.deleteSchedule ?? ''))
  }
  document.querySelector('[data-action="open-data-location"]')?.addEventListener('click', () => void openDataLocation())
}
async function activateSchedule(id: string): Promise<void> {
  if (!id || !canLeaveCourse('切换课表')) return
  try {
    if (desktopRuntime) {
      schedule = await invoke<CatalogSchedule>(plugin('activate_schedule'), { scheduleId: id })
      summaries = await invoke<ScheduleSummary[]>(plugin('list_schedules'))
    }
    currentWeek = initialWeek(schedule)
    surface = null
    menuOpen = false
    scheduleMenuOpen = false
    render()
    showToast('已切换课表')
  } catch (error) {
    surfaceMessage = errorText(error)
    render()
  }
}

async function deleteSchedule(id: string): Promise<void> {
  const item = summaries.find((value) => value.id === id)
  if (!item || !window.confirm(`确定删除课表“${item.name}”吗？`)) return
  try {
    if (desktopRuntime) {
      schedule = await invoke<CatalogSchedule>(plugin('delete_schedule'), { scheduleId: id })
      summaries = await invoke<ScheduleSummary[]>(plugin('list_schedules'))
    }
    currentWeek = initialWeek(schedule)
    surface = 'data'
    scheduleDraft = null
    initialScheduleDraftSnapshot = ''
    render()
    showToast('课表已删除')
  } catch (error) {
    surfaceMessage = errorText(error)
    render()
  }
}

async function openDataLocation(): Promise<void> {
  try {
    if (!desktopRuntime) throw new Error('浏览器预览无法打开本机目录')
    await invoke(plugin('open_data_location'))
  } catch (error) {
    surfaceMessage = errorText(error)
    render()
  }
}

async function toggleAutostart(): Promise<void> {
  try {
    if (!desktopRuntime) {
      autostartEnabled = !autostartEnabled
    } else {
      autostartEnabled = await invoke<boolean>(plugin('set_autostart'), { enabled: !autostartEnabled })
    }
    render()
  } catch (error) {
    menuOpen = false
    render()
    showToast(errorText(error))
  }
}

async function reloadDesktopState(): Promise<void> {
  const [active, list, appSettings, startup] = await Promise.all([
    invoke<CatalogSchedule>(plugin('get_active_schedule')),
    invoke<ScheduleSummary[]>(plugin('list_schedules')),
    invoke<AppSettings>('read_app_settings'),
    invoke<boolean>(plugin('read_autostart')),
  ])
  schedule = active
  summaries = list
  settings = appSettings
  autostartEnabled = startup
  applyAppFontScale(settings.appFontScale)
  timeDraft = structuredClone(settings.lessonTimes)
  timeEqualDuration = settings.equalDuration
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return '未知错误'
  }
}

function showToast(message: string): void {
  const toast = document.querySelector<HTMLElement>('#toast')
  if (!toast) return
  toast.textContent = message
  toast.classList.add('is-visible')
  window.setTimeout(() => toast.classList.remove('is-visible'), 1800)
}

window.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null
  const typing = target?.matches('input, select, textarea') ?? false
  if (event.key === 'Escape' && surface) {
    closeSurface('explicit')
  } else if (event.key === 'Escape' && (scheduleMenuOpen || menuOpen)) {
    scheduleMenuOpen = false
    menuOpen = false
    render()
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
    event.preventDefault()
    openNewCourse()
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && surface === 'course') {
    event.preventDefault()
    void saveCourse()
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && surface === 'schedule') {
    event.preventDefault()
    void saveSchedule()
  }
  if (!typing && !event.ctrlKey && !event.metaKey && event.key === 'ArrowLeft') changeWeek(-1)
  if (!typing && !event.ctrlKey && !event.metaKey && event.key === 'ArrowRight') changeWeek(1)
})

async function handleSettingsCloseRequest(): Promise<void> {
  await requestSettingsWindowClose({
    hasUnsavedChanges,
    confirmDiscard: () => window.confirm('放弃未保存的修改？'),
    resetState: () => {
      surface = null
      menuOpen = false
      scheduleMenuOpen = false
      selectedCourseId = null
      courseDraft = null
      initialDraftSnapshot = ''
      scheduleDraft = null
      initialScheduleDraftSnapshot = ''
      surfaceMessage = ''
      render()
    },
    hideWindow: () => invoke('hide_settings_window'),
  })
}

async function initialize(): Promise<void> {
  render()
  if (!desktopRuntime) return
  try {
    await listen('settings:close-requested', () => {
      void handleSettingsCloseRequest()
    })
    await reloadDesktopState()
    currentWeek = initialWeek(schedule)
  } catch (error) {
    console.error('[settings] initialization failed', error)
    showToast(`读取课表失败：${errorText(error)}`)
  }
  render()
}

void initialize()
