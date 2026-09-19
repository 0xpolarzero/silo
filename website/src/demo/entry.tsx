import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ReadOnlyDemo } from './read-only-demo';
import './style.css';

createRoot(document.getElementById('demo-root')!).render(<StrictMode><ReadOnlyDemo /></StrictMode>);
