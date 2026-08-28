// PRD: §F-DBG-5 — GDB/MI output parser (dev-plan task P0.5). Translates MI
// records (result, async, stream) into structured values following the MI
// output grammar: values are C-strings ("..."), tuples ({...}) or lists
// ([...]); results are `variable="value"` pairs. Only the constructs GDB
// actually emits for our commands are exercised, but the value grammar is
// complete so nested payloads (bkpt={...}, frame={...}, [list]) parse fully.
/** MI value: a bareword/C-string, a tuple (object) or a list (array). */
export type MiValue = string | MiTuple | MiValue[];

/** MI tuple `{ result, result, ... }` parsed as an object. */
export interface MiTuple {
  [key: string]: MiValue;
}

export interface MiRecord {
  type: 'console' | 'target' | 'log' | 'async' | 'result';
  /** For async records only: `*` exec, `+` status, `=` notify. */
  asyncKind?: 'exec' | 'status' | 'notify';
  token?: string;
  klass?: string;          // e.g. 'stopped', 'done', 'running', 'error'
  payload?: MiTuple;
}

/** Parse one line of GDB/MI output. Returns null for prompts and non-MI lines. */
export function parseMiLine(rawLine: string): MiRecord | null {
  const line = rawLine.trimEnd();
  if (line === '' || line === '(gdb)') return null;

  // Stream records: ~"console"  @"target"  &"log"
  const stream = /^([~@&])"(.*)"$/.exec(line);
  if (stream) {
    const type = stream[1] === '~' ? 'console' : stream[1] === '@' ? 'target' : 'log';
    return { type, payload: { text: unescapeCString(stream[2]) } };
  }

  // Async records: [token] (*|+|=) class [, result-list]
  const async = /^(\d*)([*+=])([A-Za-z0-9-]+)(?:,(.*))?$/.exec(line);
  if (async) {
    return {
      type: 'async',
      asyncKind: async[2] === '*' ? 'exec' : async[2] === '+' ? 'status' : 'notify',
      token: async[1] || undefined,
      klass: async[3],
      payload: async[4] !== undefined ? parseResultsBody(async[4], 0).value : {},
    };
  }

  // Result records: [token] ^done|running|error|connected|exit|supported [, result-list]
  const result = /^(\d*)\^(done|running|error|connected|exit|supported)(?:,(.*))?$/.exec(line);
  if (result) {
    return {
      type: 'result',
      token: result[1] || undefined,
      klass: result[2],
      payload: result[3] !== undefined ? parseResultsBody(result[3], 0).value : {},
    };
  }
  return null;
}

/** Parse `var=value,var=value` (the body of a tuple / result-list) at position i. */
function parseResultsBody(s: string, i: number): { value: MiTuple; end: number } {
  const obj: MiTuple = {};
  let j = i;
  for (;;) {
    if (j >= s.length || s[j] === '}' || s[j] === ']') return { value: obj, end: j };
    const eq = s.indexOf('=', j);
    if (eq < 0) return { value: obj, end: s.length };
    const r = parseValue(s, eq + 1);
    obj[s.slice(j, eq)] = r.value;
    j = r.end;
    if (s[j] === ',') { j++; continue; }
    return { value: obj, end: j };
  }
}

/** Parse a `{...}` tuple. */
function parseTuple(s: string, i: number): { value: MiTuple; end: number } {
  if (s[i + 1] === '}') return { value: {}, end: i + 2 };
  const inner = parseResultsBody(s, i + 1);
  return { value: inner.value, end: inner.end + 1 }; // consume '}'
}

/** Parse a `[...]` list of values or of results (`[frame={...},frame={...}]`). */
function parseList(s: string, i: number): { value: MiValue[]; end: number } {
  if (s[i + 1] === ']') return { value: [], end: i + 2 };
  let j = i + 1;
  // A results list element starts with a bare identifier followed by `=`;
  // a value element starts with a quote, brace or bracket.
  const resultsAhead = /^[A-Za-z0-9_.-]+=/.test(s.slice(j));
  if (!resultsAhead) {
    const values: MiValue[] = [];
    for (;;) {
      const r = parseValue(s, j);
      values.push(r.value);
      j = r.end;
      if (s[j] === ',') { j++; continue; }
      return { value: values, end: j + 1 }; // consume ']'
    }
  }
  const results: MiTuple[] = [];
  for (;;) {
    const eq = s.indexOf('=', j);
    const r = parseValue(s, eq + 1);
    results.push({ [s.slice(j, eq)]: r.value });
    j = r.end;
    if (s[j] === ',') { j++; continue; }
    return { value: results, end: j + 1 }; // consume ']'
  }
}

/** Parse a single MI value (string, tuple, list or bareword) at position i. */
function parseValue(s: string, i: number): { value: MiValue; end: number } {
  const c = s[i];
  if (c === '"') return parseCString(s, i);
  if (c === '{') return parseTuple(s, i);
  if (c === '[') return parseList(s, i);
  // Bareword: number or enum token up to the next delimiter.
  let j = i;
  while (j < s.length && s[j] !== ',' && s[j] !== ']' && s[j] !== '}') j++;
  return { value: s.slice(i, j), end: j };
}

/** Parse a `"..."` C-string starting at the opening quote. */
function parseCString(s: string, i: number): { value: string; end: number } {
  let j = i + 1;
  let out = '';
  while (j < s.length) {
    const c = s[j];
    if (c === '"') return { value: out, end: j + 1 };
    if (c === '\\') {
      const esc = readEscape(s, j);
      out += esc.text;
      j = esc.end;
      continue;
    }
    out += c;
    j++;
  }
  return { value: out, end: j }; // unterminated: best effort
}

/** Decode one backslash escape (C-style, octal and hex as emitted by GDB). */
function readEscape(s: string, i: number): { text: string; end: number } {
  const n = s[i + 1];
  if (n === undefined) return { text: '', end: i + 1 };
  const simple: Record<string, string> = {
    n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', a: '\a', e: '\x1b',
  };
  if (simple[n] !== undefined) return { text: simple[n], end: i + 2 };
  if (n === "'" || n === '"' || n === '\\') return { text: n, end: i + 2 };
  // Octal escape: up to three octal digits.
  if (n >= '0' && n <= '7') {
    let j = i + 1;
    let oct = '';
    while (j < s.length && oct.length < 3 && s[j] >= '0' && s[j] <= '7') {
      oct += s[j];
      j++;
    }
    return { text: String.fromCharCode(parseInt(oct, 8)), end: j };
  }
  // Hex escape: \xhh
  if (n === 'x') {
    let j = i + 2;
    let hex = '';
    while (j < s.length && hex.length < 2 && /[0-9a-fA-F]/.test(s[j])) {
      hex += s[j];
      j++;
    }
    return { text: hex === '' ? 'x' : String.fromCharCode(parseInt(hex, 16)), end: j };
  }
  return { text: n, end: i + 2 }; // unknown escape: keep the escaped char
}

/** Unescape the body of an MI C-string (between the outer quotes). */
function unescapeCString(body: string): string {
  let out = '';
  let i = 0;
  while (i < body.length) {
    if (body[i] === '\\') {
      const esc = readEscape(body, i);
      out += esc.text;
      i = esc.end;
      continue;
    }
    out += body[i];
    i++;
  }
  return out;
}
