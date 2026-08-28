// PRD: §F-DBG-5 — GDB bridge over GDB/MI.
// Spawns xtensa-esp32-elf-gdb --interpreter=mi, connects to QEMU's gdb stub.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { parseMiLine, type MiRecord } from './MiParser.js';

export interface BreakpointInfo { id: number; address: string; enabled: boolean; }

export class GdbBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private token = 0;
  private pending = new Map<string, (rec: MiRecord) => void>();

  async start(opts: { gdbBin: string; elfPath: string; targetHost: string; port: number }): Promise<void> {
    if (this.proc) await this.stop();
    this.proc = spawn(opts.gdbBin, [
      '--interpreter=mi', '--quiet', opts.elfPath,
    ]);
    this.proc.stdout.on('data', (d: Buffer) => this.onOutput(d.toString()));
    this.proc.stderr.on('data', (d: Buffer) => console.error('[gdb stderr]', d.toString()));
    await this.send(`target remote ${opts.targetHost}:${opts.port}`);
  }

  async setBreakpoint(at: string): Promise<BreakpointInfo> {
    const rec = await this.send(`break ${at}`);
    const bkpt = (rec.payload?.bkpt ?? {}) as Record<string, unknown>;
    return { id: Number(bkpt.number), address: String(bkpt.addr ?? ''), enabled: true };
  }
  async removeBreakpoint(id: number): Promise<void> { await this.send(`delete ${id}`); }
  async continue(): Promise<void> { await this.send('exec-continue'); }
  async step(): Promise<void> { await this.send('exec-step'); }
  async stop(): Promise<void> { if (this.proc) { this.proc.kill(); this.proc = null; } }

  /** Request vars/regs (TODO: implement MI commands). */
  async vars(): Promise<Record<string, unknown>> { /* TODO(PRD §F-DBG-3) */ return {}; }
  async regs(): Promise<Record<string, unknown>> { /* TODO(PRD §F-DBG-3) */ return {}; }

  private send(cmd: string): Promise<MiRecord> {
    if (!this.proc) throw new Error('gdb not started');
    const token = String(++this.token);
    return new Promise((resolve) => {
      this.pending.set(token, resolve);
      this.proc!.stdin.write(`${token}${cmd}\n`);
    });
  }

  private onOutput(s: string): void {
    for (const line of s.split('\n')) {
      const rec = parseMiLine(line);
      if (!rec || rec.type !== 'result') continue;
      const token = rec.token;
      const cb = token ? this.pending.get(token) : undefined;
      if (token && cb) { this.pending.delete(token); cb(rec); }
    }
  }
}
