// PRD: §10 — 安装仓库自带的 git hooks（docs/dev-plan.md §6.5）。
// 由根 package.json 的 `prepare` 自动执行，也可手动 `pnpm setup:hooks`。

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const hooksDirectory = join(repositoryRoot, '.githooks');

function git(args) {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim();
}

// 打包产物 / tarball 里没有 .git：hook 安装是可选项，不能让 install 失败。
if (!existsSync(join(repositoryRoot, '.git')) || !existsSync(join(hooksDirectory, 'commit-msg'))) {
  process.exit(0);
}

try {
  git(['config', 'core.hooksPath', '.githooks']);
  console.log('[hooks] core.hooksPath -> .githooks');
} catch (error) {
  console.warn(`[hooks] could not configure core.hooksPath: ${error.message}`);
  process.exit(0);
}

// POSIX 上 hook 必须带可执行位；Windows 的检出会忽略它，所以这里显式检查 git 索引。
if (process.platform !== 'win32') {
  try {
    const entry = git(['ls-files', '--stage', '.githooks/commit-msg']);
    if (entry !== '' && !entry.startsWith('100755')) {
      console.warn(
        '[hooks] .githooks/commit-msg is not executable in git; run: git update-index --chmod=+x .githooks/commit-msg .githooks/pre-push',
      );
    }
  } catch {
    // ls-files 失败不影响安装。
  }
}
