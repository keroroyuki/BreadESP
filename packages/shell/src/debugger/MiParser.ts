// PRD: §F-DBG-5 — GDB/MI minimal parser. Translates MI output tokens to structured results.
// Full MI grammar is large; MVP covers the few records we consume (stopped, breakpoint, vars).
export interface MiRecord {
  type: 'console' | 'target' | 'log' | 'async' | 'result';
  token?: string;
  klass?: string;          // e.g. 'stopped', 'done', 'running'
  payload?: Record<string, unknown>;
}

/** Parse one line of GDB/MI output. Returns null for non-MI lines. */
export function parseMiLine(line: string): MiRecord | null {
  if (!line) return null;
  if (line.startsWith('~"') || line.startsWith('@"') || line.startsWith('&"')) {
    const type = line[0] === '~' ? 'console' : line[0] === '@' ? 'target' : 'log';
    return { type, payload: { text: stripQuotes(line.slice(2)) } };
  }
  if (line.startsWith('*') || line.startsWith('+') || line.startsWith('=')) {
    const type = 'async';
    const body = line.slice(1);
    const [klass, rest] = splitOnce(body, ',');
    return { type, klass, payload: rest ? parseFields(rest) : {} };
  }
  // result record: [token]^done|running|error|...
  const m = /^(\d*)\^(done|running|error|connected|exit)(,(.*))?$/.exec(line);
  if (m) {
    return { type: 'result', token: m[1] || undefined, klass: m[2], payload: m[4] ? parseFields(m[4]) : {} };
  }
  return null;
}

function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}

function stripQuotes(s: string): string {
  // MI strings are C-quoted; we do a best-effort unescape for common cases.
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1]) { out += s[++i]; }
    else if (c === '"') break;
    else out += c;
  }
  return out;
}

/** Parse MI field list like "name=\"x\",value=\"3\"" into an object. */
function parseFields(s: string): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  let i = 0;
  while (i < s.length) {
    const eq = s.indexOf('=', i);
    if (eq < 0) break;
    const key = s.slice(i, eq);
    const { value, end } = readValue(s, eq + 1);
    obj[key] = value;
    i = end;
    if (s[i] === ',') i++;
  }
  return obj;
}

function readValue(s: string, from: number): { value: unknown; end: number } {
  if (s[from] === '"') return readString(s, from);
  // bareword / number until , or end
  let j = from;
  while (j < s.length && s[j] !== ',') j++;
  return { value: s.slice(from, j), end: j };
}

function readString(s: string, from: number): { value: unknown; end: number } {
  let out = ''; let i = from + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { out += s[i + 1] ?? ''; i += 2; continue; }
    if (c === '"') return { value: out, end: i + 1 };
    out += c; i++;
  }
  return { value: out, end: i };
}
