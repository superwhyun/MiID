#!/usr/bin/env node
/**
 * MiID E2E Test Runner
 */

const { spawn } = require('child_process');
const path = require('path');
const h = require('./test-helpers');

const tests = [
  { name: 'Login Flow', file: 'test-login-flow.js' },
  { name: 'Deny Flow', file: 'test-deny-flow.js' },
  { name: 'Revoke Flow', file: 'test-revoke-flow.js' }
];

function runTestFile(testFile) {
  return new Promise((resolve, reject) => {
    const testPath = path.join(__dirname, testFile);
    const proc = spawn('node', [testPath], {
      stdio: 'inherit',
      env: process.env
    });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Test ${testFile} failed with code ${code}`));
    });

    proc.on('error', reject);
  });
}

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('  MiID E2E Test Suite');
  console.log('='.repeat(60) + '\n');

  // Check servers
  try {
    await h.waitForServers(10000);
  } catch (err) {
    console.error('\nError: Servers are not ready.');
    console.error('Please start Gateway (port 14000) and Wallet (port 17000) first.\n');
    console.error('Commands:');
    console.error('  npm run start:gateway');
    console.error('  npm run start:wallet\n');
    process.exit(1);
  }

  const results = { passed: 0, failed: 0, errors: [] };

  for (const test of tests) {
    console.log(`\nRunning: ${test.name}...`);
    try {
      await runTestFile(test.file);
      results.passed++;
    } catch (err) {
      results.failed++;
      results.errors.push({ test: test.name, error: err.message });
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('  TEST SUMMARY');
  console.log('='.repeat(60));
  console.log(`  ${h.colors.green}Passed: ${results.passed}${h.colors.reset}`);
  console.log(`  ${h.colors.red}Failed: ${results.failed}${h.colors.reset}`);
  console.log(`  Total:  ${tests.length}`);

  if (results.errors.length > 0) {
    console.log('\n  Failed Tests:');
    results.errors.forEach(e => {
      console.log(`    - ${e.test}: ${e.error}`);
    });
  }

  console.log('='.repeat(60) + '\n');
  process.exit(results.failed > 0 ? 1 : 0);
}

main();
