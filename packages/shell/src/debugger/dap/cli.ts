// PRD: §F-DBG-6 — DAP adapter entry point (dev-plan task P4.5).
//
//   stdio mode (default):   node dist/debugger/dap/cli.js
//   socket mode:            node dist/debugger/dap/cli.js --port 4711
//
// stdio is the mode a VS Code debugAdapterExecutable launch uses; socket mode
// is what a launch.json `debugServer: <port>` entry (or any raw DAP client)
// points at. In stdio mode stdout carries DAP frames exclusively — every
// diagnostic goes to stderr.
import { DapServer } from './DapServer.js';
import { QemuGdbBackend } from './QemuGdbBackend.js';

function parsePort(argv: string[]): number | null {
  const idx = argv.indexOf('--port');
  if (idx < 0) return null;
  const raw = argv[idx + 1];
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write(`[breadesp-dap] --port needs an integer in [1, 65535], got ${String(raw)}\n`);
    process.exit(2);
  }
  return port;
}

const port = parsePort(process.argv.slice(2));
const server = new DapServer(() => new QemuGdbBackend(), {
  log: (message) => process.stderr.write(`[breadesp-dap] ${message}\n`),
});

if (port !== null) {
  void server.listen(port).then(() => {
    process.stderr.write(`[breadesp-dap] listening on 127.0.0.1:${port}\n`);
  });
} else {
  server.serve({ input: process.stdin, output: process.stdout });
}
