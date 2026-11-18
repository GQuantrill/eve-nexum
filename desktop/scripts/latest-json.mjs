// Release helper: after `yarn build` (with the signing key set), add this
// machine's signed update bundle to desktop/latest.json, the feed every
// installed app checks. Run once per platform; entries for other platforms
// already in the file are kept.
//
//   node scripts/latest-json.mjs "What changed, in a sentence or two"
//
// Then upload the bundle it names to the GitHub release desktop-v<version>,
// and commit latest.json (it goes live when it reaches main).
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const REPO = 'GQuantrill/eve-nexum';
const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const version = conf.version;
const arch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch] ?? process.arch;
const os = { darwin: 'darwin', win32: 'windows', linux: 'linux' }[process.platform];
const platform = `${os}-${arch}`;

// The updater bundle per OS, and where tauri build leaves it.
const bundleDir = 'src-tauri/target/release/bundle';
const want = { darwin: ['macos', '.app.tar.gz'], windows: ['nsis', '-setup.exe'], linux: ['appimage', '.AppImage'] }[os];
const dir = join(bundleDir, want[0]);
const file = existsSync(dir) && readdirSync(dir).find((f) => f.endsWith(want[1]));
if (!file || !existsSync(join(dir, `${file}.sig`))) {
  console.error(`No signed bundle in ${dir}. Build with TAURI_SIGNING_PRIVATE_KEY set.`);
  process.exit(1);
}
const asset = file.replace(/ /g, '.');
const feed = existsSync('latest.json') ? JSON.parse(readFileSync('latest.json', 'utf8')) : { platforms: {} };
if (feed.version !== version) feed.platforms = {}; // a new version starts fresh
feed.version = version;
feed.notes = process.argv[2] ?? feed.notes ?? '';
feed.pub_date = new Date().toISOString();
feed.platforms[platform] = {
  signature: readFileSync(join(dir, `${file}.sig`), 'utf8').trim(),
  url: `https://github.com/${REPO}/releases/download/desktop-v${version}/${asset}`,
};
writeFileSync('latest.json', JSON.stringify(feed, null, 2) + '\n');
console.log(`latest.json: ${platform} -> ${basename(join(dir, file))} (upload as ${asset})`);
