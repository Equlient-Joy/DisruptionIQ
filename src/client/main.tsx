import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './styles.css';
import './redesign.css';

const client = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: false, refetchOnWindowFocus: true } } });
createRoot(document.getElementById('root')!).render(
  <StrictMode><QueryClientProvider client={client}><App /></QueryClientProvider></StrictMode>,
);
