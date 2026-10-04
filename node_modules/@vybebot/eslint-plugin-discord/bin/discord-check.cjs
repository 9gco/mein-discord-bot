#!/usr/bin/env node
const { runCli } = require('../dist/cli.cjs');

runCli().then((code) => {
  if (code !== 0) process.exit(code);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
