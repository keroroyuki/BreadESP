// Mock QEMU subprocess for shell integration tests (dev-plan §7.2: mock child process).
// Emulates the QEMU surface BreadESP depends on for task P0.4:
//   - `-qmp tcp:127.0.0.1:<port>,server=on,wait=off` control channel
//   - UART0 bytes on stdout after `cont`
//   - `--exit-error` simulates a crash (exit code 1)
// Usage: node mock-qemu.mjs [-kernel <elf>] [-qmp tcp:127.0.0.1:PORT,server=on,wait=off] [--exit-error]
import net from 'node:net';

const argv = process.argv.slice(2);

if (argv.includes('--exit-error')) {
  process.stderr.write('mock-qemu: simulated crash\n');
  process.exit(1);
}

const qmpIdx = argv.indexOf('-qmp');
const spec = qmpIdx >= 0 ? argv[qmpIdx + 1] : '';
const match = /tcp:127\.0\.0\.1:(\d+)/.exec(spec);
const qmpPort = match === null ? null : Number(match[1]);
const kernelIdx = argv.indexOf('-kernel');
const firmware = kernelIdx >= 0 ? argv[kernelIdx + 1] : null;

process.stderr.write(`mock-qemu: firmware=${firmware} qmp=127.0.0.1:${qmpPort}\n`);

const reply = (socket, id, extra = {}) => {
  socket.write(JSON.stringify({ return: extra, id }) + '\n');
};

const server = qmpPort === null ? null : net.createServer((socket) => {
  socket.write(JSON.stringify({
    QMP: { version: { qemu: { micro: 0, minor: 2, major: 9 } }, capabilities: [] },
  }) + '\n');
  let buf = '';
  socket.on('data', (d) => {
    buf += d.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      switch (msg.execute) {
        case 'cont':
          reply(socket, msg.id);
          process.stdout.write('Hello ESP32\r\n'); // UART0 bytes, as the real firmware prints
          break;
        case 'quit':
          reply(socket, msg.id);
          setTimeout(() => process.exit(0), 20); // let the reply flush
          break;
        default:
          reply(socket, msg.id);
      }
    }
  });
});

if (server !== null) server.listen(qmpPort, '127.0.0.1');
setInterval(() => {}, 1 << 30); // keep the process alive until killed/quit
