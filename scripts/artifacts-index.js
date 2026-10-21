#!/usr/bin/env node
'use strict';
const { cli, fs, path } = require('./_util');

const DIR = path.join(__dirname, '..', 'artifacts');
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function build() {
  fs.mkdirSync(DIR, { recursive: true });
  const items = fs.readdirSync(DIR, { withFileTypes: true }).filter((d) => d.name !== 'index.html' && !d.name.startsWith('.')).map((d) => {
    const p = path.join(DIR, d.name);
    const page = d.isDirectory() ? path.join(p, 'index.html') : p;
    let title = d.name, desc = '';
    try {
      const html = fs.readFileSync(page, 'utf8').slice(0, 20000);
      title = ((html.match(/<title>([^<]*)<\/title>/i) || [])[1] || d.name).trim();
      desc = ((html.match(/<meta\s+name="description"\s+content="([^"]*)"/i) || [])[1] || '').trim();
    } catch {}
    const files = d.isDirectory() ? fs.readdirSync(p).filter((f) => /\.(pdf|png|jpe?g)$/i.test(f)) : [];
    return { name: d.name, href: d.isDirectory() ? `${encodeURIComponent(d.name)}/` : encodeURIComponent(d.name), title, desc, mtime: fs.statSync(p).mtimeMs, files };
  }).sort((a, b) => b.mtime - a.mtime);
  fs.writeFileSync(path.join(DIR, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Artifacts</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:32px auto;max-width:860px;padding:0 16px;color:#1b2430;background:#f6f7f9}@media(prefers-color-scheme:dark){body{background:#0e1319;color:#e4eaf1}.a{background:#141b23!important;border-color:#26313e!important}}
input{width:100%;padding:10px 12px;border-radius:10px;border:1px solid #ccd;font:inherit;margin:12px 0 18px}.a{display:block;padding:12px 14px;border:1px solid #dfe4ea;border-radius:12px;margin:8px 0;background:#fff;text-decoration:none;color:inherit}
.a small{color:#8a95a3}.a b{display:block}</style></head><body><h1>Artifacts</h1><p>${items.length} item${items.length === 1 ? '' : 's'}, newest first.</p>
<input id="q" placeholder="Search titles and descriptions…" autofocus>
${items.map((i) => `<a class="a" href="${i.href}" data-s="${esc((i.title + ' ' + i.desc + ' ' + i.name).toLowerCase())}"><b>${esc(i.title)}</b>${i.desc ? `${esc(i.desc)}<br>` : ''}<small>${new Date(i.mtime).toISOString().slice(0, 10)} · ${esc(i.name)}${i.files.length ? ` · ${i.files.map(esc).join(', ')}` : ''}</small></a>`).join('\n')}
<script>document.getElementById('q').oninput=(e)=>{const q=e.target.value.toLowerCase();for(const a of document.querySelectorAll('.a'))a.style.display=a.dataset.s.includes(q)?'':'none';};</script></body></html>\n`);
  return items.length;
}

function run() { return `Artifacts index rebuilt: ${build()} item(s) in ${DIR}/index.html`; }
module.exports = { build };
if (require.main === module) cli(run);
