// Mock GDB/MI subprocess for shell integration tests (dev-plan §7.2: mock child
// process). Speaks just enough of the MI wire protocol — startup notify record,
// `(gdb)` prompts, tokenized result records, `*stopped` exec-async — to exercise
// the GdbBridge behaviors of dev-plan tasks P0.5 and P1.9.
//
// Every received command is echoed to stderr so tests can assert what was sent.
//
// Usage: node mock-gdb.mjs [--scenario ok|error|hang|refuse] [ignored gdb args...] <elf>
// Scenarios:
//   ok      (default) — full handshake, breakpoints, continue/step stop replies,
//                      frame vars, registers, expression evaluation, -break-list
//   error   — `-break-insert` replies ^error (unknown symbol)
//   hang    — `-break-insert`/`-break-delete`/`-exec-*` never reply (timeout path)
//   refuse  — `-target-select` replies ^error (target unreachable)
import readline from 'node:readline';

const argv = process.argv.slice(2);
const scenarioIdx = argv.indexOf('--scenario');
const scenario = scenarioIdx >= 0 ? argv[scenarioIdx + 1] : 'ok';

process.stderr.write(`mock-gdb: start scenario=${scenario} elf=${argv[argv.length - 1] ?? '?'}\n`);
process.stdout.write('=thread-group-added,id="i1"\n');
process.stdout.write('(gdb)\n');

let bpCount = 0;
const breakpoints = []; // {number, addr, original-location}

const done = (token, body) => {
  process.stdout.write(`${token}^done${body ? ',' + body : ''}\n(gdb)\n`);
};
const error = (token, msg) => {
  process.stdout.write(`${token}^error,msg="${msg}"\n(gdb)\n`);
};
const stoppedAfter = (ms, record) => {
  setTimeout(() => process.stdout.write(`${record}\n(gdb)\n`), ms);
};

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  process.stderr.write(`mock-gdb: recv ${line}\n`);
  const m = /^(\d*)(.*)$/.exec(line);
  const token = m[1] ?? '';
  const cmd = m[2] ?? '';

  if (cmd === '-gdb-exit') {
    process.stdout.write(`${token}^exit\n`);
    setTimeout(() => process.exit(0), 10); // let the reply flush
    return;
  }
  if (cmd.startsWith('-target-select')) {
    if (scenario === 'refuse') error(token, '127.0.0.1:1: Connection refused.');
    else done(token);
    return;
  }
  if (cmd.startsWith('-break-insert')) {
    if (scenario === 'error') { error(token, 'Function \\"app_main\\" not defined.'); return; }
    if (scenario === 'hang') return;
    // P4.4: `-break-insert [-c "cond"] loc` — pull out an optional condition.
    const condMatch = /^-break-insert\s+-c\s+("(?:[^"\\]|\\.)*"|"\S*"|\S+)\s*/.exec(cmd);
    let rest = cmd.replace(/^-break-insert\s+/, '');
    let cond = null;
    if (condMatch) {
      cond = condMatch[1].replace(/^"|"$/g, '').replace(/\\"/g, '"');
      rest = cmd.slice(condMatch[0].length);
    }
    const location = rest.replace(/^"|"$/g, '');
    bpCount += 1;
    breakpoints.push({ number: bpCount, location, cond });
    const condField = cond !== null ? `,cond="${cond}"` : '';
    done(token, `bkpt={number="${bpCount}",type="breakpoint",disp="keep",enabled="y",addr="0x40080024",func="app_main",file="blink.S",line="10",thread-groups=["i1"],times="0"${condField}}`);
    return;
  }
  // P4.4 (PRD §F-DBG-4): `-break-watch [-r|-a] expr` — result key and row type
  // vary with the mode, mirroring real GDB's wire shapes.
  if (cmd.startsWith('-break-watch')) {
    const readFlag = /\s-r(\s|$)/.test(cmd);
    const accessFlag = /\s-a(\s|$)/.test(cmd);
    const expr = cmd.replace(/^-break-watch\s+(-[ra]\s+)?/, '').replace(/^"|"$/g, '');
    bpCount += 1;
    const type = readFlag ? 'read watchpoint' : accessFlag ? 'acc watchpoint' : 'hw watchpoint';
    breakpoints.push({ number: bpCount, location: expr, watch: type });
    const key = readFlag ? 'hw-rwpt' : accessFlag ? 'hw-awpt' : 'wpt';
    done(token, `${key}={number="${bpCount}",exp="${expr}"}`);
    return;
  }
  // P4.4 (PRD §F-DBG-4): `-break-condition <id> <expr>` (no expr = clear).
  if (cmd.startsWith('-break-condition')) {
    const [, idStr, expr] = /^-break-condition\s+(\d+)\s*(.*)$/.exec(cmd) ?? [];
    const bp = breakpoints.find((b) => b.number === Number(idStr));
    if (!bp) { error(token, `No breakpoint number ${idStr}.`); return; }
    bp.cond = expr && expr.length > 0 ? expr.replace(/^"|"$/g, '') : null;
    done(token);
    return;
  }
  if (cmd.startsWith('-break-delete')) {
    if (scenario === 'hang') return;
    const ids = cmd.replace(/^-break-delete\s*/, '').split(/\s+/).filter(Boolean).map(Number);
    for (const id of ids) {
      const idx = breakpoints.findIndex((b) => b.number === id);
      if (idx >= 0) breakpoints.splice(idx, 1);
    }
    done(token);
    return;
  }
  if (cmd.startsWith('-break-list')) {
    // Wire shape matches real GDB (verified against esp-gdb 16.3): body is
    // nested INSIDE BreakpointTable and elements are `bkpt={...}` results.
    // Watchpoints share the table with `what=` carrying the expression.
    const body = breakpoints
      .map((b) => {
        if (b.watch) {
          return `bkpt={number="${b.number}",type="${b.watch}",disp="keep",enabled="y",what="${b.location}",thread-groups=["i1"],times="0"}`;
        }
        const condField = b.cond !== null && b.cond !== undefined ? `,cond="${b.cond}"` : '';
        return `bkpt={number="${b.number}",type="breakpoint",disp="keep",enabled="y",addr="0x40080024",func="app_main",file="blink.S",fullname="/repo/blink.S",line="10",thread-groups=["i1"],times="0",original-location="${b.location}"${condField}}`;
      })
      .join(',');
    done(token, `BreakpointTable={nr_rows="${breakpoints.length}",nr_cols="6",body=[${body}]}`);
    return;
  }
  if (cmd.startsWith('-exec-continue')) {
    if (scenario === 'hang') return;
    done(token, 'thread-id="all"');
    stoppedAfter(30, '*stopped,reason="breakpoint-hit",disp="keep",bkptno="1",frame={addr="0x40080024",func="app_main",args=[]},thread-id="1",stopped-threads=["all"],core="0"');
    return;
  }
  if (cmd.startsWith('-exec-step-instruction')) {
    if (scenario === 'hang') return;
    done(token, 'thread-id="all"');
    stoppedAfter(30, '*stopped,reason="end-stepping-range",frame={addr="0x40080027",func="app_main",args=[]},thread-id="1",stopped-threads=["all"],core="0"');
    return;
  }
  if (cmd.startsWith('-exec-next-instruction')) {
    if (scenario === 'hang') return;
    done(token, 'thread-id="all"');
    stoppedAfter(30, '*stopped,reason="end-stepping-range",frame={addr="0x40080029",func="app_main",args=[]},thread-id="1",stopped-threads=["all"],core="0"');
    return;
  }
  if (cmd.startsWith('-stack-list-variables')) {
    done(token, 'variables=[{name="msg_cursor",arg="0",value="165"},{name="remaining",arg="0",value="13"},{name="led_state",arg="0"}]');
    return;
  }
  if (cmd.startsWith('-data-list-register-names')) {
    done(token, 'register-names=["a0","a1","","a3","pc"]');
    return;
  }
  if (cmd.startsWith('-data-list-register-values')) {
    done(token, 'register-values=[{number="0",value="0x00000000"},{number="1",value="0x00000001"},{number="3",value="0x40080000"},{number="4",value="0x40080024"}]');
    return;
  }
  if (cmd.startsWith('-data-evaluate-expression')) {
    const expr = cmd.replace(/^-data-evaluate-expression\s*/, '').replace(/^"|"$/g, '');
    if (expr === 'led_state') done(token, 'value="165"');
    else if (expr === 'remaining') done(token, 'value="13"');
    else error(token, 'No symbol \\"nope\\" in current context.');
    return;
  }
  done(token); // unknown command: pretend success to keep the session alive
});
rl.on('close', () => process.exit(0));
