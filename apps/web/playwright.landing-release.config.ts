import { defineConfig, devices } from '@playwright/test';
if (process.env.WEB_DEPLOY_MODE !== 'landing') throw new Error('Explicit landing mode required');
const port=Number(process.env.PUBLIC_PORT ?? '5187');
if (!Number.isInteger(port) || port<1024 || port>65535) throw new Error('Invalid public preview port');
export default defineConfig({
  testDir:'./e2e',testMatch:'landing-release.spec.ts',workers:1,retries:0,
  reporter:[['json',{outputFile:'.local/landing-release-browser.json'}]],
  projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}],
  use:{baseURL:`http://127.0.0.1:${port}`,screenshot:'only-on-failure',trace:'retain-on-failure'},
  webServer:{command:'pnpm preview:public',url:`http://127.0.0.1:${port}`,reuseExistingServer:false,timeout:30_000}
});
