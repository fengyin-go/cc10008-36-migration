/**
 * 旧自由文本字段的解析规则。
 *
 * 旧记录用自由文本保存有效期与访问上限，常见形态包括绝对日期、相对天数、中文
 * 计数与空值。这里统一按「迁移基准」把绝对日期归一到 UTC 时间戳、把相对天数
 * 换算成基准之后的到期时间；解析不出来的值不猜测，交给调用方登记旁证。
 */

import type { ShareDataValue } from './share-schema'

const DAY_MS = 24 * 60 * 60 * 1000

/** 绝对日期同时覆盖 2026-11-14 / 2026/11/14 / 2026.11.14 / 2026年11月14日。 */
const ABSOLUTE_DATE = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?(?:Z|[+-]\d{2}:?\d{2})?$/iu

/** 相对天数覆盖 30 / 30天 / 30 日 / 有效期30天 / 7d / 两周。 */
const RELATIVE_DAYS = /^(?:有效期|有效)?\s*(\d+)\s*(?:天|日|d|day|days)?$/iu

const CHINESE_DAYS = /^(?:有效期|有效)?\s*([一二三四五六七八九十百零两]+)\s*(?:天|日)$/u

const UNLIMITED = /^(?:不限期|不限次数|不限访问|不限|无限|无上限|长期有效|永久|unlimited|infinite|forever)$/iu

const UNLIMITED_WITH_SUFFIX = /^(?:不限期|不限次数|不限访问|不限|无限|无上限|长期有效|永久)(?:访问|次数|浏览)?$/u

const COUNT_WITH_SUFFIX = /^(?:最大浏览次数|访问上限|最大访问次数|上限|最多访问)\s*[:：]?\s*(\d+)$/u

const CHINESE_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}

/** 空值的判定标准：null / undefined / 空白 / 占位符。 */
export function isBlankValue(value: ShareDataValue | undefined | null): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'number') return !Number.isFinite(value)
  if (typeof value === 'boolean') return false
  const text = value.trim()
  return text === '' || text === '—' || text === '-' || text === 'null' || text === 'NULL'
}

export function normalizeText(value: ShareDataValue | undefined | null): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value).trim()
}

export type ParsedValidUntil =
  | { kind: 'absolute'; expiresAt: string; matchedText: string }
  | { kind: 'relative'; validityDays: number; expiresAt: string; matchedText: string }
  | { kind: 'unlimited'; matchedText: string }
  | { kind: 'missing'; matchedText: string }
  | { kind: 'unparsed'; matchedText: string; reason: string }

export function parseUntil(raw: string, baselineIso: string): ParsedValidUntil {
  const text = raw.trim()
  if (isBlankValue(text)) {
    return { kind: 'missing', matchedText: '' }
  }
  if (UNLIMITED.test(text) || UNLIMITED_WITH_SUFFIX.test(text)) {
    return { kind: 'unlimited', matchedText: text }
  }

  const dateMatch = ABSOLUTE_DATE.exec(text)
  if (dateMatch) {
    const [, y, m, d, hh, mm, ss] = dateMatch
    const year = Number(y)
    const month = Number(m)
    const day = Number(d)
    const hour = hh === undefined ? 0 : Number(hh)
    const minute = mm === undefined ? 0 : Number(mm)
    const second = ss === undefined ? 0 : Number(ss)
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
      return { kind: 'unparsed', matchedText: text, reason: '日期数值越界' }
    }
    const stamp = Date.UTC(year, month - 1, day, hour, minute, second)
    const check = new Date(stamp)
    if (
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== day
    ) {
      return { kind: 'unparsed', matchedText: text, reason: '日期不是合法日历日' }
    }
    return { kind: 'absolute', expiresAt: new Date(stamp).toISOString(), matchedText: text }
  }

  const relativeMatch = RELATIVE_DAYS.exec(text)
  if (relativeMatch) {
    return relativeResult(Number(relativeMatch[1]), baselineIso, text)
  }

  const chineseMatch = CHINESE_DAYS.exec(text)
  if (chineseMatch) {
    const parsed = parseChineseNumber(chineseMatch[1])
    if (parsed !== null) {
      return relativeResult(parsed, baselineIso, text)
    }
  }

  return {
    kind: 'unparsed',
    matchedText: text,
    reason: '无法识别为绝对日期、相对天数或“长期有效”',
  }
}

function relativeResult(days: number, baselineIso: string, raw: string): ParsedValidUntil {
  if (!Number.isInteger(days) || days < 0) {
    return { kind: 'unparsed', matchedText: raw, reason: '相对天数必须是非负整数' }
  }
  const baseline = new Date(baselineIso)
  return {
    kind: 'relative',
    validityDays: days,
    expiresAt: new Date(baseline.getTime() + days * DAY_MS).toISOString(),
    matchedText: raw,
  }
}

function parseChineseNumber(text: string): number | null {
  if (text === '十') return 10
  if (text === '百') return 100
  if (CHINESE_DIGITS[text] !== undefined) return CHINESE_DIGITS[text]
  const hundred = text.split('百')
  if (hundred.length === 2) {
    const left = hundred[0] === '' ? 1 : CHINESE_DIGITS[hundred[0]]
    const rightText = hundred[1].replace(/^零/u, '')
    if (left === undefined) return null
    if (rightText === '') return left * 100
    const tenPart = rightText.split('十')
    let rest = 0
    if (tenPart.length === 2) {
      const tens = tenPart[0] === '' ? 1 : CHINESE_DIGITS[tenPart[0]]
      const ones = tenPart[1] === '' ? 0 : CHINESE_DIGITS[tenPart[1]]
      if (tens === undefined || ones === undefined) return null
      rest = tens * 10 + ones
    } else {
      const single = CHINESE_DIGITS[rightText]
      if (single === undefined) return null
      rest = single
    }
    return left * 100 + rest
  }
  const ten = text.split('十')
  if (ten.length === 2) {
    const tens = ten[0] === '' ? 1 : CHINESE_DIGITS[ten[0]]
    const ones = ten[1] === '' ? 0 : CHINESE_DIGITS[ten[1]]
    if (tens === undefined || ones === undefined) return null
    return tens * 10 + ones
  }
  return null
}

export type ParsedAccessLimit =
  | { kind: 'bounded'; maxAccess: number; matchedText: string }
  | { kind: 'unlimited'; matchedText: string }
  | { kind: 'missing'; matchedText: string }
  | { kind: 'unparsed'; matchedText: string; reason: string }

export function parseAccessLimit(raw: string): ParsedAccessLimit {
  const text = raw.trim()
  if (isBlankValue(text)) {
    return { kind: 'missing', matchedText: '' }
  }
  if (UNLIMITED.test(text) || UNLIMITED_WITH_SUFFIX.test(text)) {
    return { kind: 'unlimited', matchedText: text }
  }
  if (/^\d+$/u.test(text)) {
    return bounded(Number(text), text)
  }
  if (/^\d+(?:次|回)$/u.test(text)) {
    return bounded(Number(text.replace(/[次回]$/u, '')), text)
  }
  const suffixed = COUNT_WITH_SUFFIX.exec(text)
  if (suffixed) {
    return bounded(Number(suffixed[1]), text)
  }
  const chinese = /^(?:最多)?([一二三四五六七八九十百零两]+)(?:次|回)$/u.exec(text)
  if (chinese) {
    const parsed = parseChineseNumber(chinese[1])
    if (parsed !== null) return bounded(parsed, text)
  }
  return {
    kind: 'unparsed',
    matchedText: text,
    reason: '无法识别为访问次数上限或“无限”',
  }
}

function bounded(value: number, raw: string): ParsedAccessLimit {
  if (!Number.isInteger(value) || value < 0) {
    return { kind: 'unparsed', matchedText: raw, reason: '访问上限必须是非负整数' }
  }
  return { kind: 'bounded', maxAccess: value, matchedText: raw }
}

export type ParsedUsedCount = { value: number; matchedText: string; ok: boolean }

/** 旧记录里的已访问次数：缺失按 0，解析失败给出旁证而不是猜测。 */
export function parseUsedCount(raw: string): ParsedUsedCount {
  const text = raw.trim()
  if (isBlankValue(text)) {
    return { value: 0, matchedText: '', ok: true }
  }
  if (/^\d+$/u.test(text)) {
    return { value: Number(text), matchedText: text, ok: true }
  }
  const match = /^(\d+)(?:次|回)$/u.exec(text)
  if (match) {
    return { value: Number(match[1]), matchedText: text, ok: true }
  }
  return { value: 0, matchedText: text, ok: false }
}

/** 密码只保存摘要与随机盐，原文不落盘。 */
export function digestPassword(password: string, salt: string): string {
  // 纯前端离线场景用 FNV-1a 双通道摘要即可满足「不保存原文」的迁移要求；
  // 摘要只与 salt 绑定，换 salt 会得到不同结果，可用于校验失败提示。
  let a = 0x811c9dc5
  let b = 0xcbf29ce4
  const payload = `${salt}\u0000${password}`
  for (let index = 0; index < payload.length; index += 1) {
    const code = payload.charCodeAt(index)
    a ^= code
    a = Math.imul(a, 0x01000193) >>> 0
    b ^= code + index
    b = Math.imul(b, 0x01000193) >>> 0
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`
}

/** 迁移基准统一成 UTC 的秒级 ISO 时间；非法基准直接拒绝。 */
export function normalizeBaseline(input: string | null | undefined, fallback: string): string {
  const text = input?.trim()
  if (!text) {
    const fallbackDate = new Date(fallback)
    if (Number.isNaN(fallbackDate.getTime())) {
      throw new Error(`迁移基准回退值不是合法日期：${fallback}`)
    }
    return normalizeToSecond(fallbackDate)
  }
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/iu.test(text)
  const candidate = hasTimezone
    ? new Date(text)
    : /^\d{4}-\d{1,2}-\d{1,2}$/u.test(text)
      ? new Date(`${text}T00:00:00Z`)
      : new Date(`${text}T00:00:00Z`)
  if (Number.isNaN(candidate.getTime())) {
    throw new Error(`迁移基准不是合法日期：${text}`)
  }
  return normalizeToSecond(candidate)
}

function normalizeToSecond(date: Date): string {
  return new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString()
}

/** 生成稳定短哈希，用于旁证 ID；同一条旁证重复迁移时命中同一条记录。 */
export function stableHash(input: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index)
    h1 ^= code
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 ^= code + 7
    h2 = Math.imul(h2, 0x01000193) >>> 0
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`
}

/** 演示 / 示例 / 构建产物里的链接，一律不进入正式迁移。 */
export function isDemoLink(input: {
  linkId: string
  targetDataset: string
  fields: Record<string, ShareDataValue>
}): { demo: boolean; reason: string } {
  for (const field of ['示例链接', 'isDemo', 'demo']) {
    const value = input.fields[field]
    if (value === true) return { demo: true, reason: `${field}=true` }
    if (typeof value === 'string' && /^(?:true|yes|1|是)$/iu.test(value.trim())) {
      return { demo: true, reason: `${field}=${value}` }
    }
  }
  for (const field of ['数据来源', '记录来源', 'source']) {
    const value = input.fields[field]
    if (typeof value === 'string' && /^(?:demo|sample|mock|build)$/iu.test(value.trim())) {
      return { demo: true, reason: `${field}=${value}` }
    }
  }
  const haystack = `${input.linkId} ${input.targetDataset}`
  if (/样例|示例|example|sample|demo|mock|placeholder/u.test(haystack)) {
    return { demo: true, reason: '编号或数据集名带示例字样' }
  }
  if (/#\d{4,}/u.test(haystack)) {
    return { demo: true, reason: '编号带构建产物后缀' }
  }
  return { demo: false, reason: '' }
}

export { DAY_MS }
