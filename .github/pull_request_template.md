<!-- PRD: §10 — PR 模板（docs/dev-plan.md §6.2） -->

## 是什么 / 为什么

<!-- 一句话说明动机；为什么现在做。 -->

Refs: PRD §X.Y

## 类型

- [ ] feat（新功能）
- [ ] fix（缺陷修复）
- [ ] refactor / perf
- [ ] docs / test / chore / ci / build
- [ ] 破坏性变更（需带 `Breaking:` footer）

## 影响面

- [ ] shell
- [ ] ui
- [ ] peripherals
- [ ] sim-core
- [ ] netlist
- [ ] docs-site
- [ ] docs / PRD

## 验证

- [ ] `pnpm verify` 通过（typecheck + test + test:scripts）
- [ ] 测试通过数：__
- [ ] e2e 本地已跑（需 QEMU）；未跑原因：__
- [ ] UI 变更附截图 / 录屏

## 自查

- [ ] 分支从最新 `main` 切出，未直接提交 `main`
- [ ] 未新增运行时依赖（或已更新 PRD §5）
- [ ] 契约变更（PRD §6/§7）已同步 PRD，且 footer 含 `Breaking:` / `Refs: PRD §X.Y`
- [ ] CHANGELOG `[Unreleased]` 已更新（用户可见变更）
- [ ] 无二进制、无 `node_modules/`、无 `dist/`、无格式化噪声

Closes #
