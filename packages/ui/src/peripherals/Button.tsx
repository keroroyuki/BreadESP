// PRD: §F-PER-2 — Button visual component (click -> driveInput to Bridge).
import { bridge } from '../ipc/bridge';

export function Button({ instanceId, pin = '1' }: { instanceId: string; pin?: string }) {
  const press = () => bridge.per.driveInput({ instanceId, pin, level: 1 });
  const release = () => bridge.per.driveInput({ instanceId, pin, level: 0 });
  return (
    <button
      onMouseDown={press}
      onMouseUp={release}
      onMouseLeave={release}
      style={{ padding: '6px 12px' }}
    >
      BTN
    </button>
  );
}
