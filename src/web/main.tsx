// The board's library entry leaves fonts to the host; these are the weights
// its standalone build loads.
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/700.css';
import '@fontsource/intel-one-mono/400.css';
import '@fontsource/intel-one-mono/500.css';
import '@fontsource/intel-one-mono/600.css';
import '@fontsource/intel-one-mono/700.css';
import '@shipbench/board/styles.css';
import './radar.css';

import shipbenchLogo from '@shipbench/board/dist/logo.svg?url';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';

// ShipBench's own mark, straight from the board package, so Radar's browser
// tab is recognisable and follows any brand update on upgrade.
const icon = document.createElement('link');
icon.rel = 'icon';
icon.type = 'image/svg+xml';
icon.href = shipbenchLogo;
document.head.append(icon);

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('No #root element found in index.html.');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
