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
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-bb-line bg-bb-canvas px-2">
      <span className="flex shrink-0 items-center gap-1.5 pl-1 pr-1.5">
        <svg width="21" height="21" viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect x="2.5" y="5.5" width="19" height="13" rx="2.5" fill="#eff6ff" stroke="#2563eb" strokeWidth="1.4" />
          <path d="M4 12h16" stroke="#bfdbfe" strokeWidth="1.2" strokeDasharray="2 2" />
          <circle cx="6.6" cy="9" r="0.9" fill="#2563eb" opacity="0.75" />
          <circle cx="9.6" cy="9" r="0.9" fill="#2563eb" opacity="0.75" />
          <circle cx="14.4" cy="9" r="0.9" fill="#2563eb" opacity="0.75" />
          <circle cx="17.4" cy="9" r="0.9" fill="#2563eb" opacity="0.75" />
          <circle cx="6.6" cy="15" r="0.9" fill="#2563eb" opacity="0.75" />
          <circle cx="9.6" cy="15" r="0.9" fill="#2563eb" opacity="0.75" />
          <circle cx="14.4" cy="15" r="0.9" fill="#2563eb" opacity="0.75" />
          <circle cx="17.4" cy="15" r="0.9" fill="#2563eb" opacity="0.75" />
        </svg>
        <strong className="text-[13px] font-semibold tracking-tight text-bb-ink">BreadESP</strong>
      </span>
      <span className="shrink-0">
        <SimStatusLight />
      </span>
      <Divider />
      {/* The control strip scrolls on its own: on a 1080 px window the groups
          are wider than the bar, and clipping the language switch was worse
          than letting the middle region scroll. */}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        <span className="flex shrink-0 items-center">
          <ProjectGroup />
        </span>
        <Divider />
        <span className="flex shrink-0 items-center">
          <FirmwareGroup />
        </span>
        <Divider />
        <span className="flex shrink-0 items-center">
          <SimGroup />
        </span>
      </div>
      <div className="ml-1 flex shrink-0 items-center gap-1.5">
        <HelpDialog />
        <LangToggle />
      </div>
    </div>
  );
}
