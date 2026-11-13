#!/usr/bin/env node
import { main } from '../src/main.js';
import { loadCoarenaEnv } from '../src/coarena.js';

Promise.resolve().then(() => { loadCoarenaEnv(); return main(); })
  .then((code) => {
    if (typeof code === 'number') process.exitCode = code;
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`thefactory: ${message}\n`);
    process.exitCode = 1;
  });
