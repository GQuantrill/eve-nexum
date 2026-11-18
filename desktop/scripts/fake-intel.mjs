// Testing aid: write an intel line, stamped now, into a channel's chat log in
// the EVE log folder, as EVE would. Creates the log if the channel has none.
//
//   node scripts/fake-intel.mjs east.imperium "Some Pilot  1DQ1-A"
//
// The app skips what's already in a log when it first sees it, so run this
// once to create the log, then again for a line it will report.
import { appendFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [channel, text, dirArg] = process.argv.slice(2);
if (!channel || !text) {
  console.error('usage: node scripts/fake-intel.mjs <channel> "<text>" [log folder]');
  process.exit(1);
}
const dir = dirArg ?? join(homedir(), 'Documents', 'EVE', 'logs', 'Chatlogs');
const p2 = (n) => String(n).padStart(2, '0');
const d = new Date();
const stamp = `${d.getUTCFullYear()}.${p2(d.getUTCMonth() + 1)}.${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
const utf16 = (s) => Buffer.from(s, 'utf16le');

const existing = existsSync(dir) && readdirSync(dir)
  .filter((f) => f.toLowerCase().startsWith(`${channel.toLowerCase()}_`) && f.endsWith('.txt'))
  .sort().pop();
let file = existing && join(dir, existing);
if (!file) {
  const name = `${channel}_${stamp.replace(/[.:]/g, '').replace(' ', '_')}_1.txt`;
  file = join(dir, name);
  writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]),
    utf16(`\r\n  Channel Name:    ${channel}\r\n  Listener:        Test\r\n  Session started: ${stamp}\r\n\r\n`)]));
  console.log(`created ${file}`);
}
appendFileSync(file, utf16(`﻿[ ${stamp} ] Intel Tester > ${text}\r\n`));
console.log(`appended to ${file}: ${text}`);
