// PRD: §F-DBG-5 — MiParser unit tests: MI record classes and the value grammar
// (C-strings with escapes, nested tuples, value/result lists) that GdbBridge
// relies on (dev-plan task P0.5, dev-plan §7.2 coverage target).
import { describe, expect, it } from 'vitest';
import { parseMiLine } from '../src/debugger/MiParser.js';

describe('parseMiLine', () => {
  it('returns null for prompts, empty lines and non-MI output', () => {
    expect(parseMiLine('')).toBeNull();
    expect(parseMiLine('(gdb)')).toBeNull();
    expect(parseMiLine('(gdb) \r')).toBeNull();
    expect(parseMiLine('hello world')).toBeNull();
    expect(parseMiLine('1^bogus')).toBeNull();
  });

  it('parses tokenized result records with and without payloads', () => {
    expect(parseMiLine('1^done')).toEqual({ type: 'result', token: '1', klass: 'done', payload: {} });
    expect(parseMiLine('^running')).toEqual({ type: 'result', klass: 'running', payload: {} });
    expect(parseMiLine('7^connected')).toEqual({ type: 'result', token: '7', klass: 'connected', payload: {} });
    const rec = parseMiLine('2^running,thread-id="all"');
    expect(rec?.klass).toBe('running');
    expect(rec?.payload).toEqual({ 'thread-id': 'all' });
  });

  it('unescapes C-strings in error payloads', () => {
    const rec = parseMiLine('3^error,msg="Function \\"foo\\" not defined."');
    expect(rec?.type).toBe('result');
    expect(rec?.klass).toBe('error');
    expect(rec?.payload?.msg).toBe('Function "foo" not defined.');
  });

  it('parses the exec-async *stopped record with nested tuple and lists', () => {
    const rec = parseMiLine(
      '*stopped,reason="breakpoint-hit",disp="keep",bkptno="1",frame={addr="0x40080024",func="app_main",args=[]},thread-id="1",stopped-threads=["all"],core="0"',
    );
    expect(rec?.type).toBe('async');
    expect(rec?.asyncKind).toBe('exec');
    expect(rec?.klass).toBe('stopped');
    expect(rec?.payload?.reason).toBe('breakpoint-hit');
    expect(rec?.payload?.bkptno).toBe('1');
    expect(rec?.payload?.frame).toEqual({ addr: '0x40080024', func: 'app_main', args: [] });
    expect(rec?.payload?.['stopped-threads']).toEqual(['all']);
    expect(rec?.payload?.core).toBe('0');
  });

  it('parses *running and status (+) and notify (=) async records', () => {
    expect(parseMiLine('*running,thread-id="all"')?.klass).toBe('running');
    const status = parseMiLine('+download,status="connecting",host="127.0.0.1"');
    expect(status?.asyncKind).toBe('status');
    const notify = parseMiLine('=thread-group-added,id="i1"');
    expect(notify?.asyncKind).toBe('notify');
    expect(notify?.klass).toBe('thread-group-added');
    expect(notify?.payload?.id).toBe('i1');
  });

  it('parses stream records and decodes escape sequences', () => {
    expect(parseMiLine('~"hello\\n"')?.payload?.text).toBe('hello\n');
    expect(parseMiLine('&"warning: x\\ty"')?.payload?.text).toBe('warning: x\ty');
    expect(parseMiLine('~"caf\\303\\251"')?.payload?.text).toBe('caf\u00c3\u00a9'); // octal escapes -> chars
    expect(parseMiLine('@"target\\x41"')?.payload?.text).toBe('targetA');
  });

  it('parses bkpt tuples returned by -break-insert', () => {
    const rec = parseMiLine(
      '4^done,bkpt={number="1",type="breakpoint",disp="keep",enabled="y",addr="0x40080024",func="app_main",thread-groups=["i1"],times="0"}',
    );
    const bkpt = rec?.payload?.bkpt;
    expect(bkpt).toBeTypeOf('object');
    expect((bkpt as Record<string, unknown>).number).toBe('1');
    expect((bkpt as Record<string, unknown>).func).toBe('app_main');
    expect((bkpt as Record<string, unknown>)['thread-groups']).toEqual(['i1']);
  });

  it('parses result lists (list of key=value tuples)', () => {
    const rec = parseMiLine('5^done,stack=[frame={level="0",func="app_main"},frame={level="1",func="_start"}]');
    const stack = rec?.payload?.stack;
    expect(Array.isArray(stack)).toBe(true);
    expect(stack).toEqual([
      { frame: { level: '0', func: 'app_main' } },
      { frame: { level: '1', func: '_start' } },
    ]);
  });

  it('tolerates empty tuples and lists', () => {
    expect(parseMiLine('6^done,changelist=[]')?.payload?.changelist).toEqual([]);
    expect(parseMiLine('8^done,frame={}')?.payload?.frame).toEqual({});
  });
});
