# 交互式数据分析工作台

离线版交互式数据分析工具，涵盖多源接入、查询分析、可视化图表、报告生成、异常检测与数据服务编排，所有分析配置与结果持久化到浏览器本地存储。

这是一个**纯前端**管理平台：React + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 React + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/api/share-service.ts   数据分享页服务：迁移、访问、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/data/share-*.ts   分享凭证：结构、解析、迁移引擎、存储
│   ├── tests/                迁移引擎与存储层的离线自检（node --test）
│   ├── Dockerfile            生产镜像（构建时注入迁移基准）
│   ├── Dockerfile.dev        本地开发镜像（dev server）
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .env.example              环境变量样例（含分享迁移基准）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。
`.env.development` 里已经给出本地迁移基准；如需改动，改 `VITE_SHARE_MIGRATION_BASELINE`。

生产构建：

```bash
cd frontend
VITE_SHARE_MIGRATION_BASELINE=2026-11-14T00:00:00.000Z npm run build
```

## 部署

迁移基准是**构建时**注入前端的，必须在构建环境显式给出，不能沿用开发默认值：

| 场景 | 配置位置 | 说明 |
| --- | --- | --- |
| 本地开发 | `frontend/.env.development` | `npm run dev` 自动读取 |
| 生产构建 | `frontend/.env.production` + 环境变量 | `docker build --build-arg` 或 CI 注入 |
| Docker Compose | 根目录 `.env` | `VITE_SHARE_MIGRATION_BASELINE` 为必填，缺失时 compose 直接报错 |
| 纯静态托管 | 构建命令前导出环境变量 | 产物是 `frontend/dist/`，无需后端 |

```bash
# 生产镜像（静态托管在 4173）
VITE_SHARE_MIGRATION_BASELINE=2026-11-14T00:00:00.000Z docker compose up --build frontend

# 本地开发镜像（dev server，5173）
VITE_SHARE_MIGRATION_BASELINE=2026-11-14T00:00:00.000Z docker compose --profile dev up frontend-dev
```

## 数据分享凭证迁移

数据分享旧记录用自由文本保存「有效期天数」和「最大浏览次数」，相对日期、缺失值、中文计数
混在一起，无法判断链接是否还应开放。`share` 模块已迁移为带版本凭证的记录：

- **结构**：`localStorage` 的 `interactive-analytics-lab:share:v1` 文档按表组织
  （migration / credentials / audits / legacyAccess），结构版本与凭证格式版本各留一份。
  旧记录本身（`interactive-analytics-lab:entries`）不被改写。
- **快照**：目标数据集、水印原文、旧用户标识、原分享生成时间都存进 `snapshot`；重新生成
  凭证只递增版本，快照与生成时间保持不变。
- **基准**：绝对日期保留原值，相对天数（如 `30天`）从 `VITE_SHARE_MIGRATION_BASELINE` 起算。
  日期统一成 UTC 秒级 ISO，便于跨时区核对。
- **待确认**：缺失密码、缺失 / 无法解析访问上限、无法解析有效期、旧状态非「已生效」都会把
  凭证标成 `pending_confirmation`，不自动开放；页面上可人工补录访问上限后恢复。
  显式写了「不限次数 / 无限」的旧值才按无限处理。
- **幂等**：同一链接只有一条当前版本凭证，重复执行迁移只更新旁证与待确认原因，不复制凭证；
  已消耗访问次数取「凭证现值」和「旧记录值」的较大者，永远不会被清零。
- **断点续迁**：每完成一个链接就落盘一次，`lastCompletedLinkId` / `lastCompletedIndex` 记录
  最后一个完整链接；中断后重跑从它之后继续。已写入的凭证不会重复生成。
- **旁证**：解析失败、示例链接跳过、访问放行、凭证重生成与人工确认都写入 `audits`，
  同一问题重复出现只累加次数，保留首次证据。
- **迁移期可用**：凭证尚未生成的链接继续按旧记录校验（含旧密码与旧计数），迁移完成后再走
  版本凭证；页面在迁移前沿用旧水印原文展示。
- **示例链接**：编号或数据集名带「样例 / 示例 / example / sample / demo / mock」、带
  `#构建号` 后缀、或标注 `示例链接 / isDemo / demo` 的记录一律跳过，只留旁证，不进入正式凭证。
- **访问计数**：密码校验失败不消耗次数；待确认凭证与已撤销凭证不开放；到期或次数用尽返回
  明确原因。

离线自检（不依赖浏览器）：

```bash
make share-test     # 等价于 cd frontend && node tests/run.mjs
make migrate-check  # 只做 TypeScript 类型检查
```

页面 `/share` 提供迁移执行、预检、访问校验、人工确认访问上限、重新生成凭证、旁证查看与
凭证清单导出。

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 交互查询 | `query` | 查询语句 | 语句编号、查询表达式、目标数据集 |
| 可视化图表 | `chart` | 图表配置 | 图表编号、图表名称、图表类型 |
| 数据源接入 | `source` | 接入配置 | 配置编号、连接类型、接入地址 |
| 聚合计算 | `aggregate` | 聚合方案 | 方案编号、聚合函数、目标字段 |
| 数据筛选 | `filter` | 筛选规则 | 规则编号、目标数据集、筛选字段 |
| 报告生成 | `reportgen` | 报告模板 | 模板编号、模板名称、包含图表 |
| 异常检测 | `anomaly` | 检测规则 | 规则编号、监控指标、基线均值 |
| 多维下钻 | `drill` | 下钻路径 | 路径编号、起点维度、下钻层数 |
| 对比分析 | `compare` | 对比方案 | 方案编号、基准数据集、对照数据集 |
| 分析流水线 | `pipeline` | 流水线节点 | 节点编号、节点类型、输入源 |
| 数据集管理 | `datastore` | 数据集定义 | 数据集编号、数据集名称、来源表名 |
| 趋势预测 | `forecast` | 预测模型 | 模型编号、模型类型、训练数据集 |
| 数据分片 | `segment` | 分片规则 | 规则编号、目标数据集、分片字段 |
| 调度管理 | `scheduler` | 调度配置 | 配置编号、关联任务、调度表达式 |
| 通知分发 | `notify` | 通知规则 | 规则编号、触发条件、通知渠道 |
| 查询缓存 | `cache` | 缓存策略 | 策略编号、目标查询、缓存键规则 |
| 数据标签 | `tag` | 标签定义 | 标签编号、标签名称、计算表达式 |
| 数据分享 | `share` | 分享链接 | 链接编号、目标数据集、访问密码 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 分享凭证的迁移、访问判定与待确认策略只允许在 `share-migration.ts` 里改，页面只调用
  `api/share-service.ts`。
- 想回到初始数据：清掉浏览器里 `interactive-analytics-lab:entries` 与
  `interactive-analytics-lab:share:v1` 这两项，或调用 `resetModule(模块)`。

领域：数据工程
子方向：数据分析与数据应用
