/**
 * 数据分享迁移后的「数据库结构」。
 *
 * 纯前端应用没有真实数据库，localStorage 里的这份 JSON 文档就是持久化结构。
 * 结构按逻辑表拆成四部分，写入时作为同一个文档一次落盘，保证单条链接迁移的
 * 凭证、旁证与断点信息不会出现半写状态：
 *
 *   migrations  迁移断点 / 基准时间 / 进度
 *   credentials 带版本凭证（一个链接可保留多个版本）
 *   audits      解析失败与迁移动作的旁证
 *   legacyAccess 迁移完成前旧链接的访问计数（迁移时并入凭证，不会被清零）
 */

import type { EntryRow } from './types'

export const SHARE_SCHEMA_VERSION = 1
export const SHARE_CREDENTIAL_FORMAT_VERSION = 1

/** 未配置迁移基准时的兜底值。生产环境必须在构建时显式配置。 */
export const SHARE_FALLBACK_BASELINE = '2026-01-01T00:00:00.000Z'

/** localStorage 文档键；版本号在键名和文档内各保留一份，便于后续升级。 */
export const SHARE_STORE_KEY = 'interactive-analytics-lab:share:v1'

/** 旧记录中与分享业务相关的字段别名。迁移只读取这些字段，不改写原记录。 */
export const SHARE_FIELD_ALIASES = {
  linkId: ['链接编号', '分享编号', 'linkId'],
  targetDataset: ['目标数据集', '数据集', 'targetDataset'],
  password: ['访问密码', '密码', 'password'],
  validity: ['有效期天数', '有效期', '有效期至', '到期时间', 'validity', 'expiresAt'],
  maxAccess: ['最大浏览次数', '访问上限', '最大访问次数', 'maxAccess', 'maxViews'],
  usedCount: ['已浏览次数', '已访问次数', '访问次数', 'usedCount', 'used'],
  watermark: ['水印内容', '水印', 'watermark'],
  userIdentifier: ['用户标识', '旧用户标识', '分享人', '创建人', 'userId', 'user'],
  generatedAt: [
    '分享快照生成时间',
    '生成时间',
    '分享时间',
    '创建时间',
    'snapshotGeneratedAt',
    'createdAt',
  ],
  downloadEnabled: ['下载开关', 'downloadEnabled'],
  autoCleanup: ['过期自动清理', 'autoCleanup'],
  source: ['数据来源', '记录来源', 'source'],
  demo: ['示例链接', 'isDemo', 'demo'],
} as const

export type ShareMigrationStatus = 'idle' | 'running' | 'completed' | 'failed'

export type ShareBaselineSource = 'option' | 'env' | 'persisted' | 'fallback'

export type ShareValidityKind =
  | 'absolute'
  | 'relative'
  | 'unlimited'
  | 'missing'
  | 'unparsed'

export type ShareAccessLimitKind =
  | 'bounded'
  | 'unlimited'
  | 'missing'
  | 'unparsed'

export type ShareCredentialStatus =
  | 'active'
  | 'pending_confirmation'
  | 'revoked'
  | 'superseded'

export type SharePendingReasonCode =
  | 'missing_password'
  | 'missing_access_limit'
  | 'unparsed_access_limit'
  | 'missing_validity'
  | 'unparsed_validity'
  | 'legacy_not_active'
  | 'legacy_status_unknown'

export type ShareAuditKind =
  | 'parse'
  | 'migration'
  | 'access'
  | 'regeneration'
  | 'confirmation'

export type ShareAuditSeverity = 'info' | 'warning' | 'error'

export type ShareDataValue = string | number | boolean

export type ShareSnapshot = {
  linkId: string
  targetDataset: string
  /** 原文水印，包含旧用户标识；任何后续凭证版本都不得覆盖。 */
  watermark: string
  legacyUserIdentifier: string | null
  /** 旧分享快照的生成时间；重新生成凭证时保持不变。 */
  generatedAt: string
  generatedAtRaw: string
  generatedAtSource: 'field' | 'baseline-fallback'
  /** 快照第一次被抓取的时间；重复迁移不会刷新。 */
  capturedAt: string
  legacyStatus: string
  legacyFields: Record<string, ShareDataValue>
  source: 'legacy' | 'demo' | 'import'
}

export type SharePendingReason = {
  code: SharePendingReasonCode
  field: string
  raw: string
  message: string
  auditId: string
}

export type ShareCredential = {
  /** 固定为 `${linkId}:v${version}`；同一个链接的同一版本只会有一条。 */
  credentialId: string
  linkId: string
  /** 凭证版本，从 1 开始；重新生成凭证时递增。 */
  version: number
  formatVersion: number
  status: ShareCredentialStatus
  pendingReasons: SharePendingReason[]
  /** 已人工确认过的待确认原因；重复迁移不会把它们重新标回待确认。 */
  confirmedCodes: SharePendingReasonCode[]
  passwordConfigured: boolean
  passwordDigest: string | null
  passwordSalt: string | null
  targetDataset: string
  watermark: string
  legacyUserIdentifier: string | null
  validityRaw: string
  validityKind: ShareValidityKind
  validityDays: number | null
  expiresAt: string | null
  maxAccessRaw: string
  maxAccessKind: ShareAccessLimitKind
  maxAccess: number | null
  /** 累计已消耗次数；迁移重跑、重新生成凭证都只能保留或增加，不能清零。 */
  usedCount: number
  /** 当前凭证版本的生成时间，重新生成时会更新。 */
  generatedAt: string
  updatedAt: string
  migrationBaseline: string
  /** 旧分享快照，原样保留。 */
  snapshot: ShareSnapshot
  auditIds: string[]
  supersededAt?: string
}

export type ShareAuditEntry = {
  id: string
  linkId: string
  kind: ShareAuditKind
  code: string
  severity: ShareAuditSeverity
  field: string
  rawValue: string
  message: string
  baseline: string
  evidence: Record<string, unknown>
  createdAt: string
  lastSeenAt: string
  occurrences: number
}

export type ShareMigrationState = {
  status: ShareMigrationStatus
  baseline: string
  baselineSource: ShareBaselineSource
  schemaVersion: number
  credentialFormatVersion: number
  startedAt: string | null
  updatedAt: string | null
  finishedAt: string | null
  /** 最后一个完整落盘的链接；中断后从这里之后继续。 */
  lastCompletedLinkId: string | null
  lastCompletedIndex: number
  /** 已完成链接的幂等标记；重复执行不会重复生成凭证。 */
  completedLinkIds: string[]
  totalLinks: number
  processedCount: number
  failedCount: number
  lastError: string | null
  skippedDemoCount: number
}

export type ShareStore = {
  schemaVersion: number
  credentialFormatVersion: number
  migration: ShareMigrationState
  credentials: ShareCredential[]
  audits: ShareAuditEntry[]
  legacyAccess: Record<string, number>
}

export type ShareMigrationOptions = {
  rows: EntryRow[]
  baseline?: string
  now?: string
  /** 仅供预检使用；正式迁移永远跳过示例链接。 */
  includeDemo?: boolean
  /** 单次最多处理多少条链接；超出则保留 running 状态，下次从断点继续。 */
  maxLinksPerRun?: number
}

export type ShareMigrationResult = {
  ok: boolean
  status: ShareMigrationStatus
  baseline: string
  baselineSource: ShareBaselineSource
  resumedFrom: string | null
  processed: number
  created: number
  preserved: number
  skippedDemo: number
  pending: number
  failed: number
  lastCompletedLinkId: string | null
  message: string
  audits: ShareAuditEntry[]
}

export type SharePreviewItem = {
  linkId: string
  isDemo: boolean
  targetDataset: string
  watermark: string
  legacyUserIdentifier: string | null
  snapshotGeneratedAt: string
  passwordConfigured: boolean
  validityKind: ShareValidityKind
  expiresAt: string | null
  maxAccessKind: ShareAccessLimitKind
  maxAccess: number | null
  usedCount: number
  status: ShareCredentialStatus
  pendingReasons: SharePendingReason[]
  auditCount: number
}

export type ShareDisplay = {
  linkId: string
  mode: 'legacy' | 'credential'
  /** 示例 / 构建产物链接，迁移时跳过，不会产生正式凭证。 */
  isDemo: boolean
  targetDataset: string
  watermark: string
  legacyUserIdentifier: string | null
  usedCount: number
  maxAccess: number | null
  maxAccessKind: ShareAccessLimitKind
  expiresAt: string | null
  validityKind: ShareValidityKind
  credentialVersion: number | null
  credentialStatus: ShareCredentialStatus | null
  snapshotGeneratedAt: string | null
  pendingReasons: SharePendingReason[]
}

export type ShareAccessCode =
  | 'granted'
  | 'password_mismatch'
  | 'expired'
  | 'limit_reached'
  | 'pending_confirmation'
  | 'revoked'
  | 'not_found'
  | 'invalid_input'

export type ShareAccessResult = {
  ok: boolean
  code: ShareAccessCode
  message: string
  linkId: string
  mode: 'legacy' | 'credential' | 'none'
  consumed: boolean
  usedCount: number
  maxAccess: number | null
  remaining: number | null
  watermark: string | null
  legacyUserIdentifier: string | null
  credentialVersion: number | null
  snapshotGeneratedAt: string | null
  expiresAt: string | null
}

export type ShareOverview = {
  schemaVersion: number
  credentialFormatVersion: number
  migration: ShareMigrationState
  summary: {
    legacyRows: number
    demoRows: number
    credentials: number
    activeCredentials: number
    pendingCredentials: number
    auditEntries: number
  }
  displays: Record<string, ShareDisplay>
  credentials: ShareCredential[]
  audits: ShareAuditEntry[]
}

export function emptyMigrationState(): ShareMigrationState {
  return {
    status: 'idle',
    baseline: SHARE_FALLBACK_BASELINE,
    baselineSource: 'fallback',
    schemaVersion: SHARE_SCHEMA_VERSION,
    credentialFormatVersion: SHARE_CREDENTIAL_FORMAT_VERSION,
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
    lastCompletedLinkId: null,
    lastCompletedIndex: -1,
    completedLinkIds: [],
    totalLinks: 0,
    processedCount: 0,
    failedCount: 0,
    lastError: null,
    skippedDemoCount: 0,
  }
}

export function emptyShareStore(): ShareStore {
  return {
    schemaVersion: SHARE_SCHEMA_VERSION,
    credentialFormatVersion: SHARE_CREDENTIAL_FORMAT_VERSION,
    migration: emptyMigrationState(),
    credentials: [],
    audits: [],
    legacyAccess: {},
  }
}
