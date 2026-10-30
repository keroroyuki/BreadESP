# 决策记录（ADR）

流程与架构层面的决策，按时间倒序。每条包含背景、决定、后果与复审条件；改变决定时新增一条，不修改历史条目。

---

## 0001 — 主干开发 + 0 审批 + 零依赖提交校验

- **日期**：2026-10-30
- **状态**：已采纳

### 背景

- 仓库为单人维护（127 个提交、61 天、单一作者、零 merge commit、零 revert），发布为手工构建，不存在自动部署。
- 此前没有任何 CI 与分支保护，全部提交直推 `main`；`fix(build): make the desktop app actually launch` 一类提交说明 `main` 曾出现过不可用状态。
- `docs/dev-plan.md` §6 原本规划 `main + dev` 双分支，但 `dev` 从未创建，也无人 review。

### 决定

1. **分支模型**：主干开发。`main` 唯一长期分支；每个任务从 `main` 切短期分支，PR 合并后删除；不设 `dev`。需要冻结时按需开 `release/vX.Y.Z`。
2. **审批**：required approvals = 0。GitHub 不允许自我批准，单人设 1 会永久阻塞；改为依靠 CI、PR 模板与自查清单。**出现第二位有写权限的协作者时，当天改为 1 并启用 CODEOWNERS。**
3. **提交校验**：零依赖方案——`.githooks/commit-msg` + `scripts/check-commit-message.mjs`，由 `pnpm install`（`prepare`）自动安装；CI 用同一脚本校验 PR 标题。不引入 husky / commitlint。

### 后果

- `main` 必须始终可构建、可演示；半成品不得合入。
- 质量门禁从"人工 review"转为"CI + 可审计证据"，PR 描述与 CHANGELOG 的重要性上升。
- 每个 PR 的 squash commit 标题必须规范，因为它就是 `main` 的历史。
- 本地钩子可被 `--no-verify` 绕过（明令禁止），但服务端 ruleset 与 CI 仍会拦截不合规的 PR。

### 复审条件

出现以下任一情况时重估：

- 新增第二位有写权限的协作者（→ approvals 改 1，考虑恢复 `dev`）；
- 引入自动发布 / 持续部署（→ `main` 稳定性要求上升）；
- 单次发布包含 > 10 个 PR 且需要整体回归（→ 引入 `release/*` 或 `dev`）；
- CI 出现无法在 PR 阶段拦截的线上问题（→ 增加 smoke / e2e 门禁）。

### 相关

- [PRD.md](../PRD.md) §7、§10
- [docs/dev-plan.md](dev-plan.md) §5、§6
- [CONTRIBUTING.md](../CONTRIBUTING.md)
