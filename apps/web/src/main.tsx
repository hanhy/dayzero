import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import './library.css';

const benchmark = new URLSearchParams(location.search).get('benchmark') === '1';
const App = lazy(() =>
  benchmark ? import('./BenchmarkApp.tsx') : import('./LibraryApp.tsx'),
);
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<div className="loading-space">正在载入知识空间…</div>}>
      <App />
    </Suspense>
  </StrictMode>,
);
