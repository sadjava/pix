import { useCallback, useEffect, useState } from 'react';
import { flushWork } from './flush.ts';
import { EditorScreen } from '../editor/EditorScreen.tsx';
import { Gallery } from '../projects/Gallery.tsx';
import { UpdatePrompt } from '../pwa/UpdatePrompt.tsx';

export function App() {
  const [hash, setHash] = useState(() => location.hash || '#/');
  const [busy, setBusy] = useState(false);
  const onBusy = useCallback((value: boolean) => setBusy(value), []);

  useEffect(() => {
    const onHash = () => setHash(location.hash || '#/');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const edit = /^#\/edit\/(.+)$/.exec(hash);
  const id = edit?.[1] ? decodeURIComponent(edit[1]) : null;

  return (
    <>
      <UpdatePrompt
        busy={busy}
        onApply={flushWork}
      />
      {id ? (
        <EditorScreen id={id} onBusy={onBusy} onBack={() => { location.hash = '#/'; }} />
      ) : (
        <Gallery onOpen={(projectId) => { location.hash = `#/edit/${projectId}`; }} />
      )}
    </>
  );
}
