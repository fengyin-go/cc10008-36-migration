import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  accessShareLink,
  confirmShareCredential,
  exportShareCredentials,
  loadSharePage,
  normalizeShareBaseline,
  previewSharePage,
  regenerateShareCredential,
  runShareMigrationNow,
  type SharePageData,
} from '@/api/share-service'
import type { ShareAccessResult, SharePreviewItem } from '@/data/share-schema'

const STATUS_LABEL: Record<string, string> = {
  idle: '未开始',
  running: '迁移中',
  completed: '已完成',
  failed: '中断',
  active: '生效',
  pending_confirmation: '待确认',
  revoked: '已撤销',
  superseded: '历史版本',
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  return String(value)
}

function download(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export default function ShareView() {
  const [page, setPage] = useState<SharePageData | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [baselineInput, setBaselineInput] = useState('')
  const [preview, setPreview] = useState<SharePreviewItem[]>([])
  const [accessLinkId, setAccessLinkId] = useState('')
  const [accessPassword, setAccessPassword] = useState('')
  const [accessResult, setAccessResult] = useState<ShareAccessResult | null>(null)
  const [confirmMax, setConfirmMax] = useState('')
  const [batchSize, setBatchSize] = useState('')
  const [filter, setFilter] = useState('')

  const reload = useCallback(() => {
    setError('')
    try {
      const payload = loadSharePage()
      setPage(payload)
      setBaselineInput((prev) => prev || payload.baseline)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '数据分享读取失败')
    }
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const runMigration = useCallback(() => {
    setNotice('')
    setError('')
    try {
      if (baselineInput.trim() !== '') normalizeShareBaseline(baselineInput.trim())
      const batch = batchSize.trim() === '' ? undefined : Number(batchSize)
      if (batch !== undefined && (!Number.isInteger(batch) || batch <= 0)) {
        setError('单次批量上限必须是正整数')
        return
      }
      const result = runShareMigrationNow({
        baseline: baselineInput.trim() === '' ? undefined : baselineInput.trim(),
        maxLinksPerRun: batch,
      })
      setNotice(result.message)
      setPreview([])
      reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '迁移失败')
    }
  }, [baselineInput, batchSize, reload])

  const doPreview = useCallback(() => {
    setNotice('')
    setError('')
    try {
      const items = previewSharePage({
        baseline: baselineInput.trim() === '' ? undefined : baselineInput.trim(),
      })
      setPreview(items)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '预检失败')
    }
  }, [baselineInput])

  const doAccess = useCallback(() => {
    setNotice('')
    setError('')
    setAccessResult(null)
    try {
      setAccessResult(accessShareLink(accessLinkId.trim(), accessPassword))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '访问校验失败')
    }
  }, [accessLinkId, accessPassword])

  const displays = page ? Object.values(page.displays) : []
  const visibleDisplays = useMemo(() => {
    const keyword = filter.trim()
    if (keyword === '') return displays
    return displays.filter((item) =>
      [item.linkId, item.watermark, item.legacyUserIdentifier ?? '']
        .join(' ')
        .includes(keyword),
    )
  }, [displays, filter])

  const currentCredentials = page?.credentials.filter((item) => item.status !== 'superseded') ?? []

  return (
    <section className="page" data-module="share">
      <header className="page-head">
        <div>
          <h2>数据分享管理</h2>
          <p className="page-desc">
            旧记录用自由文本保存有效期与访问上限，已迁移为带版本凭证；迁移期间原链接继续可用，
            缺失上限或密码的凭证标为待确认，不会自动开放。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={runMigration}>
            {page?.migration.status === 'running' || page?.migration.status === 'failed'
              ? '从中断处继续迁移'
              : '执行分享凭证迁移'}
          </button>
          <button className="btn" type="button" onClick={doPreview}>迁移预检</button>
          <button
            className="btn"
            type="button"
            onClick={() => {
              const payload = exportShareCredentials()
              download(payload.filename, payload.content)
            }}
          >
            导出凭证清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        <article className="stat-card">
          <span className="stat-label">旧记录 / 已迁凭证</span>
          <strong className="stat-value">
            {page ? `${page.legacyRows} / ${page.migratedRows}` : '—'}
          </strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">生效凭证</span>
          <strong className="stat-value">{page?.summary.activeCredentials ?? 0}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">待确认凭证</span>
          <strong className="stat-value">{page?.summary.pendingCredentials ?? 0}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">旁证条目</span>
          <strong className="stat-value">{page?.summary.auditEntries ?? 0}</strong>
        </article>
      </div>

      <div className="share-migration-bar">
        <label className="filter-item">
          <span>迁移基准（绝对日期与相对天数按此换算）</span>
          <input
            value={baselineInput}
            placeholder="2026-11-14T00:00:00Z"
            onChange={(event) => setBaselineInput(event.target.value)}
          />
        </label>
        <label className="filter-item">
          <span>单次批量上限（可选，留空表示一次迁完）</span>
          <input
            value={batchSize}
            placeholder="如 50"
            onChange={(event) => setBatchSize(event.target.value)}
          />
        </label>
        <div className="share-migration-meta">
          <span>
            迁移状态：<strong>{STATUS_LABEL[page?.migration.status ?? 'idle']}</strong>
            {page?.migration.status === 'running' && page.migration.lastCompletedLinkId
              ? `，已到最后一个完整链接 ${page.migration.lastCompletedLinkId}`
              : ''}
            {page ? `（${page.migration.processedCount}/${page.migration.totalLinks}）` : ''}
          </span>
          <span>
            结构版本 v{page?.schemaVersion ?? 1} / 凭证格式 v{page?.credentialFormatVersion ?? 1}
          </span>
          <span>
            基准来源：{page?.migration.baselineSource ?? 'fallback'}（{page?.baseline ?? '—'}）
          </span>
          {page && page.migration.failedCount > 0 && (
            <span className="error-text">上次中断：{page.migration.lastError ?? '未知错误'}</span>
          )}
        </div>
      </div>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        <label className="filter-item">
          <span>按链接 / 水印检索</span>
          <input
            value={filter}
            placeholder="输入链接编号、水印或旧用户标识"
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilter('')}>重置条件</button>
      </form>

      <h3 className="share-section-title">链接视图（迁移前沿用旧水印原文，迁移后按版本凭证计数）</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>链接编号</th>
            <th>目标数据集</th>
            <th>水印内容</th>
            <th>旧用户标识</th>
            <th>凭证版本</th>
            <th>凭证状态</th>
            <th>有效期类型</th>
            <th>到期时间</th>
            <th>访问计数 / 上限</th>
            <th>待确认项</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {visibleDisplays.map((item) => (
            <tr key={item.linkId}>
              <td>{item.linkId}</td>
              <td>{displayValue(item.targetDataset)}</td>
              <td>{item.watermark || '—'}</td>
              <td>{displayValue(item.legacyUserIdentifier)}</td>
              <td>{item.credentialVersion === null ? '旧记录' : `v${item.credentialVersion}`}</td>
              <td>
                {item.mode === 'legacy' ? '迁移前沿用旧记录' : STATUS_LABEL[item.credentialStatus ?? ''] ?? item.credentialStatus}
                {item.isDemo ? '（示例，不迁移）' : ''}
              </td>
              <td>{item.mode === 'credential' ? item.validityKind : '—'}</td>
              <td>{displayValue(item.expiresAt)}</td>
              <td>
                {item.usedCount} / {item.maxAccessKind === 'bounded' ? item.maxAccess : item.maxAccessKind}
              </td>
              <td>
                {item.pendingReasons.length === 0
                  ? '—'
                  : item.pendingReasons.map((reason) => reason.code).join('、')}
              </td>
              <td className="row-actions">
                {item.mode === 'credential' && item.credentialStatus !== 'revoked' && (
                  <>
                    <button
                      className="link"
                      type="button"
                      onClick={() => {
                        setNotice('')
                        setError('')
                        const result = regenerateShareCredential(item.linkId)
                        if (!result.ok) setError(result.message)
                        else setNotice(result.message)
                        reload()
                      }}
                    >
                      重新生成凭证
                    </button>
                    <button
                      className="link"
                      type="button"
                      onClick={() => {
                        setNotice('')
                        setError('')
                        const max = Number(confirmMax)
                        if (confirmMax.trim() !== '' && (!Number.isInteger(max) || max < 0)) {
                          setError('访问上限必须是非负整数')
                          return
                        }
                        const result = confirmShareCredential({
                          linkId: item.linkId,
                          maxAccess: confirmMax.trim() === '' ? undefined : max,
                        })
                        if (!result.ok) setError(result.message)
                        else setNotice(result.message)
                        reload()
                      }}
                    >
                      确认访问上限
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
          {visibleDisplays.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={11}>暂无数据分享数据</td>
            </tr>
          )}
        </tbody>
      </table>

      <h3 className="share-section-title">版本凭证（旧分享快照按链接保留）</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>凭证 ID</th>
            <th>链接编号</th>
            <th>版本</th>
            <th>状态</th>
            <th>目标数据集</th>
            <th>水印（含旧用户标识）</th>
            <th>原分享生成时间</th>
            <th>凭证生成时间</th>
            <th>已访问 / 上限</th>
            <th>待确认原因</th>
          </tr>
        </thead>
        <tbody>
          {currentCredentials.map((item) => (
            <tr key={item.credentialId}>
              <td>{item.credentialId}</td>
              <td>{item.linkId}</td>
              <td>v{item.version}</td>
              <td>{STATUS_LABEL[item.status] ?? item.status}</td>
              <td>{item.targetDataset}</td>
              <td>{item.watermark}</td>
              <td>{item.snapshot.generatedAt}</td>
              <td>{item.generatedAt}</td>
              <td>{item.usedCount} / {item.maxAccessKind === 'bounded' ? item.maxAccess : item.maxAccessKind}</td>
              <td>
                {item.pendingReasons.length === 0
                  ? '—'
                  : item.pendingReasons.map((reason) => reason.message).join('；')}
              </td>
            </tr>
          ))}
          {currentCredentials.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={10}>尚未生成版本凭证</td>
            </tr>
          )}
        </tbody>
      </table>

      <h3 className="share-section-title">访问与旁证</h3>
      <div className="share-access-panel">
        <label className="filter-item">
          <span>链接编号</span>
          <input value={accessLinkId} placeholder="SHAR-0001" onChange={(event) => setAccessLinkId(event.target.value)} />
        </label>
        <label className="filter-item">
          <span>访问密码</span>
          <input
            value={accessPassword}
            type="password"
            placeholder="密码校验失败不消耗次数"
            onChange={(event) => setAccessPassword(event.target.value)}
          />
        </label>
        <label className="filter-item">
          <span>待确认补录的上限（可选）</span>
          <input value={confirmMax} placeholder="如 20" onChange={(event) => setConfirmMax(event.target.value)} />
        </label>
        <button className="btn primary" type="button" onClick={doAccess}>校验并访问</button>
        {accessResult && (
          <p className={accessResult.ok ? 'share-access-ok' : 'share-access-bad'}>
            [{accessResult.code}] {accessResult.message}
            {accessResult.consumed ? `（已用 ${accessResult.usedCount} 次）` : '（未消耗次数）'}
            {accessResult.credentialVersion !== null ? `，凭证 v${accessResult.credentialVersion}` : '，迁移前旧链接'}
            {accessResult.legacyUserIdentifier
              ? `，水印用户 ${accessResult.legacyUserIdentifier}`
              : ''}
          </p>
        )}
      </div>

      {preview.length > 0 && (
        <>
          <h3 className="share-section-title">预检结果（不落库、不生成凭证）</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>链接编号</th>
                <th>示例链接</th>
                <th>目标数据集</th>
                <th>水印</th>
                <th>密码</th>
                <th>有效期类型</th>
                <th>到期时间</th>
                <th>上限类型</th>
                <th>上限</th>
                <th>已访问</th>
                <th>预计状态</th>
                <th>旁证数</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((item) => (
                <tr key={item.linkId} className={item.isDemo ? 'share-demo-row' : ''}>
                  <td>{item.linkId}</td>
                  <td>{item.isDemo ? '是（跳过）' : '否'}</td>
                  <td>{item.targetDataset || '—'}</td>
                  <td>{item.watermark}</td>
                  <td>{item.passwordConfigured ? '已配置' : '缺失（待确认）'}</td>
                  <td>{item.validityKind}</td>
                  <td>{displayValue(item.expiresAt)}</td>
                  <td>{item.maxAccessKind}</td>
                  <td>{item.maxAccess === null ? '—' : item.maxAccess}</td>
                  <td>{item.usedCount}</td>
                  <td>{STATUS_LABEL[item.status] ?? item.status}</td>
                  <td>{item.auditCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3 className="share-section-title">旁证记录（解析失败项留底）</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>旁证 ID</th>
            <th>链接</th>
            <th>类型</th>
            <th>代码</th>
            <th>级别</th>
            <th>字段</th>
            <th>原文</th>
            <th>说明</th>
            <th>基准</th>
            <th>次数</th>
            <th>最近出现</th>
          </tr>
        </thead>
        <tbody>
          {(page?.audits ?? []).map((audit) => (
            <tr key={audit.id} className={audit.severity === 'error' ? 'share-audit-error' : ''}>
              <td>{audit.id}</td>
              <td>{audit.linkId}</td>
              <td>{audit.kind}</td>
              <td>{audit.code}</td>
              <td>{audit.severity}</td>
              <td>{audit.field}</td>
              <td>{audit.rawValue || '（空）'}</td>
              <td>{audit.message}</td>
              <td>{audit.baseline}</td>
              <td>{audit.occurrences}</td>
              <td>{audit.lastSeenAt}</td>
            </tr>
          ))}
          {(page?.audits ?? []).length === 0 && (
            <tr>
              <td className="empty-state" colSpan={11}>暂无旁证记录</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>
          共 {page?.summary.legacyRows ?? 0} 条旧分享记录，{page?.summary.credentials ?? 0} 条有效凭证；
          示例 / 构建产物链接 {page?.demoRows ?? 0} 条不会进入正式记录
        </span>
        {notice && <span className="share-notice">{notice}</span>}
        {error && <span className="error-text">{error}</span>}
      </footer>
    </section>
  )
}
