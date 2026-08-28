// PRD: §4.2 — QMP client stub for QEMU monitor protocol (pause/resume/status).
// TODO(PRD §F-SIM): implement JSON-RPC over the QMP unix socket.
export class QmpClient {
  // Stub: real implementation connects to qmp unix socket and sends {execute:'stop'|'cont'}.
  async stop(): Promise<void> { /* TODO */ }
  async cont(): Promise<void> { /* TODO */ }
}
