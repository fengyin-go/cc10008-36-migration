.PHONY: install frontend build preview migrate-check share-test

install:
	cd frontend && npm install

frontend:
	cd frontend && npm run dev

build:
	cd frontend && npm run build

preview:
	cd frontend && npm run preview

# 迁移引擎的离线自检：不依赖浏览器，用 Node 跑一遍解析 / 幂等 / 断点续迁。
share-test:
	cd frontend && node tests/run.mjs

migrate-check:
	cd frontend && npm run typecheck
