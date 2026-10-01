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

  const triggerClass = (activeFor: string): string =>
    `flex-1 h-8 cursor-pointer border-b-2 text-xs font-medium ${
      tab === activeFor
        ? 'border-bb-primary text-bb-ink'
        : 'border-transparent text-bb-muted hover:text-bb-ink'
    }`;

  return (
    <Tabs.Root
      value={tab}
      onValueChange={setTab}
      className="flex h-full min-h-0 w-[300px] shrink-0 flex-col border-l border-bb-line bg-white"
    >
      <Tabs.List className="flex shrink-0 border-b border-bb-line">
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
