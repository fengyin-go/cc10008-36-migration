/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string
  readonly VITE_APP_NAME?: string
  /** 数据分享迁移基准，UTC ISO 时间；绝对日期与相对天数都按它归一。 */
  readonly VITE_SHARE_MIGRATION_BASELINE?: string
  /** 兼容别名；两个都配置时优先 VITE_SHARE_MIGRATION_BASELINE。 */
  readonly VITE_SHARE_BASELINE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
