import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import 'katex/dist/katex.min.css';
import './styles.css';
import { App } from './App.tsx';
import { ErrorBoundary, Tooltips } from './components/ui.tsx';
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Tooltips delayDuration={400}>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </Tooltips>
  </React.StrictMode>,
);
