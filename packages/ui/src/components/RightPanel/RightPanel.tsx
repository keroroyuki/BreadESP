// T4.4 — right column: Radix Tabs over [Properties][Debug]. The Debug tab
// hosts the Inspector unchanged (forceMount keeps its input state alive
// across tab switches); picking an instance on the canvas auto-switches to
// Properties so the edit target is immediately visible.
import { useEffect, useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { useT } from '../../i18n';
import { useSelectionStore } from '../../store/selectionStore';
import { PropsPanel } from '../PropsPanel/PropsPanel';
import { Inspector } from '../Inspector/Inspector';

export function RightPanel() {
  const instanceId = useSelectionStore((s) => s.instanceId);
  const [tab, setTab] = useState('properties');
  const t = useT();

  useEffect(() => {
    if (instanceId !== null) setTab('properties');
  }, [instanceId]);

  // Segmented control rather than underline tabs: two peers in a 300 px column
  // read better as one switch than as two half-width strips with a rule.
  const triggerClass = (activeFor: string): string =>
    `h-6 flex-1 cursor-pointer rounded border-0 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-bb-primary/40 ${
      tab === activeFor
        ? 'bg-white font-medium text-bb-ink shadow-sm'
        : 'bg-transparent text-bb-muted hover:text-bb-ink'
    }`;

  return (
    <Tabs.Root
      value={tab}
      onValueChange={setTab}
      className="flex h-full min-h-0 w-[300px] shrink-0 flex-col border-l border-bb-line bg-white"
    >
      <Tabs.List className="mx-2 mt-1.5 flex shrink-0 items-center gap-0.5 rounded-md bg-slate-200/70 p-0.5">
        <Tabs.Trigger value="properties" className={triggerClass('properties')}>
          {t('props.title')}
        </Tabs.Trigger>
        <Tabs.Trigger value="debug" className={triggerClass('debug')}>
          {t('props.debug')}
        </Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="properties" className="min-h-0 flex-1 overflow-auto">
        <PropsPanel />
      </Tabs.Content>
      <Tabs.Content
        value="debug"
        forceMount
        className="min-h-0 flex-1 overflow-auto data-[state=inactive]:hidden"
      >
        <Inspector />
      </Tabs.Content>
    </Tabs.Root>
  );
}
