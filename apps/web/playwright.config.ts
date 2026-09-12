import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'./tests', use:{baseURL:'http://127.0.0.1:4175'}, webServer:{command:'pnpm dev --port 4175',url:'http://127.0.0.1:4175',reuseExistingServer:!process.env.CI},workers:1});
