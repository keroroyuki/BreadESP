// T3.2 — the single top bar replacing the four stacked strips (header +
// ProjectToolbar + ExternalFirmware + SimControls). One 44px row: brand +
// status light | project group | firmware group | sim group, with the
// utilities (help, language) pushed right. Groups own their state; the bar
// only lays them out.
import { SimStatusLight } from '../SimStatusLight/SimStatusLight';
import { ProjectGroup } from './ProjectGroup';
import { FirmwareGroup } from './FirmwareGroup';
import { SimGroup } from './SimGroup';
import { LangToggle } from './LangToggle';
import { HelpDialog } from '../HelpDialog/HelpDialog';

const Divider = () => <span className="mx-1 w-px self-stretch bg-bb-line" />;

export function TopBar() {
  return (
    <div className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-bb-line bg-bb-canvas px-2">
      <strong className="shrink-0 px-1 text-sm text-bb-ink">BreadESP</strong>
      <span className="shrink-0">
        <SimStatusLight />
      </span>
      <Divider />
      <ProjectGroup />
      <Divider />
      <FirmwareGroup />
      <Divider />
      <SimGroup />
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <HelpDialog />
        <LangToggle />
      </div>
    </div>
  );
}
