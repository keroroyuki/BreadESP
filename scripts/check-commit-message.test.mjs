// PRD: §10 — 校验器用例（docs/dev-plan.md §5.2）。

import { describe, expect, it } from 'vitest';

import { parseCommitMessage, validateCommitMessage } from './check-commit-message.mjs';

const errorsOf = (message) => validateCommitMessage(message).errors;
const warningsOf = (message) => validateCommitMessage(message).warnings;

describe('validateCommitMessage', () => {
  it('accepts a typed header with a scope', () => {
    const result = validateCommitMessage('feat(ui): add 3d snap');

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('accepts a typed header without a scope', () => {
    expect(errorsOf('fix: handle empty netlist')).toEqual([]);
  });

  it('accepts a breaking-change marker with a Breaking footer', () => {
    const message = 'feat(peripherals)!: drop legacy shim\n\nBreaking: removes the v1 shim';

    expect(errorsOf(message)).toEqual([]);
    expect(warningsOf(message)).toEqual([]);
  });

  it('warns when "!" has no Breaking footer', () => {
    expect(warningsOf('feat(peripherals)!: drop legacy shim')).toContain(
      '"!" declares a breaking change; add a "Breaking:" footer',
    );
  });

  it('rejects an unknown type', () => {
    expect(errorsOf('feature: add x')).toContain(
      `unknown type "feature"; allowed: ${[
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
      ].join(', ')}`,
    );
  });

  it('rejects a header without the "type: " prefix', () => {
    expect(errorsOf('feat add x')).toContain(
      'header must match "type(scope): subject" (scope optional; see docs/dev-plan.md §5.2)',
    );
  });

  it('rejects a header longer than 72 characters', () => {
    const header = `feat(ui): ${'a'.repeat(70)}`;

    expect(errorsOf(header)).toContain(
      `header is ${header.length} characters; maximum is 72`,
    );
  });

  it('accepts a header of exactly 72 characters', () => {
    const header = `feat(ui): ${'a'.repeat(62)}`;

    expect(header).toHaveLength(72);
    expect(errorsOf(header)).toEqual([]);
  });

  it('rejects a subject ending with a period', () => {
    expect(errorsOf('feat(ui): add snap.')).toContain('subject must not end with a period');
  });

  it('warns on an unknown scope but does not reject', () => {
    const result = validateCommitMessage('feat(unknown-pkg): add x');

    expect(result.errors).toEqual([]);
    expect(result.warnings[0]).toContain('unknown scope "unknown-pkg"');
  });

  it('warns on a long subject while keeping the header valid', () => {
    const subject = 'a'.repeat(60);

    expect(warningsOf(`feat(ui): ${subject}`)[0]).toContain(
      'recommended maximum is 50',
    );
  });

  it('warns on an uppercase or non-ASCII subject', () => {
    expect(warningsOf('feat(ui): Add snap')).toContain(
      'subject starts uppercase; prefer lowercase imperative',
    );
    expect(warningsOf('feat(ui): 增加吸附')).toContain(
      'subject contains non-ASCII characters; keep it English and move details to the body',
    );
  });

  it('requires a blank line between header and body', () => {
    expect(errorsOf('feat(ui): add snap\nbody without blank line')).toContain(
      'separate the header and body with a blank line',
    );
    expect(errorsOf('feat(ui): add snap\n\nbody with blank line')).toEqual([]);
  });

  it('warns on long body lines but exempts URLs and footers', () => {
    const long = `feat(ui): add snap\n\n${'b'.repeat(80)}`;

    expect(warningsOf(long)[0]).toContain('recommended maximum is 72');
    expect(warningsOf(`feat(ui): add snap\n\nRefs: ${'x'.repeat(90)}`)).toEqual([]);
  });

  it('ignores merge, revert and fixup messages', () => {
    expect(errorsOf('Merge branch "main" into feat/ui')).toEqual([]);
    expect(errorsOf('Revert "feat(ui): add snap"')).toEqual([]);
    expect(errorsOf('fixup! feat(ui): add snap')).toEqual([]);
  });

  it('rejects an empty message', () => {
    expect(errorsOf('')).toContain('message is empty');
    expect(errorsOf('\n\n')).toContain('message is empty');
  });

  it('normalizes CRLF input', () => {
    expect(errorsOf('feat(ui): add snap\r\n\r\nbody')).toEqual([]);
  });
});

describe('parseCommitMessage', () => {
  it('drops git comment lines and the scissors section', () => {
    const raw = [
      'feat(ui): add snap',
      '',
      '# Please enter the commit message for your changes.',
      '#',
      '# ------------------------ >8 ------------------------',
      '# Do not modify or remove the line above.',
      'diff --git a/x b/x',
    ].join('\n');

    const parsed = parseCommitMessage(raw);

    expect(parsed.header).toBe('feat(ui): add snap');
    expect(parsed.bodyLines).toEqual([]);
  });

  it('keeps the body after the header', () => {
    const parsed = parseCommitMessage('feat(ui): add snap\n\nwhy this change\n\nRefs: PRD §3.4');

    expect(parsed.header).toBe('feat(ui): add snap');
    expect(parsed.bodyLines).toEqual(['', 'why this change', '', 'Refs: PRD §3.4']);
  });

  it('trims surrounding blank lines and header whitespace', () => {
    const parsed = parseCommitMessage('\n  chore(repo): tweak ci  \n');

    expect(parsed.header).toBe('chore(repo): tweak ci');
    expect(parsed.bodyLines).toEqual([]);
  });
});
