#!/usr/bin/env node
// One-time CLI: prompts for the admin password on stdin and prints a bcrypt
// hash to paste into .env as ADMIN_PASSWORD_HASH. The plaintext password is
// never written to disk or logged.

const bcrypt = require('bcryptjs');

const CTRL_C = '';
const BACKSPACE_CHARS = new Set(['', '']); // \b and DEL
const ENTER_CHARS = new Set(['\n', '\r']);

function promptHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let input = '';
    process.stdout.write(question);

    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    // A chunk can contain more than one character — piped/non-TTY input in
    // particular tends to arrive as the whole line in a single chunk — so
    // each character is walked individually rather than treating the chunk
    // itself as "the next character".
    const onData = (chunk) => {
      for (const char of chunk.toString()) {
        if (ENTER_CHARS.has(char)) {
          cleanup();
          process.stdout.write('\n');
          resolve(input);
          return;
        } else if (char === CTRL_C) {
          cleanup();
          process.stdout.write('\n');
          process.exit(1);
        } else if (BACKSPACE_CHARS.has(char)) {
          input = input.slice(0, -1);
        } else {
          input += char;
        }
      }
    };

    function cleanup() {
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    }

    stdin.on('data', onData);
  });
}

async function main() {
  const password = await promptHidden('Admin password: ');
  if (!password || password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }
  const hash = bcrypt.hashSync(password, 12);
  console.log('\nAdd this to your .env file:\n');
  console.log(`ADMIN_PASSWORD_HASH=${hash}`);
}

main();
