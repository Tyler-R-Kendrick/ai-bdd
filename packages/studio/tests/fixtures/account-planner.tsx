import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AccountPlannerPanel } from '../../client/components/remote/AccountPlannerPanel.tsx';
function Fixture() {
  const [artifact, setArtifact] = useState({
    id: '00000000-0000-4000-8000-000000000001',
    version: 7,
  });
  const [readOnly, setReadOnly] = useState(
    new URLSearchParams(location.search).has('viewer'),
  );
  const [changes, setChanges] = useState(0);
  Object.assign(window, {
    accountPlannerFixture: { setArtifact, setReadOnly },
  });
  return (
    <main style={{ maxWidth: 640, margin: '28px auto', padding: 16 }}>
      <AccountPlannerPanel
        artifactId={artifact.id}
        artifactVersion={artifact.version}
        readOnly={readOnly}
        onChanged={() => setChanges((value) => value + 1)}
      />
      <output hidden id="fixture-changes">
        {changes}
      </output>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
