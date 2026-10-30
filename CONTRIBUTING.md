# 贡献指南

> `main` 受保护：**新功能、bug 修复、文档、重构——任何改动都必须走分支 + Pull Request**，不得直接提交 `main`。
> 规则细节见 [docs/dev-plan.md](docs/dev-plan.md) §5（提交规范）/ §6（分支与发布），决策背景见 [docs/decisions.md](docs/decisions.md)。

## 一次性准备

```bash
# Node >= 20、pnpm 9
pnpm install          # 会自动把 core.hooksPath 指向 .githooks
pnpm setup:hooks      # 若 hooks 未生效，手动重跑一次
```

验证钩子已生效：`git config core.hooksPath` 应输出 `.githooks`。

## 每次改动

```bash
git switch main
git pull --ff-only
git switch -c feat/ui-3d-snap     # <type>/<scope>-<short>
# ... 编辑 ...
git add -A
git commit -m "feat(ui): snap 3d drag to the grid"
pnpm verify                       # typecheck + test + test:scripts
git push -u origin feat/ui-3d-snap
gh pr create --fill               # 或网页开 PR
```

1. **PR 标题必须符合 Conventional Commits**——squash 合并后它就是 `main` 上的最终 commit message。
2. **CI `verify` 必须绿**，否则无法合并。
3. **合并方式只能是 Squash**；合并后分支自动删除。
4. 用户可见变更记得补 [CHANGELOG.md](CHANGELOG.md) 的 `[Unreleased]` 段。

## 分支命名

| 前缀 | 用途 | 示例 |
|---|---|---|
| `feat/` | 新功能 | `feat/ui-3d-snap` |
| `fix/` | 缺陷修复 | `fix/shell-ipc-race` |
| `docs/` | 文档 / PRD | `docs/prd-pinrole` |
| `chore/` | 工程 / 依赖 / CI | `chore/repo-workflow` |
| `refactor/`、`test/`、`perf/`、`build/`、`ci/` | 同名用途 | `test/netlist-cases` |

- 从最新 `main` 切出，生命周期 ≤ 3 天；合不掉的 PR 就关掉，不留僵尸分支。
- 一个分支 = 一个主题；重构与功能分开。

## 提交信息

```
<type>(<scope>): <subject>

<body>
<footer>
```

- `type`：`feat | fix | refactor | docs | test | chore | build | ci | perf | revert`
- `subject`：英文祈使句、小写开头、无句号；首行 ≤ 72 字符（建议 subject ≤ 50）
- `footer`：`Refs: PRD §X.Y`、`Breaking:`、`Closes #N`
- 改动 PRD §5/§6/§7 时，PRD 必须同 PR 更新，并在 footer 写 `Breaking:` / `Refs: PRD §X.Y`

本地钩子会校验；即使被跳过（`--no-verify` 是不允许的），CI 仍会校验 PR 标题。

## PR 检查清单

- 标题符合提交规范；描述写清"为什么"
- `pnpm verify` 通过；e2e 若本地跑过请注明，未跑请写原因
- 契约变更已同步 PRD；CHANGELOG 已补
- 无二进制、无 `node_modules/`、无 `dist/`、无纯格式化噪声

## 发布

发布不是直推 `main` 的内容：

1. 开 `chore(release): vX.Y.Z` PR（更新版本号 + CHANGELOG）；
2. 合并后 `git tag vX.Y.Z && git push origin vX.Y.Z`；
3. tag 只从 `main` 打，不允许移动或删除。

## 常见问题

| 现象 | 处理 |
|---|---|
| 提交被拒，提示 header/type 不合法 | 按提示改写，必要时 `git commit --amend` |
| 钩子没生效 | `pnpm setup:hooks`；确认在仓库根目录执行 |
| 推送被拒 `direct push to main` | 说明你在 `main` 上；切分支再推 |
| CI 红了 | 在同一分支修复并推送，PR 会自动重跑；不要关掉 check |
| 需要紧急修 main | 仍走 `fix/...` 分支 + PR；只有 GitHub Actions 全局故障才临时把 ruleset 置为 Evaluate（见 docs/dev-plan.md §6.3），24 小时内恢复 |
