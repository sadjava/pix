import { useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { ru } from '../i18n/ru.ts';

export function UpdatePrompt({ busy, onApply }: { busy: boolean; onApply: () => Promise<void> }) {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();
  const [waiting, setWaiting] = useState(false);

  if (!needRefresh) return null;
  return (
    <div className="banner" role="status">
      <p>{ru.updateReady}</p>
      <button
        type="button"
        disabled={busy || waiting}
        onClick={() => {
          setWaiting(true);
          void onApply().then(() => updateServiceWorker(true));
        }}
      >
        {ru.updateNow}
      </button>
      <button type="button" onClick={() => setNeedRefresh(false)}>
        {ru.updateLater}
      </button>
    </div>
  );
}
