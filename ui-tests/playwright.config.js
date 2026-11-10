const baseConfig = require('@jupyterlab/galata/lib/playwright-config');

module.exports = {
  ...baseConfig,
  timeout: 120000,
  workers: 1,
  testDir: './tests',
  use: {
    ...baseConfig.use,
    baseURL: 'http://127.0.0.1:8888',
    channel: 'chrome-for-testing'
  }
};
