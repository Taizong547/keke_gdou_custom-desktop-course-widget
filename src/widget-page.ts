import './style.css'
import './widget-page.css'
import './course-handoff.css'
import './time-flow.css'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import {
  PRESENTATION_COMMAND_EVENT,
  PRESENTATION_STATUS_EVENT,
  PRESENTATION_STATUS_REQUEST_EVENT,
  type PresentationCommand,
  type PresentationStatus,
} from './presentation-events'
import { PresentationClock, type ReplayConfig, type ReplaySnapshot } from './presentation-clock'
import { enhanceTimeFlow } from './time-flow'
import {
  courseIdentityKey,
  syncStableWidget,
  transitionCourse,
  type CourseHandoffHandle,
} from './course-handoff'
import { clearActiveSchedule, createWidget, defaultOptions, setActiveSchedule, setSpecialRules, type ScheduleSource, type WidgetOptions } from './widget'

const app = document.querySelector<HTMLDivElement>('#app')!
const scenarioByQuery: Record<string, WidgetOptions['scenario']> = {
  current: 'current',
  between: 'between',
  finished: 'ended',
  'no-course': 'empty',
  'before-semester': 'before',
  browsing: 'browsing',
}
const desktopRuntime = isTauri()
const query = new URLSearchParams(window.location.search)
const debugLiveRuntime = import.meta.env.DEV && !desktopRuntime && query.get('runtime') === 'live'
const requestedScenario = import.meta.env.DEV && !desktopRuntime && !debugLiveRuntime
  ? query.get('scenario')
  : null
const options: WidgetOptions = {
  ...defaultOptions,
  runtime: desktopRuntime || debugLiveRuntime ? 'live' : 'prototype',
  scenario: requestedScenario ? scenarioByQuery[requestedScenario] ?? defaultOptions.scenario : defaultOptions.scenario,
  dragRegion: true,
  closeControl: desktopRuntime,
}

const COURSE_TRANSITION_SETTLE_MS = 420
const presentationClock = new PresentationClock()
let presentationFrame: number | undefined
let minuteTimeout: number | undefined
let minuteInterval: number | undefined
let transitionTimer: number | undefined
let transitionToken = 0
let transitionActive = false
let activeHandoff: CourseHandoffHandle | undefined
let lastPresentationMinute = Number.NaN
let lastPublishedPercent = -1
let presentationMessage = '演示只改变课刻画面，不会修改系统时间或课表数据。'
let ballMode = true
let ballTimer: number | undefined
let presentationRestore: Pick<WidgetOptions, 'showNav' | 'closeControl' | 'browseDate'> | null = null

function buildWidget() {
  return enhanceTimeFlow(createWidget(options, renderWidget, collapseToBall), options)
}

function releaseCourseTransitionWindow() {
  document.documentElement.classList.remove('is-course-transitioning')
  window.dispatchEvent(new Event('course-transition:complete'))
}

function clearCourseTransition() {
  transitionToken += 1
  if (transitionTimer !== undefined) window.clearTimeout(transitionTimer)
  transitionTimer = undefined
  activeHandoff?.cancel('target')
  activeHandoff = undefined
  transitionActive = false
  releaseCourseTransitionWindow()
}

function presentationPlayingMessage(prefix = '演示播放中') {
  const speed = presentationClock.currentConfig()?.minutesPerSecond
  return speed
    ? `${prefix} · ${speed} 分钟/秒。课程交接时会自动停表。`
    : `${prefix}。课程交接时会自动停表。`
}

function finishCourseTransition(token: number, resumeAfterTransition: boolean) {
  if (token !== transitionToken) return
  transitionTimer = window.setTimeout(() => {
    if (token !== transitionToken) return
    transitionTimer = undefined
    transitionActive = false
    releaseCourseTransitionWindow()

    const timestamp = performance.now()
    const current = presentationClock.snapshot(timestamp)
    if (resumeAfterTransition && current.active && !current.finished) {
      const resumed = presentationClock.resume(timestamp)
      presentationMessage = presentationPlayingMessage()
      publishPresentationStatus(resumed, true)
      clearPresentationFrame()
      presentationFrame = window.requestAnimationFrame(presentationTick)
      return
    }

    presentationMessage = current.finished ? '回放完成。' : '演示已暂停。'
    publishPresentationStatus(current, true)
  }, COURSE_TRANSITION_SETTLE_MS)
}

function renderWidget(allowTransition = true, timestamp = performance.now()): boolean {
  const nextWidget = buildWidget()
  const currentWidget = app.querySelector<HTMLElement>('.course-widget')
  const courseChanged = courseIdentityKey(currentWidget) !== courseIdentityKey(nextWidget)

  if (currentWidget && !courseChanged) {
    syncStableWidget(currentWidget, nextWidget)
    return false
  }

  const shouldAnimate = allowTransition
    && !transitionActive
    && presentationClock.isActive()
    && courseChanged
    && Boolean(currentWidget)
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches

  if (!shouldAnimate || !currentWidget) {
    if (!currentWidget) {
      nextWidget.classList.add('is-initial-mount')
      window.setTimeout(() => nextWidget.classList.remove('is-initial-mount'), 520)
    }
    app.replaceChildren(nextWidget)
    return false
  }

  const resumeAfterTransition = presentationClock.isPlaying()
  const frozen = resumeAfterTransition
    ? presentationClock.pause(timestamp)
    : presentationClock.snapshot(timestamp)
  transitionActive = true
  presentationMessage = '课程正在交接，演示时间已暂停。'
  document.documentElement.classList.add('is-course-transitioning')
  const token = ++transitionToken
  publishPresentationStatus(frozen, true)

  const handoff = transitionCourse({
    host: app,
    currentWidget,
    nextWidget,
    durationScale: 1,
    reducedMotion: false,
  })
  activeHandoff = handoff
  void handoff.finished.then((result) => {
    if (token !== transitionToken) return
    activeHandoff = undefined
    if (result.status === 'failed') console.error('[presentation] course handoff failed', result.error)
    finishCourseTransition(token, resumeAfterTransition)
  })
  return true
}

function clearClockTimers() {
  if (minuteTimeout !== undefined) window.clearTimeout(minuteTimeout)
  if (minuteInterval !== undefined) window.clearInterval(minuteInterval)
  minuteTimeout = undefined
  minuteInterval = undefined
}

function clearBallTimer() {
  if (ballTimer !== undefined) window.clearInterval(ballTimer)
  ballTimer = undefined
}

function renderBall(): void {
  clearBallTimer()
  clearClockTimers()
  document.documentElement.classList.add('widget-ball-active')
  const now = new Date()
  const timeText = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  const weekdayText = `周${'日一二三四五六'[now.getDay()]}`
  app.innerHTML = `
    <button type="button" class="widget-ball" data-ball-open aria-label="课刻-广东海洋大学定制版悬浮球，点击展开课表" title="点击展开课表">
      <span class="widget-ball-time">${timeText}</span>
      <span class="widget-ball-weekday">${weekdayText}</span>
    </button>
  `
  const ballButton = document.querySelector<HTMLButtonElement>('[data-ball-open]')
  if (ballButton) {
    let dragStartX = 0
    let dragStartY = 0
    let didDrag = false
    let captureHeld = false
    let dragPointerId = -1
    ballButton.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      dragStartX = event.clientX
      dragStartY = event.clientY
      didDrag = false
      dragPointerId = event.pointerId
      // 捕获指针：鼠标移出悬浮球边缘后仍持续收到 pointermove
      try {
        ballButton.setPointerCapture(event.pointerId)
        captureHeld = true
      } catch { captureHeld = false }
    })
    ballButton.addEventListener('pointermove', (event) => {
      if (event.buttons !== 1 || didDrag) return
      const dx = event.clientX - dragStartX
      const dy = event.clientY - dragStartY
      if (dx * dx + dy * dy > 25) {
        didDrag = true
        void invoke('start_main_widget_drag').catch((error: unknown) =>
          console.error('[widget-ball] drag failed', error),
        )
      }
    })
    ballButton.addEventListener('pointerup', () => {
      if (captureHeld) {
        try { ballButton.releasePointerCapture(dragPointerId) } catch { /* ignore */ }
        captureHeld = false
      }
    })
    ballButton.addEventListener('click', (event) => {
      if (didDrag) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (!desktopRuntime) return
      // Expand: release the ball window first, then let desktop-shell resume sizing.
      ballMode = false
      document.documentElement.classList.remove('widget-ball-active')
      document.documentElement.classList.add('widget-expanding')
      window.setTimeout(() => document.documentElement.classList.remove('widget-expanding'), 500)
      app.innerHTML = ''
      void invoke('set_main_widget_mode', { ballMode: false })
        .catch((error: unknown) => console.error('[widget-ball] expand failed', error))
    })
  }
  ballTimer = window.setInterval(() => {
    const latest = new Date()
    const label = latest.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
    const weekday = `周${'日一二三四五六'[latest.getDay()]}`
    const timeNode = app.querySelector<HTMLElement>('.widget-ball-time')
    const weekdayNode = app.querySelector<HTMLElement>('.widget-ball-weekday')
    if (timeNode) timeNode.textContent = label
    if (weekdayNode) weekdayNode.textContent = weekday
  }, 60_000)
}

async function collapseToBall(): Promise<void> {
  if (!desktopRuntime) return
  renderBall()
  try {
    await invoke('set_main_widget_mode', { ballMode: true })
  } catch (error) {
    console.error('[widget-ball] collapse failed', error)
  }
}

function renderWidgetAppearance(): void {
  clearBallTimer()
  if (ballMode) {
    renderBall()
    return
  }
  document.documentElement.classList.remove('widget-ball-active')
  options.showBallToggle = desktopRuntime
  syncLiveWidget()
}

function clearPresentationFrame() {
  if (presentationFrame !== undefined) window.cancelAnimationFrame(presentationFrame)
  presentationFrame = undefined
}

function formatPresentationTime(date: Date) {
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function presentationStatus(snapshot?: ReplaySnapshot): PresentationStatus {
  const current = snapshot ?? (presentationClock.isActive() ? presentationClock.snapshot(performance.now()) : undefined)
  return {
    active: Boolean(current?.active),
    playing: Boolean(current?.playing),
    transitioning: transitionActive,
    finished: Boolean(current?.finished),
    progress: current?.progress ?? 0,
    time: current ? formatPresentationTime(current.date) : '',
    message: presentationMessage,
  }
}

function publishPresentationStatus(snapshot?: ReplaySnapshot, force = false) {
  if (!desktopRuntime) return
  const status = presentationStatus(snapshot)
  const percent = Math.round(status.progress * 100)
  if (!force && percent === lastPublishedPercent) return
  lastPublishedPercent = percent
  void emit(PRESENTATION_STATUS_EVENT, status)
}

function applyPresentationSnapshot(
  snapshot: ReplaySnapshot,
  force = false,
  timestamp = performance.now(),
  allowTransition = true,
): boolean {
  options.now = snapshot.date
  const minute = Math.floor(snapshot.date.getTime() / 60_000)
  if (force || minute !== lastPresentationMinute) {
    lastPresentationMinute = minute
    if (renderWidget(allowTransition, timestamp)) return true
  }
  publishPresentationStatus(snapshot, force)
  return false
}

function presentationTick(timestamp: number) {
  if (transitionActive) return
  const snapshot = presentationClock.snapshot(timestamp)
  const transitionStarted = applyPresentationSnapshot(snapshot, false, timestamp, true)
  if (transitionStarted) {
    presentationFrame = undefined
    return
  }
  if (snapshot.playing) {
    presentationFrame = window.requestAnimationFrame(presentationTick)
  } else {
    presentationFrame = undefined
    applyPresentationSnapshot(snapshot, true, timestamp, true)
  }
}

function startPresentation(config: ReplayConfig) {
  if (options.runtime !== 'live') return
  try {
    clearCourseTransition()
    const snapshot = presentationClock.start(config, performance.now())
    if (!presentationRestore) {
      presentationRestore = { showNav: options.showNav, closeControl: options.closeControl, browseDate: options.browseDate }
    }
    options.showNav = false
    options.closeControl = false
    options.browseDate = undefined
    presentationMessage = presentationPlayingMessage()
    document.documentElement.classList.add('is-presentation-replay')
    clearClockTimers()
    clearPresentationFrame()
    lastPresentationMinute = Number.NaN
    lastPublishedPercent = -1
    applyPresentationSnapshot(snapshot, true, performance.now(), false)
    presentationFrame = window.requestAnimationFrame(presentationTick)
  } catch (error) {
    presentationMessage = error instanceof Error ? error.message : String(error)
    publishPresentationStatus(undefined, true)
  }
}

function togglePresentation() {
  if (!presentationClock.isActive() || transitionActive) return
  try {
    const snapshot = presentationClock.toggle(performance.now())
    presentationMessage = snapshot.playing ? presentationPlayingMessage() : '演示已暂停。'
    clearPresentationFrame()
    applyPresentationSnapshot(snapshot, true, performance.now(), false)
    if (snapshot.playing) presentationFrame = window.requestAnimationFrame(presentationTick)
  } catch (error) {
    presentationMessage = error instanceof Error ? error.message : String(error)
    publishPresentationStatus(undefined, true)
  }
}

function setPresentationSpeed(minutesPerSecond: number) {
  if (!presentationClock.isActive() || transitionActive) return
  try {
    const snapshot = presentationClock.setSpeed(minutesPerSecond, performance.now())
    presentationMessage = presentationPlayingMessage('流速已调整')
    publishPresentationStatus(snapshot, true)
  } catch (error) {
    presentationMessage = error instanceof Error ? error.message : String(error)
    publishPresentationStatus(undefined, true)
  }
}

function restartPresentation() {
  if (!presentationClock.isActive()) return
  clearCourseTransition()
  const snapshot = presentationClock.restart(performance.now())
  presentationMessage = presentationPlayingMessage('演示已重播')
  clearPresentationFrame()
  lastPresentationMinute = Number.NaN
  lastPublishedPercent = -1
  applyPresentationSnapshot(snapshot, true, performance.now(), false)
  presentationFrame = window.requestAnimationFrame(presentationTick)
}

function stopPresentation() {
  clearCourseTransition()
  if (!presentationClock.isActive()) {
    publishPresentationStatus(undefined, true)
    return
  }
  presentationClock.stop()
  clearPresentationFrame()
  options.now = undefined
  if (presentationRestore) {
    options.showNav = presentationRestore.showNav
    options.closeControl = presentationRestore.closeControl
    options.browseDate = presentationRestore.browseDate
  }
  presentationRestore = null
  lastPresentationMinute = Number.NaN
  lastPublishedPercent = -1
  presentationMessage = '已恢复真实时间。'
  document.documentElement.classList.remove('is-presentation-replay')
  syncLiveWidget()
  publishPresentationStatus(undefined, true)
}

function handlePresentationCommand(command: PresentationCommand) {
  if (command.type === 'start') startPresentation(command.config)
  if (command.type === 'set-speed') setPresentationSpeed(command.minutesPerSecond)
  if (command.type === 'toggle') togglePresentation()
  if (command.type === 'restart') restartPresentation()
  if (command.type === 'stop') stopPresentation()
}

async function openPresentationController() {
  if (!desktopRuntime) return
  try {
    await invoke('open_presentation_controller')
    publishPresentationStatus(undefined, true)
  } catch (error) {
    console.error('[presentation] controller window is unavailable', error)
  }
}

function syncLiveWidget() {
  if (options.runtime !== 'live') return
  if (ballMode) {
    renderBall()
    return
  }
  if (presentationClock.isActive()) {
    if (transitionActive) {
      publishPresentationStatus(undefined, true)
      return
    }
    applyPresentationSnapshot(presentationClock.snapshot(performance.now()), true, performance.now(), false)
    return
  }
  options.now = undefined
  renderWidget(false)
  clearClockTimers()
  const now = new Date()
  const untilNextMinute = 60_000 - now.getSeconds() * 1_000 - now.getMilliseconds()
  minuteTimeout = window.setTimeout(() => {
    renderWidget(false)
    minuteInterval = window.setInterval(() => renderWidget(false), 60_000)
  }, untilNextMinute)
}

function applyWidgetOpacity(opacity: number): void {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(opacity) ? opacity : 1))
  document.documentElement.style.opacity = String(clamped)
}

type AppSettingsSnapshot = {
  onboardingCompleted: boolean
  ballMode: boolean
  widgetOpacity: number
  widgetTheme: string
  widgetBackground: string
  widgetRadius: number
  widgetFontScale: number
  lessonTimes: Array<{ start: string; end: string }>
  specialScheduleRules: Array<{ keywords: string[]; sectionStart: string; sectionEnd: string; actualStart: string; actualEnd: string; color: string }>
}

function applyWidgetStyle(style: { theme: string; background: string; radius: number; fontScale: number }): void {
  options.theme = style.theme === 'dark' ? 'dark' : 'light'
  options.scale = Number.isFinite(style.fontScale) && style.fontScale > 0 ? style.fontScale : 1
  const root = document.documentElement
  root.classList.remove('widget-bg-blue', 'widget-bg-light', 'widget-bg-dark', 'widget-bg-colorful')
  root.classList.add(`widget-bg-${style.background}`)
  const radius = Number.isFinite(style.radius) ? style.radius : 22
  root.style.setProperty('--widget-radius', `${radius}px`)
  renderWidgetAppearance()
}

async function startDesktopWidget() {
  const { startDesktopShell } = await import('./desktop-shell')
  // 卡片高度 = 窗口高度 - #app 上下 padding 32px
  const syncCardHeight = () => {
    const h = window.outerHeight || document.documentElement.clientHeight || 400
    document.documentElement.style.setProperty('--card-height', `${Math.max(180, h - 32)}px`)
  }
  window.addEventListener('resize', syncCardHeight)
  const refreshSchedule = async () => {
    try {
      const sched = await invoke<ScheduleSource>('read_schedule')
      // 按作息时间重新映射课程的 start/end，保持组件与课表一致
      try {
        const appSettings = await invoke<AppSettingsSnapshot>('read_app_settings')
        const times = appSettings.lessonTimes
        setSpecialRules(appSettings.specialScheduleRules ?? [])
        if (times && times.length > 0) {
          const toMin = (t: string) => {
            const [h, m] = t.split(':').map(Number)
            return h * 60 + m
          }
          sched.courses = sched.courses.map((course) => {
            const startMin = toMin(course.start)
            const endMin = toMin(course.end)
            let startIdx = times.findIndex((t) => toMin(t.start) >= startMin)
            if (startIdx < 0) startIdx = 0
            let endIdx = times.findIndex((t) => toMin(t.end) >= endMin)
            if (endIdx < 0) endIdx = times.length - 1
            if (endIdx < startIdx) endIdx = startIdx
            // 单节课程扩展为两大节（与课表一致），保证跨时段课程显示完整时间
            if (endIdx < startIdx + 1) endIdx = Math.min(startIdx + 1, times.length - 1)
            return {
              ...course,
              start: times[startIdx].start,
              end: times[endIdx].end,
            }
          })
        }
      } catch {
        // 读取 settings 失败时用原始课程时间
      }
      setActiveSchedule(sched)
    } catch (error) {
      clearActiveSchedule()
      console.error('[widget] schedule load failed', error)
    }
    syncLiveWidget()
  }
  let shellStarted = false
  const startShellOnce = async () => {
    if (shellStarted) return
    shellStarted = true
    await startDesktopShell(app)
  }

  await listen('schedule:updated', refreshSchedule)
  await listen('widget:shown', () => {
    syncCardHeight()
    syncLiveWidget()
  })
  await listen<number>('widget:opacity-changed', ({ payload }) => {
    applyWidgetOpacity(payload)
  })
  await listen<{ theme: string; background: string; radius: number; fontScale: number }>('widget:style-changed', ({ payload }) => {
    applyWidgetStyle(payload)
  })
  await listen<boolean>('widget:mode-changed', ({ payload }) => {
    ballMode = payload
    if (ballMode) {
      renderBall()
    } else {
      document.documentElement.classList.remove('widget-ball-active')
      syncCardHeight()
      void startShellOnce().then(() => renderWidgetAppearance())
    }
  })
  await listen<PresentationCommand>(PRESENTATION_COMMAND_EVENT, ({ payload }) => handlePresentationCommand(payload))
  await listen(PRESENTATION_STATUS_REQUEST_EVENT, () => publishPresentationStatus(undefined, true))
  await listen('onboarding:completed', async () => {
    await refreshSchedule()
    await startShellOnce()
  })
  await refreshSchedule()

  try {
    const settings = await invoke<AppSettingsSnapshot>('read_app_settings')
    ballMode = settings.ballMode
    applyWidgetOpacity(settings.widgetOpacity)
    if (settings.widgetTheme || settings.widgetBackground) {
      applyWidgetStyle({
        theme: settings.widgetTheme,
        background: settings.widgetBackground,
        radius: settings.widgetRadius,
        fontScale: settings.widgetFontScale,
      })
    }
    if (settings.onboardingCompleted) {
      syncCardHeight()
      renderWidgetAppearance()
      await startShellOnce()
    }
  } catch (error) {
    console.error('[widget] settings load failed', error)
    await startShellOnce()
    renderWidgetAppearance()
  }
}

document.addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.shiftKey && event.code === 'KeyD') {
    event.preventDefault()
    void openPresentationController()
    return
  }
  if (!presentationClock.isActive()) return
  if (event.code === 'Space') {
    event.preventDefault()
    togglePresentation()
  }
  if (event.code === 'Escape') {
    event.preventDefault()
    stopPresentation()
  }
})

if (options.runtime === 'live') {
  if (!desktopRuntime) syncLiveWidget()
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) syncLiveWidget()
  })
  window.addEventListener('focus', syncLiveWidget)
  window.addEventListener('beforeunload', () => {
    clearClockTimers()
    clearBallTimer()
    clearPresentationFrame()
    clearCourseTransition()
  })
  if (desktopRuntime) void startDesktopWidget().catch((error: unknown) => console.error('[widget] desktop startup failed', error))
} else {
  renderWidget(false)
}
