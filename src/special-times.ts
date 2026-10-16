export type SpecialScheduleRule = {
  keywords: string[]
  sectionStart: string
  sectionEnd: string
  actualStart: string
  actualEnd: string
  color: string
}

// 默认规则：湖光校区广学楼/明德楼第2、4大节连续上课，无课间休息
export const defaultSpecialScheduleRules: SpecialScheduleRule[] = [
  {
    keywords: ['广学楼', '明德楼'],
    sectionStart: '10:15',
    sectionEnd: '11:50',
    actualStart: '10:05',
    actualEnd: '11:35',
    color: '#101826',
  },
  {
    keywords: ['广学楼', '明德楼'],
    sectionStart: '16:30',
    sectionEnd: '18:05',
    actualStart: '16:25',
    actualEnd: '17:55',
    color: '#101826',
  },
]

// lessonStart 为课表上该课程所在节次的开始时间（已按作息映射）。
// 地点含任一关键词且节次时间落在规则区间内时返回规则。
export function matchSpecialRule(
  rules: SpecialScheduleRule[] | undefined,
  location: string | undefined,
  lessonStart: string,
): SpecialScheduleRule | null {
  if (!rules || rules.length === 0 || !location) return null
  for (const rule of rules) {
    if (!rule.keywords.some((keyword) => location.includes(keyword))) continue
    if (lessonStart >= rule.sectionStart && lessonStart < rule.sectionEnd) return rule
  }
  return null
}
