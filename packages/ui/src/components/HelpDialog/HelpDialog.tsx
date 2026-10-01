// T3.5 — keyboard & mouse help. Radix Dialog with two entry points: the
// TopBar button and the global `?` key (guarded by isEditableTarget so
// typing "?" into the serial console never opens it).
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useT } from '../../i18n';
import { SHORTCUTS, isEditableTarget } from './shortcuts';

export function HelpDialog() {
  const [open, setOpen] = useState(false);
  const t = useT();

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== '?') return;
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded border border-bb-line bg-white px-2.5 text-xs font-medium text-bb-ink cursor-pointer hover:bg-slate-50"
          title="?"
        >
          ? {t('topbar.help')}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[420px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-md border border-bb-line bg-white p-4 shadow-lg">
          <Dialog.Title className="m-0 mb-3 text-sm font-semibold text-bb-ink">
            {t('help.title')}
          </Dialog.Title>
          <div className="flex flex-col gap-4">
            {SHORTCUTS.map((section) => (
              <section key={section.titleKey}>
                <h4 className="m-0 mb-2 text-xs font-semibold uppercase tracking-wide text-bb-muted">
                  {t(section.titleKey)}
                </h4>
                <table className="w-full border-collapse text-xs">
                  <tbody>
                    {section.items.map((item) => (
                      <tr key={item.keys} className="border-b border-slate-100 last:border-b-0">
                        <td className="py-1.5 pr-4 align-top">
                          <kbd className="rounded border border-bb-line bg-slate-50 px-1.5 py-0.5 font-mono text-[11px] text-bb-ink">
                            {item.keys}
                          </kbd>
                        </td>
                        <td className="py-1.5 text-bb-ink">{t(item.descKey)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ))}
          </div>
          <Dialog.Close asChild>
            <button
              type="button"
              className="mt-4 inline-flex h-7 items-center rounded border border-bb-line bg-white px-3 text-xs font-medium text-bb-ink cursor-pointer hover:bg-slate-50"
            >
              {t('common.close')}
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
