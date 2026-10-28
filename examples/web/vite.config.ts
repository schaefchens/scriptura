import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Scriptura's packages from their sources, which their exports offer as "source".
export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['source', 'module', 'browser', 'development|production'] },
});
