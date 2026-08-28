// PRD: §4.2, §F-SIM — QEMU-ESP32 subprocess lifecycle.
// Spawns qemu-system-xtensa with args from @breadesp/sim-core, pipes stdout (UART0) to log + UI.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { buildQemuArgs } from '@breadesp/sim-core';
import { EventEmitter } from 'node:events';

export type SimStatus = 'idle' | 'loaded' | 'running' | 'paused' | 'stopped' | 'error';

export interface QemuRunnerOptions {
  qemuBin: string;
  gdbPort?: number;
  dbusSocket?: string;
}

export class QemuRunner extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private status: SimStatus = 'idle';
  private uartBuf: string[] = [];

  getStatus(): SimStatus { return this.status; }

  /** Load firmware and arm QEMU (does not start execution until start()). */
  async load(input: { firmwareElf: string; chip: 'esp32' | 'esp32s3' | 'esp32c3'; } & QemuRunnerOptions): Promise<void> {
    if (this.proc) await this.stop();
    const argv = buildQemuArgs({
      qemuBin: input.qemuBin,
      firmwareElf: input.firmwareElf,
      chip: input.chip,
      gdbPort: input.gdbPort,
      dbusSocket: input.dbusSocket,
      noNetwork: true,                 // PRD §9 sandbox
    });
    this.proc = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (d: Buffer) => {
      const s = d.toString();
      this.uartBuf.push(s);
      this.emit('uart', s);
    });
    this.proc.stderr.on('data', (d: Buffer) => this.emit('log', d.toString()));
    this.proc.on('exit', (code) => {
      this.setStatus(code === 0 ? 'stopped' : 'error');
      this.proc = null;
    });
    this.setStatus('loaded');
  }

  async start(): Promise<void> {
    // QEMU starts executing immediately by default; pause/resume is managed via gdb/cont.
    // TODO(PRD §F-SIM-1): wire pause via QMP or gdb interrupt.
    if (!this.proc) throw new Error('qemu not loaded');
    this.setStatus('running');
  }

  async pause(): Promise<void> { this.setStatus('paused'); /* TODO: gdb interrupt */ }
  async step(): Promise<void> { /* TODO: gdb stepi */ }
  async reset(): Promise<void> { if (this.proc) { await this.stop(); this.setStatus('idle'); } }

  async stop(): Promise<void> {
    if (this.proc) { this.proc.kill('SIGTERM'); this.proc = null; }
    this.setStatus('stopped');
  }

  /** Inject keyboard input to UART0 stdin. */
  writeStdin(s: string): void { this.proc?.stdin.write(s); }

  private setStatus(s: SimStatus): void { this.status = s; this.emit('status', s); }
}
