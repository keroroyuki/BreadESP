#!/usr/bin/env node
// PRD: §10 — Conventional Commit 校验（docs/dev-plan.md §5.2）。
// 同一份实现同时服务本地 commit-msg 钩子与 CI 的 PR 标题校验。

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** 允许的 type 白名单（docs/dev-plan.md §5.2）。 */
export const TYPES = [
  'feat',
  'fix',
  'refactor',
  'docs',
  'test',
  'chore',
  'build',
  'ci',
  'perf',
  'revert',
];

/** 已知 scope；未知 scope 只告警，避免新包被卡住。 */
export const SCOPES = [
  'shell',
  'ui',
  'peripherals',
  'sim-core',
  'netlist',
  'docs-site',
  'docs',
  'prd',
  'release',
  'dev',
  'build',
  'ci',
  'deps',
  'repo',
  'test',
];

/** 首行硬上限（type + scope + subject）。 */
export const HEADER_MAX_LENGTH = 72;

/** subject 软上限，超出仅告警。 */
export const SUBJECT_RECOMMENDED_MAX_LENGTH = 50;

/** body 单行软上限，超出仅告警。 */
export const BODY_RECOMMENDED_MAX_LENGTH = 72;

const HEADER_PATTERN =
  /^(?<type>[a-z]+)(?:\((?<scope>[a-z0-9][a-z0-9-]*)\))?(?<breaking>!)?: (?<subject>\S(?:.*\S)?)$/;

/** git 自动生成的消息不参与校验。 */
const IGNORED_HEADER_PATTERNS = [/^Merge /, /^Revert "/, /^(?:fixup|squash|amend)! /];

const BODY_LINE_EXEMPTIONS = /^(?:https?:\/\/|Closes |Refs: |Breaking: )/;

/**
 * 拆出首行与正文，并剔除 git 注释行与 scissors 之后的帮助文本。
 * @param {string} rawMessage commit-msg 文件内容或 PR 标题
 * @returns {{ header: string, bodyLines: string[] }}
 */
export function parseCommitMessage(rawMessage) {
  const normalized = String(rawMessage).replace(/\r\n?/g, '\n');
  const lines = [];

  for (const line of normalized.split('\n')) {
    if (line.startsWith('# ------------------------ >8 ------------------------')) break;
    if (line.startsWith('#')) continue;
    lines.push(line);
  }

  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

  const [header = '', ...bodyLines] = lines;
  return { header: header.trim(), bodyLines };
}

/**
 * 校验一条 commit message / PR 标题。
 * @param {string} rawMessage
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateCommitMessage(rawMessage) {
  const errors = [];
  const warnings = [];
  const { header, bodyLines } = parseCommitMessage(rawMessage);

  if (header === '') {
    errors.push('message is empty');
    return { errors, warnings };
  }

  if (IGNORED_HEADER_PATTERNS.some((pattern) => pattern.test(header))) {
    return { errors, warnings };
  }

  if (header.length > HEADER_MAX_LENGTH) {
    errors.push(
      `header is ${header.length} characters; maximum is ${HEADER_MAX_LENGTH}`,
    );
  }

  const match = HEADER_PATTERN.exec(header);
  if (match === null) {
    errors.push(
      'header must match "type(scope): subject" (scope optional; see docs/dev-plan.md §5.2)',
    );
    return { errors, warnings };
  }

  const { type, scope, breaking, subject } = match.groups;

  if (!TYPES.includes(type)) {
    errors.push(`unknown type "${type}"; allowed: ${TYPES.join(', ')}`);
  }
  if (scope !== undefined && !SCOPES.includes(scope)) {
    warnings.push(`unknown scope "${scope}"; known: ${SCOPES.join(', ')}`);
  }
  if (subject.endsWith('.')) {
    errors.push('subject must not end with a period');
  }
  if (subject.length > SUBJECT_RECOMMENDED_MAX_LENGTH) {
    warnings.push(
      `subject is ${subject.length} characters; recommended maximum is ${SUBJECT_RECOMMENDED_MAX_LENGTH}`,
    );
  }
  if (/^[A-Z]/.test(subject)) {
    warnings.push('subject starts uppercase; prefer lowercase imperative');
  }
  if (/[^\x20-\x7e]/.test(subject)) {
    warnings.push(
      'subject contains non-ASCII characters; keep it English and move details to the body',
    );
  }

  if (bodyLines.length > 0 && bodyLines[0] !== '') {
    errors.push('separate the header and body with a blank line');
  }

  bodyLines.forEach((line, index) => {
    if (line.length > BODY_RECOMMENDED_MAX_LENGTH && !BODY_LINE_EXEMPTIONS.test(line)) {
      warnings.push(
        `body line ${index + 2} is ${line.length} characters; recommended maximum is ${BODY_RECOMMENDED_MAX_LENGTH}`,
      );
    }
  });

  if (
    breaking === '!' &&
    !/(^|\n)(?:BREAKING[ -]CHANGE:|Breaking:)/.test(String(rawMessage))
  ) {
    warnings.push('"!" declares a breaking change; add a "Breaking:" footer');
  }

  return { errors, warnings };
}

const USAGE = [
  'Usage:',
  '  node scripts/check-commit-message.mjs --file <path>     # commit-msg hook',
  '  node scripts/check-commit-message.mjs --title "<text>"  # PR title (CI)',
].join('\n');

/**
 * CLI 入口。
 * @param {string[]} argv
 * @returns {number} 进程退出码
 */
export function runCli(argv) {
  let file = null;
  let title = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--file') {
      file = argv[index + 1] ?? null;
      index += 1;
    } else if (argument === '--title') {
      title = argv[index + 1] ?? null;
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      console.log(USAGE);
      return 0;
    } else {
      console.error(`ERROR: unknown argument "${argument}"`);
      console.error(USAGE);
      return 2;
    }
  }

  if ((file === null) === (title === null)) {
    console.error(USAGE);
    return 2;
  }

  const label = file === null ? 'PR title' : 'commit message';
  const raw = file === null ? title : readFileSync(file, 'utf8');
  const { errors, warnings } = validateCommitMessage(raw);

  for (const warning of warnings) console.warn(`WARN: ${warning}`);
  for (const error of errors) console.error(`ERROR: ${error}`);

  if (errors.length > 0) {
    console.error(
      `\nRejected ${label}. Format: type(scope): subject — see docs/dev-plan.md §5.2`,
    );
    return 1;
  }

  if (warnings.length === 0) console.log(`OK: ${label} is valid`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
