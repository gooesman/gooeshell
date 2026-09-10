import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './terminal-fonts.css';
document.fonts.load('14px "DejaVu Sans Mono"').finally(()=>createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>));
