/**
 * 数据分享迁移与访问判定的核心引擎。
 *
 * 关键约束（对应需求逐条落地）：
 * - 旧记录不改写，目标数据集 / 水印 / 生成时间原样存进 snapshot。
 * - 一个链接一条 v1 凭证；重复执行按 linkId 幂等，不复制凭证。
 * - 已消耗访问次数取「凭证现值」与「旧记录值」的较大者，永远不会被重置。
 * - 缺失访问上限 → pending_confirmation，不按无限开放。
 * - 缺失密码 → pending_confirmation，不自动开放。
 * - 迁移中断 → 从 migration.lastCompletedIndex 之后继续。
 * - 示例 / 构建产物链接 → 跳过并留旁证，不进正式记录。
 */

import {
  SHARE_CREDENTIAL_FORMAT_VERSION,
  emptyMigrationState,
  type ShareAccessLimitKind,
  type ShareAccessResult,
  type ShareAuditEntry,
  type ShareAuditKind,
  type ShareAuditSeverity,
  type ShareBaselineSource,
  type ShareCredential,
  type ShareCredentialStatus,
  type ShareDataValue,
  type ShareDisplay,
  type ShareMigrationOptions,
  type ShareMigrationResult,
  type ShareMigrationState,
  type SharePendingReason,
  type SharePendingReasonCode,
  type SharePreviewItem,
  type ShareSnapshot,
  type ShareStore,
  type ShareValidityKind,
} from './share-schema'
import {
  SHARE_FIELD_ALIASES,
  SHARE_FALLBACK_BASELINE,
} from './share-schema'
import {
  digestPassword,
  isBlankValue,
  isDemoLink,
  normalizeBaseline,
  normalizeText,
  parseAccessLimit,
  parseUntil,
  parseUsedCount,
  stableHash,
} from './share-parsing'
import {
  readLegacyShareRows,
  readEnvBaseline,
  readShareStore,
  writeShareStore,
} from './share-store'
import type { EntryRow } from './types'

const SOURCE_PRIORITY: Record<ShareSnapshot['source'], number> = {
  legacy: 0,
  import: 1,
  demo: 2,
}

function pickField(fields: Record<string, ShareDataValue>, aliases: readonly string[]): {
  key: string | null
  value: ShareDataValue | undefined
  raw: string
} {
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(fields, alias)) {
      const value = fields[alias]
      if (value === undefined) continue
      return { key: alias, value, raw: normalizeText(value) }
    }
  }
  return { key: null, value: undefined, raw: '' }
}

function rowToFields(row: EntryRow): Record<string, ShareDataValue> {
  const fields: Record<string, ShareDataValue> = {}
  for (const [key, value] of Object.entries(row)) {
    if (['id', 'status', 'pending', 'abnormal'].includes(key)) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      fields[key] = value
    }
  }
  return fields
}

function normalizeLinkId(row: EntryRow, index: number): string {
  const fields = rowToFields(row)
  const picked = pickField(fields, SHARE_FIELD_ALIASES.linkId)
  return picked.raw !== '' ? picked.raw : `SHAR-${String(index + 1).padStart(4, '0')}`
}

function makeAudit(input: {
  linkId: string
  kind: ShareAuditKind
  code: string
  severity: ShareAuditSeverity
  field: string
  rawValue: string
  message: string
  baseline: string
  now: string
  evidence?: Record<string, unknown>
}): ShareAuditEntry {
  const id = `aud-${stableHash(`${input.linkId}|${input.kind}|${input.code}|${input.field}|${input.rawValue}`)}`
  return {
    id,
    linkId: input.linkId,
    kind: input.kind,
    code: input.code,
    severity: input.severity,
    field: input.field,
    rawValue: input.rawValue,
    message: input.message,
    baseline: input.baseline,
    evidence: input.evidence ?? {},
    createdAt: input.now,
    lastSeenAt: input.now,
    occurrences: 1,
  }
}

/** 旁证合并：同 ID 只保留首次证据，次数累加，更新时间刷新。 */
function upsertAudits(existing: ShareAuditEntry[], incoming: ShareAuditEntry[]): ShareAuditEntry[] {
  if (incoming.length === 0) return existing
  const byId = new Map(existing.map((item) => [item.id, item]))
  for (const audit of incoming) {
    const found = byId.get(audit.id)
    if (found) {
      byId.set(audit.id, {
        ...found,
        lastSeenAt: audit.lastSeenAt,
        occurrences: found.occurrences + 1,
      })
    } else {
      byId.set(audit.id, audit)
    }
  }
  return [...byId.values()]
}

type PendingDraft = { reason: SharePendingReason; audit: ShareAuditEntry }

type CredentialDraft = {
  linkId: string
  snapshot: ShareSnapshot
  status: ShareCredentialStatus
  pending: PendingDraft[]
  passwordDigest: string | null
  passwordSalt: string | null
  passwordConfigured: boolean
  validityKind: ShareValidityKind
  validityDays: number | null
  expiresAt: string | null
  validityRaw: string
  maxAccessKind: ShareAccessLimitKind
  maxAccess: number | null
  maxAccessRaw: string
  usedCount: number
  demo: boolean
  demoReason: string
  auditIds: string[]
}

type ParseOutcome = {
  draft: CredentialDraft
  audits: ShareAuditEntry[]
  extraDemo: { demo: boolean; reason: string }
}

function parseRow(
  row: EntryRow,
  index: number,
  baseline: string,
  now: string,
  legacyAccess: Record<string, number>,
): ParseOutcome {
  const fields = rowToFields(row)
  const linkId = normalizeLinkId(row, index)
  const target = pickField(fields, SHARE_FIELD_ALIASES.targetDataset)
  const password = pickField(fields, SHARE_FIELD_ALIASES.password)
  const validity = pickField(fields, SHARE_FIELD_ALIASES.validity)
  const maxAccess = pickField(fields, SHARE_FIELD_ALIASES.maxAccess)
  const used = pickField(fields, SHARE_FIELD_ALIASES.usedCount)
  const watermark = pickField(fields, SHARE_FIELD_ALIASES.watermark)
  const user = pickField(fields, SHARE_FIELD_ALIASES.userIdentifier)
  const generated = pickField(fields, SHARE_FIELD_ALIASES.generatedAt)

  const audits: ShareAuditEntry[] = []
  const pending: PendingDraft[] = []

  const pushPending = (input: {
    code: SharePendingReasonCode
    field: string
    raw: string
    message: string
    severity?: ShareAuditSeverity
    evidence?: Record<string, unknown>
  }) => {
    const audit = makeAudit({
      linkId,
      kind: input.code.startsWith('unparsed') ? 'parse' : 'migration',
      code: input.code,
      severity: input.severity ?? 'warning',
      field: input.field,
      rawValue: input.raw,
      message: input.message,
      baseline,
      now,
      evidence: input.evidence,
    })
    audits.push(audit)
    pending.push({
      reason: {
        code: input.code,
        field: input.field,
        raw: input.raw,
        message: input.message,
        auditId: audit.id,
      },
      audit,
    })
  }

  const demoCheck = isDemoLink({
    linkId,
    targetDataset: target.raw,
    fields,
  })
  const demo = demoCheck.demo
  if (demo) {
    audits.push(
      makeAudit({
        linkId,
        kind: 'migration',
        code: 'demo_link_skipped',
        severity: 'info',
        field: 'linkId',
        rawValue: linkId,
        message: '示例或构建产物链接不进入正式凭证记录',
        baseline,
        now,
        evidence: { reason: demoCheck.reason, targetDataset: target.raw },
      }),
    )
  }

  // 水印：保留旧用户标识；旧水印原文优先，空值才用标识补水印。
  const legacyUserIdentifier = user.raw !== '' ? user.raw : null
  const watermarkText =
    watermark.raw !== ''
      ? watermark.raw
      : legacyUserIdentifier !== null
        ? `分享人 ${legacyUserIdentifier}`
        : `数据集 ${target.raw || linkId}`

  // 生成时间：优先旧字段，其次迁移基准；两种情况都写入 snapshot，后续版本不能覆盖。
  let snapshotGeneratedAt = baseline
  let generatedAtRaw = generated.raw
  let generatedAtSource: ShareSnapshot['generatedAtSource'] = 'baseline-fallback'
  if (generated.raw !== '') {
    const parsed = parseUntil(generated.raw, baseline)
    if (parsed.kind === 'absolute' || parsed.kind === 'relative') {
      snapshotGeneratedAt = parsed.expiresAt
      generatedAtSource = 'field'
    } else {
      // 生成时间只是快照元数据，解析失败留旁证，但不阻塞访问。
      audits.push(
        makeAudit({
          linkId,
          kind: 'parse',
          code: 'unparsed_snapshot_generated_at',
          severity: 'warning',
          field: generated.key ?? '生成时间',
          rawValue: generated.raw,
          message: `原分享生成时间「${generated.raw}」无法解析，已按迁移基准记录并保留原文旁证`,
          baseline,
          now,
          evidence: { raw: generated.raw, fallback: snapshotGeneratedAt },
        }),
      )
    }
  }
  if (generatedAtRaw === '') generatedAtRaw = snapshotGeneratedAt

  const snapshot: ShareSnapshot = {
    linkId,
    targetDataset: target.raw,
    watermark: watermarkText,
    legacyUserIdentifier,
    generatedAt: snapshotGeneratedAt,
    generatedAtRaw,
    generatedAtSource,
    capturedAt: now,
    legacyStatus: String(row.status ?? ''),
    legacyFields: fields,
    source: demo ? 'demo' : 'legacy',
  }

  // 密码：缺失标待确认，不自动开放；原文只留摘要。
  let passwordConfigured = false
  let passwordDigestValue: string | null = null
  let passwordSaltValue: string | null = null
  if (isBlankValue(password.value)) {
    pushPending({
      code: 'missing_password',
      field: password.key ?? '访问密码',
      raw: password.raw,
      message: '旧记录缺少访问密码，已标为待确认，不会自动开放',
      evidence: { legacyStatus: snapshot.legacyStatus },
    })
  } else {
    passwordConfigured = true
    passwordSaltValue = stableHash(`${linkId}|${password.raw}|${baseline}`).slice(0, 12)
    passwordDigestValue = digestPassword(password.raw, passwordSaltValue)
  }

  // 有效期：绝对日期与相对天数按基准归一。
  const validityParsed = parseUntil(validity.raw, baseline)
  let validityKind: ShareValidityKind = validityParsed.kind
  let validityDays: number | null = null
  let expiresAt: string | null = null
  if (validityParsed.kind === 'absolute') {
    expiresAt = validityParsed.expiresAt
  } else if (validityParsed.kind === 'relative') {
    validityDays = validityParsed.validityDays
    expiresAt = validityParsed.expiresAt
  } else if (validityParsed.kind === 'missing') {
    pushPending({
      code: 'missing_validity',
      field: validity.key ?? '有效期天数',
      raw: validity.raw,
      message: '旧记录缺少有效期，已标为待确认，不按长期有效开放',
    })
  } else if (validityParsed.kind === 'unparsed') {
    pushPending({
      code: 'unparsed_validity',
      field: validity.key ?? '有效期天数',
      raw: validity.raw,
      message: `有效期「${validity.raw}」无法解析：${validityParsed.reason}`,
      evidence: { reason: validityParsed.reason },
    })
  }
  // unlimited 有效期是显式声明，保留但不算缺失。

  // 访问上限：缺失 / 无法解析都视为待确认，绝不按无限开放。
  const accessParsed = parseAccessLimit(maxAccess.raw)
  let maxAccessKind: ShareAccessLimitKind = accessParsed.kind
  let maxAccessValue: number | null = null
  if (accessParsed.kind === 'bounded') {
    maxAccessValue = accessParsed.maxAccess
  } else if (accessParsed.kind === 'missing') {
    pushPending({
      code: 'missing_access_limit',
      field: maxAccess.key ?? '最大浏览次数',
      raw: maxAccess.raw,
      message: '旧记录缺少访问上限，已标为待确认，不按无限开放',
    })
  } else if (accessParsed.kind === 'unparsed') {
    pushPending({
      code: 'unparsed_access_limit',
      field: maxAccess.key ?? '最大浏览次数',
      raw: maxAccess.raw,
      message: `访问上限「${maxAccess.raw}」无法解析：${accessParsed.reason}`,
      evidence: { reason: accessParsed.reason },
    })
  }

  // 已消耗次数：旧值兜底，迁移重跑取较大者；解析失败留旁证但不放大。
  const parsedUsed = parseUsedCount(used.raw)
  if (!parsedUsed.ok) {
    audits.push(
      makeAudit({
        linkId,
        kind: 'parse',
        code: 'unparsed_used_count',
        severity: 'warning',
        field: used.key ?? '已浏览次数',
        rawValue: used.raw,
        message: `已浏览次数「${used.raw}」无法解析，暂按 0 记录，等待人工确认`,
        baseline,
        now,
      }),
    )
  }
  const legacyUsed = Math.max(parsedUsed.value, legacyAccess[linkId] ?? 0)
  const usedCount = Math.max(legacyUsed, 0)

  // 旧记录状态决定凭证是否可开放；非生效状态标待确认。
  const legacyStatus = String(row.status ?? '')
  let status: ShareCredentialStatus = 'active'
  if (legacyStatus === '已失效' || legacyStatus === '已撤销' || legacyStatus === '撤销') {
    status = 'revoked'
  } else if (legacyStatus !== '已生效') {
    pushPending({
      code: 'legacy_not_active',
      field: '当前状态',
      raw: legacyStatus,
      message: `旧记录状态为「${legacyStatus || '空'}」，凭证保留但不自动开放，等待确认`,
      severity: 'info',
    })
  }

  const auditIds = audits.map((item) => item.id)

  return {
    draft: {
      linkId,
      snapshot,
      status,
      pending,
      passwordConfigured,
      passwordDigest: passwordDigestValue,
      passwordSalt: passwordSaltValue,
      validityKind,
      validityDays,
      expiresAt,
      validityRaw: validity.raw,
      maxAccessKind,
      maxAccess: maxAccessValue,
      maxAccessRaw: maxAccess.raw,
      usedCount,
      demo,
      demoReason: demoCheck.reason,
      auditIds,
    },
    audits,
    extraDemo: demoCheck,
  }
}

function credentialIdOf(linkId: string, version: number): string {
  return `${linkId}:v${version}`
}

function findActiveCredential(store: ShareStore, linkId: string): ShareCredential | null {
  const matches = store.credentials
    .filter((item) => item.linkId === linkId && item.status !== 'superseded')
    .sort((a, b) => b.version - a.version)
  return matches[0] ?? null
}

function resolveBaseline(
  options: ShareMigrationOptions,
  store: ShareStore,
): { baseline: string; source: ShareBaselineSource } {
  if (options.baseline && options.baseline.trim() !== '') {
    return { baseline: normalizeBaseline(options.baseline, SHARE_FALLBACK_BASELINE), source: 'option' }
  }
  const envBaseline = readEnvBaseline()
  if (envBaseline) {
    return { baseline: normalizeBaseline(envBaseline, SHARE_FALLBACK_BASELINE), source: 'env' }
  }
  if (store.migration.baselineSource !== 'fallback' && store.migration.baseline) {
    return { baseline: normalizeBaseline(store.migration.baseline, SHARE_FALLBACK_BASELINE), source: 'persisted' }
  }
  return {
    baseline: normalizeBaseline(null, SHARE_FALLBACK_BASELINE),
    source: 'fallback',
  }
}

/** 页面展示与迁移使用同一个基准：环境变量 > 已落盘 > 回退值。 */
export function effectiveBaseline(store?: ShareStore): {
  baseline: string
  source: ShareBaselineSource
} {
  const current = store ?? readShareStore()
  return resolveBaseline(
    { rows: [] },
    current,
  )
}


function buildCredential(
  draft: CredentialDraft,
  version: number,
  baseline: string,
  now: string,
  existing: ShareCredential | null,
): ShareCredential {
  // 已消耗次数只增不减：旧凭证 > 旧记录 > 0。
  const usedCount = Math.max(draft.usedCount, existing?.usedCount ?? 0)
  const pendingReasons = mergePendingReasons(draft.pending.map((item) => item.reason), existing)
  const status: ShareCredentialStatus =
    existing?.status === 'revoked'
      ? 'revoked'
      : draft.status === 'revoked'
        ? 'revoked'
        : pendingReasons.length > 0
          ? 'pending_confirmation'
          : 'active'

  // 重新生成凭证时保留原快照；首次迁移用解析出的旧快照。
  const snapshot = existing ? existing.snapshot : draft.snapshot
  const auditIds = [...new Set([...(existing?.auditIds ?? []), ...draft.auditIds])]

  return {
    credentialId: credentialIdOf(draft.linkId, version),
    linkId: draft.linkId,
    version,
    formatVersion: SHARE_CREDENTIAL_FORMAT_VERSION,
    status,
    pendingReasons,
    confirmedCodes: existing?.confirmedCodes ?? [],
    passwordConfigured: draft.passwordConfigured || Boolean(existing?.passwordConfigured),
    passwordDigest: draft.passwordDigest ?? existing?.passwordDigest ?? null,
    passwordSalt: draft.passwordSalt ?? existing?.passwordSalt ?? null,
    targetDataset: draft.snapshot.targetDataset || existing?.targetDataset || '',
    watermark: snapshot.watermark,
    legacyUserIdentifier: snapshot.legacyUserIdentifier,
    validityRaw:
      existing && isConfirmed(existing, 'missing_validity', 'unparsed_validity')
        ? existing.validityRaw
        : draft.validityRaw,
    validityKind:
      existing && isConfirmed(existing, 'missing_validity', 'unparsed_validity')
        ? existing.validityKind
        : draft.validityKind,
    validityDays:
      existing && isConfirmed(existing, 'missing_validity', 'unparsed_validity')
        ? existing.validityDays
        : draft.validityDays,
    expiresAt:
      existing && isConfirmed(existing, 'missing_validity', 'unparsed_validity')
        ? existing.expiresAt
        : draft.expiresAt,
    maxAccessRaw:
      existing && isConfirmed(existing, 'missing_access_limit', 'unparsed_access_limit')
        ? existing.maxAccessRaw
        : draft.maxAccessRaw,
    maxAccessKind:
      existing && isConfirmed(existing, 'missing_access_limit', 'unparsed_access_limit')
        ? existing.maxAccessKind
        : draft.maxAccessKind,
    maxAccess:
      existing && isConfirmed(existing, 'missing_access_limit', 'unparsed_access_limit')
        ? existing.maxAccess
        : draft.maxAccess,
    usedCount,
    generatedAt: existing ? existing.generatedAt : now,
    updatedAt: now,
    migrationBaseline: baseline,
    snapshot,
    auditIds,
  }
}

/**
 * 待确认原因合并：
 * - 已人工确认过的原因不会在重复迁移时被重新标回；
 * - 重新生成凭证时，补齐过的访问上限 / 有效期沿用旧凭证的值。
 */
export function mergePendingReasons(
  incoming: SharePendingReason[],
  existing: ShareCredential | null,
): SharePendingReason[] {
  if (!existing) return incoming
  const confirmed = new Set(existing.confirmedCodes)
  return incoming.filter((item) => !confirmed.has(item.code))
}

function isConfirmed(credential: ShareCredential, ...codes: SharePendingReasonCode[]): boolean {
  return codes.some((code) => credential.confirmedCodes.includes(code))
}

export type MigrateSharesContext = {
  store?: ShareStore
  rows?: EntryRow[]
  legacySource?: 'storage' | 'seed'
}

/**
 * 传入的 store 是调用方的句柄：每轮提交时把新文档同步回去，
 * 这样断点与凭证在调用方看来也是逐条可见的。
 */
function syncStore(target: ShareStore, next: ShareStore): void {
  target.schemaVersion = next.schemaVersion
  target.credentialFormatVersion = next.credentialFormatVersion
  target.migration = next.migration
  target.credentials = next.credentials
  target.audits = next.audits
  target.legacyAccess = next.legacyAccess
}



/**
 * 执行迁移。写入粒度是「单条链接」：handler 决定每一轮成功后的持久化策略，
 * 中途抛错不会留下半条凭证。
 */
export function migrateShares(
  options: ShareMigrationOptions,
  context: MigrateSharesContext = {},
  onCommit?: (store: ShareStore) => void,
): ShareMigrationResult {
  const store = context.store ?? readShareStore()
  const legacy = context.rows ? { rows: context.rows, source: context.legacySource ?? 'storage' } : readLegacyShareRows()
  const now = options.now ?? new Date().toISOString()
  const { baseline, source: baselineSource } = resolveBaseline(options, store)

  const previous = store.migration
  const completedRowsPrefix = legacy.rows
    .slice(0, previous.completedLinkIds.length)
    .every((row, index) => normalizeLinkId(row, index) === previous.completedLinkIds[index])
  // 断点续迁条件：同一基准、已完成的链接正好是当前记录的前缀、且后面还有新链接。
  const resuming =
    previous.baseline === baseline &&
    previous.completedLinkIds.length > 0 &&
    completedRowsPrefix &&
    previous.lastCompletedIndex + 1 < legacy.rows.length

  const migration: ShareMigrationState = resuming
    ? { ...previous }
    : {
        ...emptyMigrationState(),
        status: 'running',
        baseline,
        baselineSource,
        startedAt: now,
        updatedAt: now,
        totalLinks: legacy.rows.length,
      }

  migration.status = 'running'
  migration.baseline = baseline
  migration.baselineSource = baselineSource
  migration.updatedAt = now
  migration.totalLinks = legacy.rows.length
  migration.lastError = null
  if (!resuming) {
    migration.processedCount = 0
    migration.skippedDemoCount = 0
    migration.completedLinkIds = []
    migration.lastCompletedIndex = -1
    migration.lastCompletedLinkId = null
  }
  // 迁移期间旧链接继续可用：只要还有记录没迁完，就保持 running。
  if (migration.completedLinkIds.length >= legacy.rows.length) {
    migration.status = 'completed'
    migration.finishedAt = now
  }

  const nextStore: ShareStore = {
    ...store,
    schemaVersion: store.schemaVersion,
    credentialFormatVersion: SHARE_CREDENTIAL_FORMAT_VERSION,
    migration,
  }

  const auditBuffer: ShareAuditEntry[] = []
  let created = 0
  let preserved = 0
  let skippedDemo = 0
  let pendingCount = 0
  let failed = 0

  // 断点续迁：已完成的 linkId 直接跳过（幂等），从断点索引之后继续。
  const completed = new Set(migration.completedLinkIds)
  const startIndex = resuming ? migration.lastCompletedIndex + 1 : 0
  let processedRows = resuming ? migration.processedCount : 0
  const orderByIndex = (index: number) => index
  const maxPerRun =
    options.maxLinksPerRun && options.maxLinksPerRun > 0
      ? options.maxLinksPerRun
      : Number.POSITIVE_INFINITY
  let handledThisRun = 0

  for (let index = startIndex; index < legacy.rows.length; index += 1) {
    if (handledThisRun >= maxPerRun) {
      // 达到单次批量上限：保留 running 与断点，下一次从这里继续。
      break
    }
    handledThisRun += 1
    const row = legacy.rows[index]
    const linkId = normalizeLinkId(row, index)
    if (completed.has(linkId)) {
      preserved += 1
      processedRows += 1
      migration.lastCompletedIndex = Math.max(migration.lastCompletedIndex, orderByIndex(index))
      migration.lastCompletedLinkId = linkId
      continue
    }

    let outcome: ParseOutcome
    try {
      outcome = parseRow(row, index, baseline, now, nextStore.legacyAccess)
    } catch (error) {
      failed += 1
      migration.status = 'failed'
      migration.lastError = error instanceof Error ? error.message : String(error)
      migration.updatedAt = now
      auditBuffer.push(
        makeAudit({
          linkId,
          kind: 'migration',
          code: 'link_parse_failed',
          severity: 'error',
          field: 'row',
          rawValue: String(row.id ?? index),
          message: `链接解析失败，迁移中断：${migration.lastError}`,
          baseline,
          now,
        }),
      )
      nextStore.audits = upsertAudits(nextStore.audits, auditBuffer)
      syncStore(store, nextStore)
      onCommit?.(nextStore)
      break
    }

    const { draft } = outcome
    auditBuffer.push(...outcome.audits)

    if (draft.demo && !options.includeDemo) {
      skippedDemo += 1
      migration.skippedDemoCount += 1
      migration.completedLinkIds.push(linkId)
      migration.lastCompletedIndex = Math.max(migration.lastCompletedIndex, orderByIndex(index))
      migration.lastCompletedLinkId = linkId
      processedRows += 1
      migration.processedCount = processedRows
      nextStore.audits = upsertAudits(nextStore.audits, auditBuffer)
      auditBuffer.length = 0
      syncStore(store, nextStore)
      onCommit?.(nextStore)
      continue
    }

    let existing = findActiveCredential(nextStore, draft.linkId)
    if (existing && existing.snapshot.source === 'demo' && !draft.demo) {
      // 同编号已存在示例凭证而当前记录是正式记录：以正式记录为准替换。
      existing.status = 'superseded'
      existing.supersededAt = now
      existing = null
    }

    if (existing && existing.formatVersion === SHARE_CREDENTIAL_FORMAT_VERSION) {
      // 幂等：同链接已有 v1 凭证，只更新旁证与待确认原因，不新增凭证。
      preserved += 1
      existing.pendingReasons = mergePendingReasons(
        draft.pending.map((item) => item.reason),
        existing,
      )
      existing.status =
        existing.status === 'revoked'
          ? 'revoked'
          : existing.pendingReasons.length > 0
            ? 'pending_confirmation'
            : 'active'
      // 已消耗次数只增不减，重跑不会把访问计数清零。
      existing.usedCount = Math.max(existing.usedCount, draft.usedCount)
      existing.auditIds = [...new Set([...existing.auditIds, ...draft.auditIds])]
      existing.updatedAt = now
      // 人工确认过的上限 / 有效期不被原始自由文本覆盖。
      if (!isConfirmed(existing, 'missing_access_limit', 'unparsed_access_limit')) {
        existing.maxAccessKind = draft.maxAccessKind
        existing.maxAccess = draft.maxAccess
        existing.maxAccessRaw = draft.maxAccessRaw
      }
      if (!isConfirmed(existing, 'missing_validity', 'unparsed_validity')) {
        existing.validityKind = draft.validityKind
        existing.validityDays = draft.validityDays
        existing.expiresAt = draft.expiresAt
        existing.validityRaw = draft.validityRaw
      }
      // 快照与凭证生成时间保持首次迁移时的值。
      if (existing.snapshot.source !== 'legacy' && draft.snapshot.source === 'legacy') {
        existing.snapshot = draft.snapshot
        existing.watermark = draft.snapshot.watermark
        existing.legacyUserIdentifier = draft.snapshot.legacyUserIdentifier
      }
    } else {
      const sameLink = nextStore.credentials.filter((item) => item.linkId === draft.linkId)
      const version = sameLink.length > 0 ? Math.max(...sameLink.map((item) => item.version)) + 1 : 1
      if (existing) {
        existing.status = 'superseded'
        existing.supersededAt = now
      }
      const credential = buildCredential(draft, version, baseline, now, existing)
      // 迁移新生成的版本以当前时间为凭证生成时间；原分享快照的生成时间仍在 snapshot 里保留。
      credential.generatedAt = now
      nextStore.credentials = [...nextStore.credentials, credential]
      created += 1
      pendingCount += credential.status === 'pending_confirmation' ? 1 : 0
    }

    migration.completedLinkIds.push(linkId)
    migration.lastCompletedIndex = Math.max(migration.lastCompletedIndex, orderByIndex(index))
    migration.lastCompletedLinkId = linkId
    processedRows += 1
    migration.processedCount = processedRows
    migration.updatedAt = now
    nextStore.audits = upsertAudits(nextStore.audits, auditBuffer)
    auditBuffer.length = 0
    syncStore(store, nextStore)
    onCommit?.(nextStore)
  }

  if (auditBuffer.length > 0) {
    nextStore.audits = upsertAudits(nextStore.audits, auditBuffer)
  }

  // 只有全部记录都处理完才算完成；中断时保留 running/failed，旧链接继续可用。
  const allDone = migration.lastCompletedIndex >= legacy.rows.length - 1
  if (failed === 0 && allDone) {
    migration.status = 'completed'
    migration.finishedAt = now
    migration.failedCount = 0
  } else if (failed > 0) {
    migration.status = 'failed'
    migration.failedCount = failed
  } else {
    migration.status = 'running'
    migration.finishedAt = null
  }
  migration.processedCount = processedRows
  migration.updatedAt = now

  nextStore.audits = upsertAudits(nextStore.audits, [])

  const result: ShareMigrationResult = {
    ok: failed === 0,
    status: migration.status,
    baseline,
    baselineSource,
    resumedFrom: resuming ? previous.lastCompletedLinkId : null,
    processed: migration.processedCount,
    created,
    preserved,
    skippedDemo,
    pending: pendingCount,
    failed,
    lastCompletedLinkId: migration.lastCompletedLinkId,
    message: buildMessage({
      status: migration.status,
      created,
      preserved,
      skippedDemo,
      pendingCount,
      failed,
      baseline,
      processed: migration.processedCount,
      total: legacy.rows.length,
    }),
    audits: nextStore.audits.filter((item) => migration.completedLinkIds.includes(item.linkId)),
  }

  syncStore(store, nextStore)
  if (onCommit) onCommit(nextStore)
  return result
}

function buildMessage(input: {
  status: ShareMigrationStatusLike
  created: number
  preserved: number
  skippedDemo: number
  pendingCount: number
  failed: number
  baseline: string
  processed: number
  total: number
}): string {
  if (input.failed > 0) {
    return `迁移中断：${input.failed} 条链接解析失败，已保留断点，可从最后完整链接继续`
  }
  const head = `迁移基准 ${input.baseline}：新建 ${input.created} 条凭证，保留 ${input.preserved} 条已有凭证`
  const tail =
    input.pendingCount > 0 ? `，${input.pendingCount} 条待确认` : ''
  const demo = input.skippedDemo > 0 ? `，跳过 ${input.skippedDemo} 条示例链接` : ''
  const progress =
    input.status === 'running'
      ? `；本次处理到 ${input.processed}/${input.total}，可继续迁移`
      : ''
  return `${head}${tail}${demo}${progress}`
}

type ShareMigrationStatusLike = ShareMigrationState['status']

/**
 * 迁移完成前水印展示沿用旧原文；迁移后再按版本凭证恢复访问计数。
 * 页面、导出与访问判定都从这里取展示值。
 */
export function buildDisplays(
  legacyRows: EntryRow[],
  store: ShareStore,
  baseline: string,
): Record<string, ShareDisplay> {
  const displays: Record<string, ShareDisplay> = {}
  const credentialByLink = new Map<string, ShareCredential>()
  for (const credential of store.credentials) {
    if (credential.status === 'superseded') continue
    const current = credentialByLink.get(credential.linkId)
    if (!current || current.version < credential.version) {
      credentialByLink.set(credential.linkId, credential)
    }
  }
  const seen = new Set<string>()

  legacyRows.forEach((row, index) => {
    const linkId = normalizeLinkId(row, index)
    if (seen.has(linkId)) return
    seen.add(linkId)
    const fields = rowToFields(row)
    const watermark = pickField(fields, SHARE_FIELD_ALIASES.watermark)
    const user = pickField(fields, SHARE_FIELD_ALIASES.userIdentifier)
    const credential = credentialByLink.get(linkId)
    const demoCheck = isDemoLink({
      linkId,
      targetDataset: pickField(fields, SHARE_FIELD_ALIASES.targetDataset).raw,
      fields,
    })
    if (credential) {
      displays[linkId] = {
        linkId,
        mode: 'credential',
        isDemo: credential.snapshot.source === 'demo',
        targetDataset: credential.targetDataset,
        watermark: credential.watermark,
        legacyUserIdentifier: credential.legacyUserIdentifier,
        usedCount: credential.usedCount,
        maxAccess: credential.maxAccess,
        maxAccessKind: credential.maxAccessKind,
        expiresAt: credential.expiresAt,
        validityKind: credential.validityKind,
        credentialVersion: credential.version,
        credentialStatus: credential.status,
        snapshotGeneratedAt: credential.snapshot.generatedAt,
        pendingReasons: credential.pendingReasons,
      }
      return
    }
    // 未迁移：沿用旧原文展示，计数从旧字段读取，不判定是否开放。
    const parsedUsed = parseUsedCount(pickField(fields, SHARE_FIELD_ALIASES.usedCount).raw)
    const parsedMax = parseAccessLimit(pickField(fields, SHARE_FIELD_ALIASES.maxAccess).raw)
    const parsedValidity = parseUntil(pickField(fields, SHARE_FIELD_ALIASES.validity).raw, baseline)
    const legacyWatermark = watermark.raw !== '' ? watermark.raw : user.raw !== '' ? `分享人 ${user.raw}` : ''
    displays[linkId] = {
      linkId,
      mode: 'legacy',
      isDemo: demoCheck.demo,
      targetDataset: pickField(fields, SHARE_FIELD_ALIASES.targetDataset).raw,
      watermark: legacyWatermark,
      legacyUserIdentifier: user.raw !== '' ? user.raw : null,
      usedCount: Math.max(parsedUsed.value, store.legacyAccess[linkId] ?? 0),
      maxAccess: parsedMax.kind === 'bounded' ? parsedMax.maxAccess : null,
      maxAccessKind: parsedMax.kind,
      expiresAt:
        parsedValidity.kind === 'absolute' || parsedValidity.kind === 'relative'
          ? parsedValidity.expiresAt
          : null,
      validityKind: parsedValidity.kind,
      credentialVersion: null,
      credentialStatus: null,
      snapshotGeneratedAt: null,
      pendingReasons: [],
    }
  })

  return displays
}

export function shareOverview(input?: {
  rows?: EntryRow[]
  store?: ShareStore
  baseline?: string
}): {
  store: ShareStore
  displays: Record<string, ShareDisplay>
  baseline: string
  rows: EntryRow[]
} {
  const store = input?.store ?? readShareStore()
  const legacy = input?.rows
    ? { rows: input.rows, source: 'storage' as const }
    : readLegacyShareRows()
  const resolved = resolveBaseline({ rows: legacy.rows, baseline: input?.baseline }, store)
  return {
    store,
    rows: legacy.rows,
    baseline: resolved.baseline,
    displays: buildDisplays(legacy.rows, store, resolved.baseline),
  }
}

function matchesLegacyPassword(credential: ShareCredential, password: string): boolean {
  if (!credential.passwordConfigured) return false
  if (!credential.passwordDigest || !credential.passwordSalt) return false
  return digestPassword(password, credential.passwordSalt) === credential.passwordDigest
}

/**
 * 旧链接直通条件：
 * - 迁移尚未完成（否则应走凭证；凭证缺失说明该记录被有意跳过或被撤销）；
 * - 该链接不是示例 / 构建产物链接；
 * - 该链接确实在本次待迁清单里。
 */
function legacyFallbackAllowed(store: ShareStore, row: EntryRow, index: number): boolean {
  if (store.migration.status === 'completed') return false
  const fields = rowToFields(row)
  const linkId = normalizeLinkId(row, index)
  const demo = isDemoLink({
    linkId,
    targetDataset: pickField(fields, SHARE_FIELD_ALIASES.targetDataset).raw,
    fields,
  })
  if (demo.demo) return false
  if (store.migration.completedLinkIds.includes(linkId)) return false
  return true
}

/**
 * 访问判定。迁移完成前走旧链接校验（保留原有可用性），迁移后走版本凭证。
 * 密码校验失败不消耗次数；待确认凭证不开放。
 */
export function accessShare(input: {
  linkId: string
  password?: string
  now?: string
  rows?: EntryRow[]
  store?: ShareStore
}): ShareAccessResult {
  const now = input.now ?? new Date().toISOString()
  // 显式传入 store 时按引用修改，由调用方负责落盘；否则每次读最新存储再写回。
  const store = input.store ?? readShareStore()
  const legacy = input.rows
    ? { rows: input.rows, source: 'storage' as const }
    : readLegacyShareRows()
  const rowIndex = legacy.rows.findIndex((row, index) => normalizeLinkId(row, index) === input.linkId)
  const row = rowIndex >= 0 ? legacy.rows[rowIndex] : null
  const credential = findActiveCredential(store, input.linkId)

  const base: ShareAccessResult = {
    ok: false,
    code: 'not_found',
    message: `没有找到链接 ${input.linkId}`,
    linkId: input.linkId,
    mode: 'none',
    consumed: false,
    usedCount: 0,
    maxAccess: null,
    remaining: null,
    watermark: null,
    legacyUserIdentifier: null,
    credentialVersion: null,
    snapshotGeneratedAt: null,
    expiresAt: null,
  }

  if (!row && !credential) {
    return base
  }

  if (typeof input.password === 'string' && input.password.trim() === '') {
    return { ...base, code: 'invalid_input', message: '请输入访问密码' }
  }
  const password = input.password?.trim() ?? ''

  // 迁移完成前：旧链接仍可用，计数落在 legacyAccess，等迁移并入凭证。
  // 示例链接与迁移已完成后的旧记录不享受这条直通：前者永不进入正式记录，后者应以凭证为准。
  if (!credential && row && legacyFallbackAllowed(store, row, rowIndex)) {
    const fields = rowToFields(row)
    const validity = parseUntil(pickField(fields, SHARE_FIELD_ALIASES.validity).raw, store.migration.baseline)
    const maxAccess = parseAccessLimit(pickField(fields, SHARE_FIELD_ALIASES.maxAccess).raw)
    const legacyPassword = pickField(fields, SHARE_FIELD_ALIASES.password).raw
    const used = Math.max(
      parseUsedCount(pickField(fields, SHARE_FIELD_ALIASES.usedCount).raw).value,
      store.legacyAccess[input.linkId] ?? 0,
    )
    const legacyResult: ShareAccessResult = {
      ...base,
      mode: 'legacy',
      usedCount: used,
      maxAccess: maxAccess.kind === 'bounded' ? maxAccess.maxAccess : null,
      watermark: pickField(fields, SHARE_FIELD_ALIASES.watermark).raw || null,
      legacyUserIdentifier: pickField(fields, SHARE_FIELD_ALIASES.userIdentifier).raw || null,
      expiresAt:
        validity.kind === 'absolute' || validity.kind === 'relative' ? validity.expiresAt : null,
    }
    if (String(row.status) !== '已生效') {
      return {
        ...legacyResult,
        code: 'pending_confirmation',
        message: `旧链接状态为「${String(row.status)}」，迁移完成前不开放访问`,
      }
    }
    if (legacyPassword === '') {
      return {
        ...legacyResult,
        code: 'pending_confirmation',
        message: '旧链接缺少访问密码，已标为待确认，不能自动开放',
      }
    }
    if (password !== legacyPassword) {
      return { ...legacyResult, code: 'password_mismatch', message: '访问密码不正确，本次不计入访问次数' }
    }
    if (
      legacyResult.expiresAt !== null &&
      new Date(legacyResult.expiresAt).getTime() <= new Date(now).getTime()
    ) {
      return { ...legacyResult, code: 'expired', message: `链接已于 ${legacyResult.expiresAt} 过期` }
    }
    if (
      maxAccess.kind === 'missing' || maxAccess.kind === 'unparsed'
    ) {
      return {
        ...legacyResult,
        code: 'pending_confirmation',
        message: '旧链接访问上限缺失或无法解析，已标为待确认，不按无限开放',
      }
    }
    if (maxAccess.kind === 'bounded' && used >= maxAccess.maxAccess) {
      return { ...legacyResult, code: 'limit_reached', message: '链接访问次数已用尽' }
    }
    const nextUsed = used + 1
    store.legacyAccess[input.linkId] = nextUsed
    if (input.store === undefined) writeShareStore(store)
    return {
      ...legacyResult,
      ok: true,
      code: 'granted',
      consumed: true,
      usedCount: nextUsed,
      remaining: maxAccess.kind === 'bounded' ? maxAccess.maxAccess - nextUsed : null,
      message:
        maxAccess.kind === 'bounded'
          ? `访问已放行，剩余 ${maxAccess.maxAccess - nextUsed} 次`
          : '访问已放行（旧记录显式声明无限访问）',
    }
  }

  // 迁移后：走版本凭证。
  if (!credential) return base
  const credentialResult: ShareAccessResult = {
    ...base,
    mode: 'credential',
    usedCount: credential.usedCount,
    maxAccess: credential.maxAccess,
    remaining:
      credential.maxAccess === null ? null : Math.max(credential.maxAccess - credential.usedCount, 0),
    watermark: credential.watermark,
    legacyUserIdentifier: credential.legacyUserIdentifier,
    credentialVersion: credential.version,
    snapshotGeneratedAt: credential.snapshot.generatedAt,
    expiresAt: credential.expiresAt,
  }

  if (credential.status === 'revoked') {
    return { ...credentialResult, code: 'revoked', message: '链接已撤销' }
  }
  if (credential.status === 'pending_confirmation') {
    return {
      ...credentialResult,
      code: 'pending_confirmation',
      message: `凭证待确认：${credential.pendingReasons.map((item) => item.message).join('；')}`,
    }
  }
  if (!credential.passwordConfigured) {
    return {
      ...credentialResult,
      code: 'pending_confirmation',
      message: '凭证缺少访问密码，已标为待确认，不能自动开放',
    }
  }
  if (!matchesLegacyPassword(credential, password)) {
    return {
      ...credentialResult,
      code: 'password_mismatch',
      message: '访问密码不正确，本次不计入访问次数',
    }
  }
  if (credential.expiresAt !== null && new Date(credential.expiresAt).getTime() <= new Date(now).getTime()) {
    return { ...credentialResult, code: 'expired', message: `链接已于 ${credential.expiresAt} 过期` }
  }
  if (credential.maxAccessKind !== 'bounded' || credential.maxAccess === null) {
    if (credential.maxAccessKind !== 'unlimited') {
      return {
        ...credentialResult,
        code: 'pending_confirmation',
        message: '凭证访问上限待确认，不按无限开放',
      }
    }
    // 显式“无上限”是旧记录里的明确声明，按原意开放；缺失才待确认。
  } else if (credential.usedCount >= credential.maxAccess) {
    return {
      ...credentialResult,
      code: 'limit_reached',
      message: `链接访问次数已达上限 ${credential.maxAccess} 次`,
    }
  }

  credential.usedCount += 1
  credential.updatedAt = now
  const audit = makeAudit({
    linkId: credential.linkId,
    kind: 'access',
    code: 'access_granted',
    severity: 'info',
    field: 'usedCount',
    rawValue: String(credential.usedCount),
    message: `第 ${credential.usedCount} 次访问已放行`,
    baseline: credential.migrationBaseline,
    now,
    evidence: { credentialVersion: credential.version },
  })
  store.audits = upsertAudits(store.audits, [audit])
  if (input.store === undefined) writeShareStore(store)

  const remaining =
    credential.maxAccessKind === 'bounded' && credential.maxAccess !== null
      ? credential.maxAccess - credential.usedCount
      : null

  return {
    ...credentialResult,
    ok: true,
    code: 'granted',
    consumed: true,
    usedCount: credential.usedCount,
    remaining,
    message:
      remaining === null
        ? '访问已放行（凭证显式声明无限访问）'
        : `访问已放行，剩余 ${remaining} 次`,
  }
}

/**
 * 重新生成凭证：版本号递增，旧版本标 superseded。
 * 原分享快照与生成时间原样保留，已消耗次数沿用旧凭证。
 */
export function regenerateCredential(input: {
  linkId: string
  now?: string
  store?: ShareStore
}): { ok: boolean; message: string; credential?: ShareCredential } {
  const store = input.store ?? readShareStore()
  const now = input.now ?? new Date().toISOString()
  const current = findActiveCredential(store, input.linkId)
  if (!current) {
    return { ok: false, message: `没有找到链接 ${input.linkId} 的有效凭证` }
  }
  const version = current.version + 1
  const next: ShareCredential = {
    ...current,
    credentialId: credentialIdOf(current.linkId, version),
    version,
    status: current.status === 'revoked' ? 'revoked' : current.pendingReasons.length > 0 ? 'pending_confirmation' : 'active',
    generatedAt: now,
    updatedAt: now,
    // 快照整体复用：水印、旧用户标识、原分享生成时间都不能丢。
    snapshot: { ...current.snapshot },
    usedCount: current.usedCount,
    auditIds: [...current.auditIds],
    supersededAt: undefined,
  }
  current.status = 'superseded'
  current.supersededAt = now
  store.credentials = [...store.credentials, next]
  const audit = makeAudit({
    linkId: current.linkId,
    kind: 'regeneration',
    code: 'credential_regenerated',
    severity: 'info',
    field: 'version',
    rawValue: String(version),
    message: `凭证已重新生成到 v${version}，原分享快照与访问计数保持不变`,
    baseline: current.migrationBaseline,
    now,
    evidence: {
      previousVersion: current.version,
      snapshotGeneratedAt: current.snapshot.generatedAt,
      usedCount: current.usedCount,
    },
  })
  store.audits = upsertAudits(store.audits, [audit])
  if (input.store === undefined) writeShareStore(store)
  return { ok: true, message: audit.message, credential: next }
}

/** 人工确认：补齐访问上限 / 有效期后解除待确认（本应用只提供最小确认入口）。 */
export function confirmCredential(input: {
  linkId: string
  maxAccess?: number
  expiresAt?: string
  now?: string
  store?: ShareStore
}): { ok: boolean; message: string; credential?: ShareCredential } {
  const store = input.store ?? readShareStore()
  const now = input.now ?? new Date().toISOString()
  const current = findActiveCredential(store, input.linkId)
  if (!current) {
    return { ok: false, message: `没有找到链接 ${input.linkId} 的有效凭证` }
  }
  const remaining = current.pendingReasons.filter((item) => {
    if (input.maxAccess !== undefined && item.code === 'missing_access_limit') return false
    if (input.maxAccess !== undefined && item.code === 'unparsed_access_limit') return false
    if (input.expiresAt !== undefined && item.code === 'missing_validity') return false
    if (input.expiresAt !== undefined && item.code === 'unparsed_validity' && item.field !== '生成时间') return false
    return true
  })
  const confirmedCodes = [...current.confirmedCodes]
  if (input.maxAccess !== undefined) {
    if (!Number.isInteger(input.maxAccess) || input.maxAccess < 0) {
      return { ok: false, message: '访问上限必须是非负整数' }
    }
    current.maxAccessKind = 'bounded'
    current.maxAccess = input.maxAccess
    current.maxAccessRaw = `人工确认 ${input.maxAccess}`
    confirmedCodes.push('missing_access_limit', 'unparsed_access_limit')
  }
  if (input.expiresAt !== undefined) {
    const normalized = normalizeBaseline(input.expiresAt, current.expiresAt ?? now)
    current.expiresAt = normalized
    current.validityKind = 'absolute'
    current.validityRaw = `人工确认 ${normalized}`
    confirmedCodes.push('missing_validity', 'unparsed_validity')
  }
  current.confirmedCodes = [...new Set(confirmedCodes)]
  current.pendingReasons = remaining
  if (current.status !== 'revoked') {
    current.status = remaining.length > 0 ? 'pending_confirmation' : 'active'
  }
  current.updatedAt = now
  const audit = makeAudit({
    linkId: current.linkId,
    kind: 'confirmation',
    code: 'credential_confirmed',
    severity: 'info',
    field: 'pendingReasons',
    rawValue: String(remaining.length),
    message:
      remaining.length === 0
        ? '待确认项已全部补齐，凭证恢复开放'
        : `已确认部分待确认项，仍有 ${remaining.length} 项待确认`,
    baseline: current.migrationBaseline,
    now,
    evidence: { maxAccess: current.maxAccess, expiresAt: current.expiresAt },
  })
  store.audits = upsertAudits(store.audits, [audit])
  if (input.store === undefined) writeShareStore(store)
  return { ok: true, message: audit.message, credential: current }
}

/** 导出用预览：不写存储，不产生凭证。 */
export function previewShareMigration(input?: {
  rows?: EntryRow[]
  baseline?: string
  now?: string
}): SharePreviewItem[] {
  const legacy = input?.rows
    ? { rows: input.rows, source: 'storage' as const }
    : readLegacyShareRows()
  const store = readShareStore()
  const { baseline, } = resolveBaseline({ rows: legacy.rows, baseline: input?.baseline }, store)
  const now = input?.now ?? new Date().toISOString()
  const items = new Map<string, SharePreviewItem>()
  legacy.rows.forEach((row, index) => {
    const outcome = parseRow(row, index, baseline, now, store.legacyAccess)
    const { draft } = outcome
    const existing = findActiveCredential(store, draft.linkId)
    const pendingCodes = draft.pending.map((item) => item.reason)
    const status: ShareCredentialStatus =
      draft.status === 'revoked'
        ? 'revoked'
        : pendingCodes.length > 0
          ? 'pending_confirmation'
          : (existing?.status ?? 'active')
    const item: SharePreviewItem = {
      linkId: draft.linkId,
      isDemo: draft.demo,
      targetDataset: draft.snapshot.targetDataset,
      watermark: draft.snapshot.watermark,
      legacyUserIdentifier: draft.snapshot.legacyUserIdentifier,
      snapshotGeneratedAt: draft.snapshot.generatedAt,
      passwordConfigured: draft.passwordConfigured,
      validityKind: draft.validityKind,
      expiresAt: draft.expiresAt,
      maxAccessKind: draft.maxAccessKind,
      maxAccess: draft.maxAccess,
      usedCount: Math.max(draft.usedCount, existing?.usedCount ?? 0),
      status,
      pendingReasons: pendingCodes,
      auditCount: outcome.audits.length,
    }
    const duplicate = items.get(item.linkId)
    if (!duplicate) {
      items.set(item.linkId, item)
    } else {
      // 重复 linkId：保留更「正式」的那条，并在旁证里说明。
      const currentSource = draft.snapshot.source
      const previousSource: ShareSnapshot['source'] = duplicate.isDemo ? 'demo' : 'legacy'
      if (SOURCE_PRIORITY[currentSource] < SOURCE_PRIORITY[previousSource]) {
        items.set(item.linkId, item)
      }
    }
  })
  return [...items.values()]
}
