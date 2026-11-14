/**
 * 数据分享迁移引擎的离线自检。
 *
 * 用 node --experimental-strip-types 直接跑 TS 源码；引擎不依赖 window/localStorage，
 * 传入 store / rows 后完全在内存里执行，可验证迁移的幂等、断点与访问计数。
 *
 * 运行：make share-test
 *   或 node --experimental-strip-types --test frontend/tests/share-migration.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  accessShare,
  migrateShares,
  previewShareMigration,
  regenerateCredential,
  confirmCredential,
} from '../src/data/share-migration.ts'
import {
  emptyShareStore,
  type ShareCredential,
  type ShareStore,
} from '../src/data/share-schema.ts'
import {
  digestPassword,
  normalizeBaseline,
  parseAccessLimit,
  parseUntil,
} from '../src/data/share-parsing.ts'
import type { EntryRow } from '../src/data/types.ts'

const BASELINE = '2026-11-14T00:00:00.000Z'

function row(overrides: Partial<EntryRow>): EntryRow {
  return {
    id: 1,
    status: '已生效',
    pending: false,
    abnormal: false,
    ...overrides,
  } as EntryRow
}

function freshStore(): ShareStore {
  return emptyShareStore()
}

function activeCredential(store: ShareStore, linkId: string): ShareCredential {
  const found = store.credentials
    .filter((item) => item.linkId === linkId && item.status !== 'superseded')
    .sort((a, b) => b.version - a.version)[0]
  assert.ok(found, `expected active credential for ${linkId}`)
  return found
}

test('绝对日期与相对天数按迁移基准统一', () => {
  const absolute = parseUntil('2026-12-31', BASELINE)
  assert.equal(absolute.kind, 'absolute')
  assert.equal(absolute.kind === 'absolute' && absolute.expiresAt, '2026-12-31T00:00:00.000Z')

  const relative = parseUntil('30天', BASELINE)
  assert.equal(relative.kind, 'relative')
  assert.equal(relative.kind === 'relative' && relative.expiresAt, '2026-12-14T00:00:00.000Z')

  const chinese = parseUntil('九十日', BASELINE)
  assert.equal(chinese.kind === 'relative' && chinese.validityDays, 90)

  assert.equal(parseUntil('下周五', BASELINE).kind, 'unparsed')
  assert.equal(parseUntil('', BASELINE).kind, 'missing')
})

test('缺失访问上限视为待确认而非无限开放', () => {
  assert.equal(parseAccessLimit('').kind, 'missing')
  assert.equal(parseAccessLimit('三两下').kind, 'unparsed')
  assert.equal(parseAccessLimit('不限次数').kind, 'unlimited')
  assert.equal(parseAccessLimit('5次').kind === 'bounded' && parseAccessLimit('5次').maxAccess, 5)
})

test('迁移保留目标数据集、水印与旧用户标识，缺失上限/密码标待确认', () => {
  const rows = [
    row({
      id: 1,
      链接编号: 'SHAR-9001',
      目标数据集: '订单明细宽表',
      访问密码: 'secret',
      有效期天数: '30天',
      最大浏览次数: '3',
      水印内容: '内部资料 · 分享人 zhangwei',
      用户标识: 'zhangwei',
      分享时间: '2026-05-06',
    }),
    row({
      id: 2,
      链接编号: 'SHAR-9002',
      目标数据集: '留存明细',
      访问密码: 'ok',
      有效期天数: '30天',
      最大浏览次数: '',
      水印内容: '留存专项 · 分享人 chenjing',
      用户标识: 'chenjing',
    }),
    row({
      id: 3,
      链接编号: 'SHAR-9003',
      目标数据集: '风控流水',
      访问密码: '',
      有效期天数: '2026-12-31',
      最大浏览次数: '10',
      水印内容: '风控专用 · 分享人 wangbo',
      用户标识: 'wangbo',
    }),
  ]

  const store = freshStore()
  const result = migrateShares({ rows, baseline: BASELINE, now: '2026-11-14T08:00:00.000Z' }, {
    store,
    rows,
    legacySource: 'storage',
  })

  assert.equal(result.ok, true)
  assert.equal(result.created, 3)
  assert.equal(store.credentials.length, 3)

  const first = activeCredential(store, 'SHAR-9001')
  assert.equal(first.targetDataset, '订单明细宽表')
  assert.equal(first.watermark, '内部资料 · 分享人 zhangwei')
  assert.equal(first.legacyUserIdentifier, 'zhangwei')
  assert.equal(first.snapshot.generatedAt, '2026-05-06T00:00:00.000Z')
  assert.equal(first.expiresAt, '2026-12-14T00:00:00.000Z')
  assert.equal(first.status, 'active')
  assert.equal(first.passwordConfigured, true)
  assert.equal(first.passwordDigest === 'secret', false, '密码原文不能落盘')

  const second = activeCredential(store, 'SHAR-9002')
  assert.equal(second.status, 'pending_confirmation')
  assert.deepEqual(second.pendingReasons.map((item) => item.code), ['missing_access_limit'])
  assert.equal(second.maxAccessKind, 'missing')

  const third = activeCredential(store, 'SHAR-9003')
  assert.equal(third.status, 'pending_confirmation')
  assert.deepEqual(third.pendingReasons.map((item) => item.code), ['missing_password'])
})

test('重复迁移不复制凭证，已消耗访问次数不被重置', () => {
  const rows = [
    row({
      id: 1,
      链接编号: 'SHAR-9101',
      目标数据集: '渠道转化看板',
      访问密码: 'chan-88',
      有效期天数: '30天',
      最大浏览次数: '5',
      水印内容: '仅限渠道组 · 分享人 liuyang',
      用户标识: 'liuyang',
      已浏览次数: '3',
    }),
  ]
  const store = freshStore()
  migrateShares({ rows, baseline: BASELINE, now: '2026-11-14T08:00:00.000Z' }, {
    store,
    rows,
    legacySource: 'storage',
  })
  const firstCredential = activeCredential(store, 'SHAR-9101')
  assert.equal(firstCredential.usedCount, 3)

  // 首次访问消耗一次。
  const granted = accessShare({
    linkId: 'SHAR-9101',
    password: 'chan-88',
    now: '2026-11-14T09:00:00.000Z',
    rows,
    store,
  })
  assert.equal(granted.code, 'granted')
  assert.equal(granted.usedCount, 4)

  // 重复迁移：凭证数不变，计数保持 4。
  const rerun = migrateShares({ rows, baseline: BASELINE, now: '2026-11-14T10:00:00.000Z' }, {
    store,
    rows,
    legacySource: 'storage',
  })
  assert.equal(rerun.created, 0)
  assert.equal(rerun.preserved, 1)
  assert.equal(store.credentials.filter((item) => item.linkId === 'SHAR-9101').length, 1)
  assert.equal(activeCredential(store, 'SHAR-9101').usedCount, 4)
})

test('密码校验失败不消耗次数；上限用尽后拒绝', () => {
  const rows = [
    row({
      id: 1,
      链接编号: 'SHAR-9201',
      目标数据集: '库存快照',
      访问密码: 'pw-1',
      有效期天数: '2030-01-01',
      最大浏览次数: '2',
      水印内容: '供应链内参 · 分享人 zhaomin',
      用户标识: 'zhaomin',
    }),
  ]
  const store = freshStore()
  migrateShares({ rows, baseline: BASELINE, now: '2026-11-14T08:00:00.000Z' }, {
    store,
    rows,
    legacySource: 'storage',
  })

  const wrong = accessShare({ linkId: 'SHAR-9201', password: 'bad', rows, store })
  assert.equal(wrong.code, 'password_mismatch')
  assert.equal(wrong.consumed, false)
  assert.equal(activeCredential(store, 'SHAR-9201').usedCount, 0)

  const ok1 = accessShare({ linkId: 'SHAR-9201', password: 'pw-1', rows, store })
  const ok2 = accessShare({ linkId: 'SHAR-9201', password: 'pw-1', rows, store })
  const blocked = accessShare({ linkId: 'SHAR-9201', password: 'pw-1', rows, store })
  assert.equal(ok1.code, 'granted')
  assert.equal(ok2.code, 'granted')
  assert.equal(blocked.code, 'limit_reached')
  assert.equal(blocked.consumed, false)
  assert.equal(activeCredential(store, 'SHAR-9201').usedCount, 2)
})

test('待确认凭证不开放；人工补齐上限后恢复', () => {
  const rows = [
    row({
      id: 1,
      链接编号: 'SHAR-9301',
      目标数据集: '留存明细',
      访问密码: 'ok',
      有效期天数: '30天',
      最大浏览次数: '',
      水印内容: '留存专项 · 分享人 chenjing',
      用户标识: 'chenjing',
    }),
  ]
  const store = freshStore()
  migrateShares({ rows, baseline: BASELINE, now: '2026-11-14T08:00:00.000Z' }, {
    store,
    rows,
    legacySource: 'storage',
  })

  const denied = accessShare({ linkId: 'SHAR-9301', password: 'ok', rows, store })
  assert.equal(denied.code, 'pending_confirmation')
  assert.equal(activeCredential(store, 'SHAR-9301').usedCount, 0)

  const confirmed = confirmCredential({
    linkId: 'SHAR-9301',
    maxAccess: 10,
    now: '2026-11-14T09:00:00.000Z',
    store,
  })
  assert.equal(confirmed.ok, true)
  const granted = accessShare({ linkId: 'SHAR-9301', password: 'ok', rows, store })
  assert.equal(granted.code, 'granted')
  assert.equal(granted.usedCount, 1)

  // 再次迁移不会把人工确认的上限冲掉。
  migrateShares({ rows, baseline: BASELINE, now: '2026-11-14T10:00:00.000Z' }, {
    store,
    rows,
    legacySource: 'storage',
  })
  const credential = activeCredential(store, 'SHAR-9301')
  assert.equal(credential.maxAccess, 10)
  assert.equal(credential.status, 'active')
  assert.equal(credential.usedCount, 1)
})

test('迁移中断后从最后一个完整链接继续，且旧链接仍可用', () => {
  const rows = [
    row({
      id: 1,
      链接编号: 'SHAR-9401',
      目标数据集: 'A',
      访问密码: 'a',
      有效期天数: '30天',
      最大浏览次数: '5',
      水印内容: 'A · 分享人 user-a',
      用户标识: 'user-a',
    }),
    row({
      id: 2,
      链接编号: 'SHAR-9402',
      目标数据集: 'B',
      访问密码: 'b',
      有效期天数: '30天',
      最大浏览次数: '5',
      水印内容: 'B · 分享人 user-b',
      用户标识: 'user-b',
    }),
    row({
      id: 3,
      链接编号: 'SHAR-9403',
      目标数据集: 'C',
      访问密码: 'c',
      有效期天数: '30天',
      最大浏览次数: '5',
      水印内容: 'C · 分享人 user-c',
      用户标识: 'user-c',
    }),
  ]
  const store = freshStore()
  let commits = 0
  const partial = migrateShares({ rows, baseline: BASELINE, now: '2026-11-14T08:00:00.000Z' }, {
    store,
    rows: rows.slice(0, 2),
    legacySource: 'storage',
  }, () => {
    commits += 1
  })
  assert.equal(partial.status, 'completed')
  assert.equal(store.credentials.length, 2)
  assert.ok(commits >= 2)
  assert.equal(store.migration.lastCompletedLinkId, 'SHAR-9402')

  // 加上第三条后重跑：从断点继续，只补 SHAR-9403。
  const resumed = migrateShares({ rows, baseline: BASELINE, now: '2026-11-14T09:00:00.000Z' }, {
    store,
    rows,
    legacySource: 'storage',
  })
  assert.equal(resumed.created, 1)
  assert.equal(resumed.resumedFrom, 'SHAR-9402')
  assert.equal(store.credentials.length, 3)
  assert.equal(store.migration.totalLinks, 3)
})

test('重新生成凭证保留原分享快照生成时间与旧用户标识', () => {
  const rows = [
    row({
      id: 1,
      链接编号: 'SHAR-9501',
      目标数据集: '归因结果',
      访问密码: 'mkt',
      有效期天数: '2027-01-01',
      最大浏览次数: '9',
      水印内容: '营销复盘 · 分享人 sunqi',
      用户标识: 'sunqi',
      分享时间: '2026-09-01',
      已浏览次数: '2',
    }),
  ]
  const store = freshStore()
  migrateShares({ rows, baseline: BASELINE, now: '2026-11-14T08:00:00.000Z' }, {
    store,
    rows,
    legacySource: 'storage',
  })
  const before = activeCredential(store, 'SHAR-9501')

  const regenerated = regenerateCredential({
    linkId: 'SHAR-9501',
    now: '2026-12-01T00:00:00.000Z',
    store,
  })
  assert.equal(regenerated.ok, true)
  const after = activeCredential(store, 'SHAR-9501')
  assert.equal(after.version, 2)
  assert.notEqual(after.credentialId, before.credentialId)
  assert.equal(after.snapshot.generatedAt, '2026-09-01T00:00:00.000Z')
  assert.equal(after.generatedAt, '2026-12-01T00:00:00.000Z')
  assert.equal(after.watermark, '营销复盘 · 分享人 sunqi')
  assert.equal(after.legacyUserIdentifier, 'sunqi')
  assert.equal(after.usedCount, 2)
  assert.equal(before.status, 'superseded')
})

test('示例与构建产物链接不进入正式凭证记录', () => {
  const rows = [
    row({
      id: 1,
      链接编号: 'SHAR-0001',
      目标数据集: '数据分享样例1',
      访问密码: 'x',
      有效期天数: '30天',
      最大浏览次数: '5',
      水印内容: '样例',
    }),
    row({
      id: 2,
      链接编号: 'SHAR-9601',
      目标数据集: '正式数据集',
      访问密码: 'x',
      有效期天数: '30天',
      最大浏览次数: '5',
      水印内容: '正式 · 分享人 real',
      用户标识: 'real',
    }),
    row({
      id: 3,
      链接编号: 'SHAR-9602#4821',
      目标数据集: '构建产物',
      访问密码: 'x',
      有效期天数: '30天',
      最大浏览次数: '5',
      水印内容: '构建',
    }),
  ]
  const store = freshStore()
  const demoFirst = previewShareMigration({ rows, baseline: BASELINE, now: '2026-11-14T08:00:00.000Z' })
  assert.equal(demoFirst.find((item) => item.linkId === 'SHAR-0001')?.isDemo, true)
  assert.equal(demoFirst.find((item) => item.linkId === 'SHAR-9602#4821')?.isDemo, true)

  const result = migrateShares({ rows, baseline: BASELINE, now: '2026-11-14T08:00:00.000Z' }, {
    store,
    rows,
    legacySource: 'storage',
  })
  assert.equal(result.skippedDemo, 2)
  assert.equal(store.credentials.length, 1)
  assert.equal(store.credentials[0].linkId, 'SHAR-9601')
  assert.ok(store.audits.some((item) => item.code === 'demo_link_skipped'))
})

test('迁移完成前旧链接继续可用，且计数会并入凭证', () => {
  const rows = [
    row({
      id: 1,
      链接编号: 'SHAR-9701',
      目标数据集: '旧版数据集',
      访问密码: 'legacy-pw',
      有效期天数: '2027-06-01',
      最大浏览次数: '4',
      水印内容: '旧版水印 · 分享人 olduser',
      用户标识: 'olduser',
    }),
  ]
  const store = freshStore()

  // 尚未迁移：凭证不存在，旧记录直接放行。
  const legacyAccess = accessShare({
    linkId: 'SHAR-9701',
    password: 'legacy-pw',
    now: '2026-11-13T08:00:00.000Z',
    rows,
    store,
  })
  assert.equal(legacyAccess.code, 'granted')
  assert.equal(legacyAccess.mode, 'legacy')
  assert.equal(legacyAccess.usedCount, 1)
  assert.equal(store.legacyAccess['SHAR-9701'], 1)

  // 迁移：旧计数并入新凭证，不被清零。
  migrateShares({ rows, baseline: BASELINE, now: '2026-11-14T08:00:00.000Z' }, {
    store,
    rows,
    legacySource: 'storage',
  })
  const credential = activeCredential(store, 'SHAR-9701')
  assert.equal(credential.usedCount, 1)
  assert.equal(credential.watermark, '旧版水印 · 分享人 olduser')
  assert.equal(credential.legacyUserIdentifier, 'olduser')
})

test('单次批量上限：保留 running 断点，下一次继续', () => {
  const rows = Array.from({ length: 4 }, (_, index) =>
    row({
      id: index + 1,
      链接编号: `SHAR-B${index + 1}`,
      目标数据集: `批次数据集${index + 1}`,
      访问密码: `pw-${index + 1}`,
      有效期天数: '30天',
      最大浏览次数: '5',
      水印内容: `批次 · 分享人 user-${index + 1}`,
      用户标识: `user-${index + 1}`,
    }),
  )
  const store = freshStore()
  const first = migrateShares(
    { rows, baseline: BASELINE, now: '2026-11-14T08:00:00.000Z', maxLinksPerRun: 2 },
    { store, rows, legacySource: 'storage' },
  )
  assert.equal(first.status, 'running')
  assert.equal(first.processed, 2)
  assert.equal(store.credentials.length, 2)
  assert.equal(store.migration.lastCompletedLinkId, 'SHAR-B2')

  const second = migrateShares(
    { rows, baseline: BASELINE, now: '2026-11-14T08:01:00.000Z', maxLinksPerRun: 2 },
    { store, rows, legacySource: 'storage' },
  )
  assert.equal(second.status, 'completed')
  assert.equal(second.resumedFrom, 'SHAR-B2')
  assert.equal(second.created, 2)
  assert.equal(store.credentials.length, 4)
})

test('密码摘要与盐绑定，原文不会出现在存储中', () => {
  const digest = digestPassword('secret', 'salt-a')
  assert.equal(digest.length, 16)
  assert.notEqual(digest, digestPassword('secret', 'salt-b'))
  assert.notEqual(digest, 'secret')
})

test('迁移基准规范化：无时区日期按 UTC 零点', () => {
  assert.equal(normalizeBaseline('2026-11-14', BASELINE), '2026-11-14T00:00:00.000Z')
  assert.equal(normalizeBaseline('2026-11-14T08:30:15.900Z', BASELINE), '2026-11-14T08:30:15.000Z')
  assert.throws(() => normalizeBaseline('不是日期', BASELINE))
})
