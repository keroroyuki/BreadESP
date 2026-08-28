// PRD: §4.2 — DBus forward channel. Receives BusTransaction frames from the QEMU custom device
// over a unix socket and forwards them to the PeripheralManager.
// TODO(PRD §4.2): implement the framing protocol once the QEMU device source is built.
import type { BusTransaction } from '@breadesp/peripherals';

export type TransactionHandler = (tx: BusTransaction) => void;

export class DBusChannel {
  private handler?: TransactionHandler;

  onTransaction(handler: TransactionHandler): void { this.handler = handler; }

  async listen(socketPath: string): Promise<void> {
    if (!this.handler) throw new Error('dbus: register onTransaction() before listen()');
    // TODO(PRD §4.2): connect node:net to socketPath, parse length-prefixed JSON frames,
    // deserialize into BusTransaction, call this.handler.
    void socketPath;
  }

  async close(): Promise<void> { /* TODO */ }
}
