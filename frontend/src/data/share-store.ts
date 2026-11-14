/**
 * 数据分享凭证的本地持久化层。
 *
 * 一个 localStorage 文档内按「表」组织，写入时整体替换并做版本号校验。
 * 迁移按链接粒度落盘：每完成一个链接立即保存，凭证与旁证在同一次写入里，
 * 中断后从 migration.lastCompletedIndex 之后继续，已写入的凭证不会重复生成，
 * 已消耗的访问次数也不会被后续重跑覆盖。
 */

import { SEED_ROWS } from './seed'
import { SHARE_STORE_KEY, emptyShareStore } from './share-schema'
import type { ShareStore } from './share-schema'
import type { EntryRow } from './types'

const SHARE_BASELINE_ENV_KEYS = [
  'VITE_SHARE_MIGRATION_BASELINE',
  'VITE_SHARE_BASELINE',
] as const

export { SHARE_STORE_KEY }

export function readEnvBaseline(): string | null {
  try {
    const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
    if (!env) return null
    for (const key of SHARE_BASELINE_ENV_KEYS) {
      const value = env[key]
      if (typeof value === 'string' && value.trim() !== '') {
        return value.trim()
      }
    }
  } catch {
    // import.meta.env 在纯 Node 脚本里可能不存在，退回 localStorage / 回退值。
  }
  return null
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function hasLocalStorage(): boolean {
  return typeof window !== 'undefined' && Boolean(window.localStorage)
}

/** 存储结构升级：旧版本文档补齐缺失的表，未来字段只增不改。 */
function upgradeStore(raw: unknown): ShareStore {
  const base = emptyShareStore()
  if (!raw || typeof raw !== 'object') {
    return base
  }
  const incoming = raw as Partial<ShareStore>
  return {
    schemaVersion: base.schemaVersion,
    credentialFormatVersion: base.credentialFormatVersion,
    migration: { ...base.migration, ...(incoming.migration ?? {}) },
    credentials: Array.isArray(incoming.credentials) ? incoming.credentials : [],
    audits: Array.isArray(incoming.audits) ? incoming.audits : [],
    legacyAccess:
      incoming.legacyAccess && typeof incoming.legacyAccess === 'object'
        ? { ...incoming.legacyAccess }
        : {},
  }
}

let cache: ShareStore | null = null

export function readShareStore(): ShareStore {
  if (cache) return clone(cache)
  if (!hasLocalStorage()) {
    cache = emptyShareStore()
    return clone(cache)
  }
  const raw = window.localStorage.getItem(SHARE_STORE_KEY)
  if (!raw) {
    cache = emptyShareStore()
    return clone(cache)
  }
  try {
    cache = upgradeStore(JSON.parse(raw))
  } catch {
    // 文档损坏时保留原值到旁证键，避免静默丢数据。
    const quarantineKey = `${SHARE_STORE_KEY}:corrupt:${Date.now()}`
    try {
      window.localStorage.setItem(quarantineKey, raw)
    } catch {
      // 配额不足时仍允许迁移继续，旁证写不进去不影响内存结构。
    }
    cache = emptyShareStore()
  }
  return clone(cache)
}

export function writeShareStore(store: ShareStore): void {
  cache = clone(store)
  if (!hasLocalStorage()) return
  window.localStorage.setItem(SHARE_STORE_KEY, JSON.stringify(store))
}

export function clearShareStoreCache(): void {
  cache = null
}

/** 旧分享记录：优先读 localStorage 里的 share 模块，首次打开回退到示例数据。 */
export function readLegacyShareRows(): { rows: EntryRow[]; source: 'storage' | 'seed' } {
  const fallback = clone(SEED_ROWS.share ?? [])
  if (!hasLocalStorage()) {
    return { rows: fallback, source: 'seed' }
  }
  const raw = window.localStorage.getItem('interactive-analytics-lab:entries')
  if (!raw) {
    return { rows: fallback, source: 'seed' }
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    if (Array.isArray(parsed.share)) {
      return { rows: clone(parsed.share), source: 'storage' }
    }
    return { rows: fallback, source: 'seed' }
  } catch {
    return { rows: fallback, source: 'seed' }
  }
}
