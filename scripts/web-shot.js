#!/usr/bin/env node
'use strict';
// Screenshot of a web page or local HTML file with headless Chrome, in a throwaway browser profile.
const { parseArgs, home, cli, fs, path } = require('./_util');
const { spawnSync } = require('child_process');
const os = require('os');

const BROWSERS = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];

function run(argv, { cwd }) {
  const { pos, opt } = parseArgs(argv);
  if (pos.length < 2) return 'usage: web-shot <url | file.html> <out.png> [--size 1280x900] [--dark] [--wait ms] [--full]\n  e.g. web-shot http://127.0.0.1:8000 ~/shots/home.png --size 1440x900 --dark\n  Then Read the PNG to look at it.';
  const chrome = BROWSERS.find((b) => fs.existsSync(b));
  if (!chrome) return 'No Chrome or Chromium found.';
  const target = /^(https?|file):/.test(pos[0]) ? pos[0] : 'file://' + path.resolve(cwd, home(pos[0]));
  const out = path.resolve(cwd, home(pos[1]));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const [w, h] = String(opt.size || '1280x900').split('x').map(Number);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'webshot-'));
  try {
    const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', `--user-data-dir=${profile}`,
      `--window-size=${w || 1280},${opt.full ? 6000 : h || 900}`, `--virtual-time-budget=${Number(opt.wait) || 3000}`, `--screenshot=${out}`,
      ...(opt.dark ? ['--force-dark-mode', '--blink-settings=preferredColorScheme=0'] : ['--blink-settings=preferredColorScheme=1']), target];
    const r = spawnSync(chrome, args, { encoding: 'utf8', timeout: 90000 });
    if (!fs.existsSync(out)) return `Screenshot failed: ${(r.stderr || r.error || '').toString().split('\n').filter((l) => /error/i.test(l)).slice(-2).join(' ') || 'no file written'}`;
    return `Saved ${out} (${w}x${opt.full ? 'full' : h}${opt.dark ? ', dark' : ''}). Open it with Read to look at it.`;
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

module.exports = { run };
if (require.main === module) cli(run);
