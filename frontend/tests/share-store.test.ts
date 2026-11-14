/**
 * 浏览器集成自检：用最小 localStorage 桩替掉 window，验证存储层的
 * 播种、损坏隔离、计数持久化与示例链接不落库。
 *
 * 运行：node tests/run.mjs 会先跑这套再跑纯引擎测试。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

const memory = new Map<string, string>()
const localStorageStub = {
  getItem(key: string): string | null {
    return memory.has(key) ? (memory.get(key) as string) : null
  },
  setItem(key: string, value: string): void {
    memory.set(key, String(value))
  },
  removeItem(key: string): void {
    memory.delete(key)
  },
  clear(): void {
    memory.clear()
  },
  key(): string | null {
    return null
  },
  get length(): number {
    return memory.size
  },
}
;(globalThis as { window?: unknown }).window = { localStorage: localStorageStub }

const {
  clearShareStoreCache,
  readLegacyShareRows,
  readShareStore,
  writeShareStore,
  SHARE_STORE_KEY,
} = await import('../src/data/share-store')
const { emptyShareStore } = await import('../src/data/share-schema')
const { buildDisplays, accessShare } = await import('../src/data/share-migration')
const { loadSharePage } = await import('../src/api/share-service')

const ENTRIES_KEY = 'interactive-analytics-lab:entries'

function reboot(): void {
  clearShareStoreCache()
}

test('首次打开：回退到示例数据，且共享存储初始为空', () => {
  memory.clear()
  reboot()
  const legacy = readLegacyShareRows()
  assert.ok(legacy.rows.length > 0)
  const store = readShareStore()
  assert.equal(store.credentials.length, 0)
  assert.equal(store.migration.status, 'idle')
})

test('损坏文档被隔离而不是静默覆盖', () => {
  memory.clear()
  reboot()
  memory.set(SHARE_STORE_KEY, '{ not json')
  const store = readShareStore()
  assert.equal(store.credentials.length, 0)
  const quarantine = [...memory.keys()].filter((key) => key.includes(':corrupt:'))
  assert.equal(quarantine.length, 1)
  assert.equal(memory.get(quarantine[0]), '{ not json')
})

test('迁移完成前的水印展示沿用旧原文', () => {
  memory.clear()
  reboot()
  const legacy = readLegacyShareRows()
  const store = emptyShareStore()
  const displays = buildDisplays(legacy.rows, store, '2026-11-14T00:00:00.000Z')
  const first = displays[legacy.rows[0]['链接编号'] as string]
  assert.equal(first.mode, 'legacy')
  assert.equal(first.watermark, legacy.rows[0]['水印内容'])
  assert.equal(first.legacyUserIdentifier, legacy.rows[0]['用户标识'])
})

test('页面加载：示例链接与正式链接分开统计，凭证不凭空出现', () => {
  memory.clear()
  reboot()
  const page = loadSharePage()
  assert.equal(page.schemaVersion, 1)
  assert.equal(page.credentialFormatVersion, 1)
  assert.equal(page.summary.credentials, 0)
  assert.ok(page.demoRows >= 1)
  assert.equal(page.legacyRows, page.rows.length)
})

test('存储写入后可重读，凭证与计数保持一致', () => {
  memory.clear()
  reboot()
  const store = emptyShareStore()
  store.credentials.push({
    credentialId: 'SHAR-X:v1',
    linkId: 'SHAR-X',
    version: 1,
    formatVersion: 1,
    status: 'active',
    pendingReasons: [],
    confirmedCodes: [],
    passwordConfigured: true,
    passwordDigest: 'deadbeefdeadbeef',
    passwordSalt: 'salt',
    targetDataset: '数据集',
    watermark: '水印 · 分享人 u',
    legacyUserIdentifier: 'u',
    validityRaw: '30天',
    validityKind: 'relative',
    validityDays: 30,
    expiresAt: '2026-12-14T00:00:00.000Z',
    maxAccessRaw: '5',
    maxAccessKind: 'bounded',
    maxAccess: 5,
    usedCount: 2,
    generatedAt: '2026-11-14T00:00:00.000Z',
    updatedAt: '2026-11-14T00:00:00.000Z',
    migrationBaseline: '2026-11-14T00:00:00.000Z',
    snapshot: {
      linkId: 'SHAR-X',
      targetDataset: '数据集',
      watermark: '水印 · 分享人 u',
      legacyUserIdentifier: 'u',
      generatedAt: '2026-05-06T00:00:00.000Z',
      generatedAtRaw: '2026-05-06',
      generatedAtSource: 'field',
      capturedAt: '2026-11-14T00:00:00.000Z',
      legacyStatus: '已生效',
      legacyFields: {},
      source: 'legacy',
    },
    auditIds: [],
  })
  writeShareStore(store)
  reboot()
  const reread = readShareStore()
  assert.equal(reread.credentials.length, 1)
  assert.equal(reread.credentials[0].usedCount, 2)
  assert.ok(memory.get(SHARE_STORE_KEY)?.includes('SHAR-X:v1'))
})

test('迁移存储与旧记录存储互不影响', () => {
  memory.clear()
  reboot()
  memory.set(ENTRIES_KEY, JSON.stringify({ share: [{ id: 1, status: '已生效', pending: false, abnormal: false, 链接编号: 'SHAR-OLD', 目标数据集: '旧', 访问密码: 'p', 有效期天数: '30天', 最大浏览次数: '2', 水印内容: '旧水印' }] }))
  const legacy = readLegacyShareRows()
  assert.equal(legacy.rows.length, 1)
  assert.equal(legacy.source, 'storage')
  writeShareStore(emptyShareStore())
  assert.ok(memory.has(ENTRIES_KEY), '旧记录不能被迁移覆盖')
  assert.equal(memory.get(ENTRIES_KEY)?.includes('SHAR-OLD'), true)
})

test('访问函数在没有凭证时按旧记录判定，不写凭证表', () => {
  memory.clear()
  reboot()
  const rows = [
    {
      id: 1,
      status: '已生效',
      pending: false,
      abnormal: false,
      链接编号: 'SHAR-LEGACY',
      目标数据集: '旧数据集',
      访问密码: 'oldpw',
      有效期天数: '2027-01-01',
      最大浏览次数: '3',
      水印内容: '旧水印 · 分享人 olduser',
      用户标识: 'olduser',
    },
  ] as never[]
  const store = readShareStore()
  const result = accessShare({ linkId: 'SHAR-LEGACY', password: 'oldpw', rows, store })
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'legacy')
  assert.equal(result.usedCount, 1)
  assert.equal(store.credentials.length, 0)
  assert.equal(store.legacyAccess['SHAR-LEGACY'], 1)
})

test('页面服务全流程：迁移 → 访问 → 重新生成 → 导出', async () => {
  memory.clear()
  reboot()
  const { runShareMigrationNow, accessShareLink, regenerateShareCredential, exportShareCredentials } =
    await import('../src/api/share-service')
  const legacy = readLegacyShareRows()
  const result = runShareMigrationNow({ baseline: '2026-11-14T00:00:00.000Z' })
  assert.equal(result.status, 'completed')
  assert.equal(result.created, 6)

  const page = loadSharePage()
  assert.equal(page.summary.credentials, 6)
  assert.equal(page.summary.pendingCredentials, 3)

  // SHAR-2102 旧计数 3，上限 5：再访问一次应放行且变成 4。
  const granted = accessShareLink('SHAR-2102', 'chan-88')
  assert.equal(granted.code, 'granted')
  assert.equal(granted.usedCount, 4)
  assert.equal(loadSharePage().summary.activeCredentials >= 1, true)

  // 密码错误不消耗次数。
  const wrong = accessShareLink('SHAR-2102', 'nope')
  assert.equal(wrong.code, 'password_mismatch')
  assert.equal(wrong.consumed, false)
  assert.equal(
    loadSharePage().credentials.find((item) => item.linkId === 'SHAR-2102')?.usedCount,
    4,
  )

  // 示例链接被跳过，不产生凭证，也不能凭旧密码开放。
  const demo = accessShareLink('SHAR-0001', '数据分享样例1')
  assert.equal(demo.mode, 'none')

  // 重新生成：版本递增，原分享快照生成时间不变，计数沿用。
  const before = loadSharePage().credentials.find((item) => item.linkId === 'SHAR-2101')
  assert.ok(before)
  const regen = regenerateShareCredential('SHAR-2101')
  assert.equal(regen.ok, true)
  const after = loadSharePage().credentials.find(
    (item) => item.linkId === 'SHAR-2101' && item.status !== 'superseded',
  )
  assert.deepEqual(after?.version, 2)
  assert.equal(after?.snapshot.generatedAt, before?.snapshot.generatedAt)
  assert.equal(after?.watermark, before?.watermark)

  const exported = exportShareCredentials()
  assert.ok(exported.content.includes('SHAR-2102'))
  assert.equal(exported.content.includes('SHAR-0001'), false, '示例链接不进入正式导出')
  assert.equal(legacy.rows.length, 7)
})
