/**
 * 数据分享页的服务层：页面只调用这里，不直接碰迁移 / 存储细节。
 */

import {
  accessShare,
  confirmCredential,
  migrateShares,
  previewShareMigration,
  regenerateCredential,
  shareOverview,
} from '@/data/share-migration'
import {
  SHARE_CREDENTIAL_FORMAT_VERSION,
  SHARE_FALLBACK_BASELINE,
  SHARE_SCHEMA_VERSION,
  type ShareAccessResult,
  type ShareAuditEntry,
  type ShareCredential,
  type ShareDisplay,
  type ShareMigrationResult,
  type ShareMigrationState,
  type ShareOverview,
  type SharePreviewItem,
} from '@/data/share-schema'
import { readLegacyShareRows, readShareStore, writeShareStore } from '@/data/share-store'
import { normalizeBaseline } from '@/data/share-parsing'

export type SharePageData = ShareOverview & {
  rows: ReturnType<typeof readLegacyShareRows>['rows']
  displays: Record<string, ShareDisplay>
  credentials: ShareCredential[]
  audits: ShareAuditEntry[]
  legacyRows: number
  migratedRows: number
  demoRows: number
  baseline: string
  schemaVersion: number
  credentialFormatVersion: number
}

export function loadSharePage(): SharePageData {
  const legacy = readLegacyShareRows()
  const { store, displays, baseline } = shareOverview({ rows: legacy.rows })
  const credentials = [...store.credentials].sort((a, b) => {
    if (a.linkId === b.linkId) return b.version - a.version
    return a.linkId.localeCompare(b.linkId)
  })
  const audits = [...store.audits].sort((a, b) => {
    if (a.linkId === b.linkId) return b.lastSeenAt.localeCompare(a.lastSeenAt)
    return a.linkId.localeCompare(b.linkId)
  })
  const displayList = Object.values(displays)
  return {
    schemaVersion: SHARE_SCHEMA_VERSION,
    credentialFormatVersion: SHARE_CREDENTIAL_FORMAT_VERSION,
    migration: store.migration,
    baseline,
    rows: legacy.rows,
    displays,
    credentials,
    audits,
    summary: {
      legacyRows: legacy.rows.length,
      demoRows: displayList.filter((item) => item.isDemo).length,
      credentials: credentials.filter((item) => item.status !== 'superseded').length,
      activeCredentials: credentials.filter((item) => item.status === 'active').length,
      pendingCredentials: credentials.filter((item) => item.status === 'pending_confirmation').length,
      auditEntries: store.audits.length,
    },
    legacyRows: legacy.rows.length,
    migratedRows: displayList.filter((item) => item.mode === 'credential').length,
    demoRows: displayList.filter((item) => item.isDemo).length,
  }
}

export function runShareMigrationNow(input?: {
  baseline?: string
  includeDemo?: boolean
  maxLinksPerRun?: number
}): ShareMigrationResult {
  const legacy = readLegacyShareRows()
  const store = readShareStore()
  let baseline = input?.baseline
  if (baseline === undefined) {
    baseline =
      store.migration.baselineSource === 'fallback' ? SHARE_FALLBACK_BASELINE : store.migration.baseline
  }
  const result = migrateShares(
    {
      rows: legacy.rows,
      baseline,
      includeDemo: input?.includeDemo,
      maxLinksPerRun: input?.maxLinksPerRun,
    },
    { store, rows: legacy.rows, legacySource: legacy.source },
    (next) => writeShareStore(next),
  )
  return result
}

export function previewSharePage(input?: { baseline?: string }): SharePreviewItem[] {
  const legacy = readLegacyShareRows()
  return previewShareMigration({ rows: legacy.rows, baseline: input?.baseline })
}

export function accessShareLink(linkId: string, password: string, now?: string): ShareAccessResult {
  return accessShare({ linkId, password, now })
}

export function regenerateShareCredential(linkId: string): { ok: boolean; message: string } {
  const result = regenerateCredential({ linkId })
  return { ok: result.ok, message: result.message }
}

export function confirmShareCredential(input: {
  linkId: string
  maxAccess?: number
  expiresAt?: string
}): { ok: boolean; message: string } {
  const result = confirmCredential(input)
  return { ok: result.ok, message: result.message }
}

export function normalizeShareBaseline(input: string): string {
  return normalizeBaseline(input, SHARE_FALLBACK_BASELINE)
}

export function shareMigrationState(): ShareMigrationState {
  return readShareStore().migration
}

/** 导出凭证清单：只导出正式凭证，示例链接不会出现在 CSV 里。 */
export function exportShareCredentials(): { filename: string; content: string } {
  const page = loadSharePage()
  const header = [
    '链接编号',
    '凭证版本',
    '凭证状态',
    '目标数据集',
    '水印内容',
    '旧用户标识',
    '原分享生成时间',
    '有效期类型',
    '到期时间',
    '访问上限',
    '已访问次数',
    '待确认项',
  ]
  const lines = [header.join(',')]
  for (const item of page.credentials) {
    if (item.status === 'superseded') continue
    lines.push(
      [
        item.linkId,
        `v${item.version}`,
        item.status,
        item.targetDataset,
        item.watermark,
        item.legacyUserIdentifier ?? '',
        item.snapshot.generatedAt,
        item.validityKind,
        item.expiresAt ?? '',
        item.maxAccessKind === 'bounded' ? String(item.maxAccess ?? '') : item.maxAccessKind,
        String(item.usedCount),
        item.pendingReasons.map((reason) => reason.code).join('|'),
      ].join(','),
    )
  }
  return {
    filename: '数据分享-凭证清单.csv',
    content: `﻿${lines.join('\n')}`,
  }
}
