const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir:'./tests', testMatch:'extension.spec.js', workers:1, timeout:30000,
  reporter:'list', use:{trace:'retain-on-failure'}
});
