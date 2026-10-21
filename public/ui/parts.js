// Agentic OS UI parts: small, dependency-free building blocks every micro app reuses.
(function () {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function md(src) {
    return String(src ?? '').split(/```[^\n]*\n?/).map((p, i) => {
      if (i % 2) return `<pre>${esc(p)}</pre>`;
      let h = esc(p).replace(/^#{1,4} (.*)$/gm, '<h4>$1</h4>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/^\s*[-*] (.*)$/gm, '<li>$1</li>');
      h = h.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
      return h.split(/\n{2,}/).map((x) => (/^<(h4|ul|pre)/.test(x.trim()) ? x : `<p>${x.replace(/\n/g, '<br>')}</p>`)).join('');
    }).join('');
  }
  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }
  function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
  function toast(text) { const t = el(`<div class="p-toast">${esc(text)}</div>`); document.body.appendChild(t); setTimeout(() => t.remove(), 3500); }
  function diff(text) {
    return `<pre class="p-diff">${esc(text).split('\n').map((l) => (l.startsWith('@@') ? `<span class="h">${l}</span>` : l.startsWith('+') && !l.startsWith('+++') ? `<span class="a">${l}</span>` : l.startsWith('-') && !l.startsWith('---') ? `<span class="d">${l}</span>` : l + '\n')).join('')}</pre>`;
  }
  function commentBox({ placeholder, value, onChange }) {
    const box = el(`<div class="p-comment"><textarea placeholder="${esc(placeholder || 'Comment…')}"></textarea><div class="hint">Saved automatically.</div></div>`);
    const ta = box.querySelector('textarea');
    ta.value = value || '';
    let timer = null;
    ta.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => onChange && onChange(ta.value), 400); });
    return box;
  }
  function reviewCard({ title, meta, pill, body, comment, onComment, placeholder }) {
    const card = el(`<section class="p-card"><div class="p-card-h">${pill ? `<span class="p-pill ${esc(pill[1] || '')}">${esc(pill[0])}</span>` : ''}<span class="t" title="${esc(title)}">${esc(title)}</span>${meta ? `<span class="m">${esc(meta)}</span>` : ''}</div><div class="p-card-b"></div></section>`);
    card.querySelector('.p-card-b').innerHTML = body || '';
    card.appendChild(commentBox({ placeholder, value: comment, onChange: onComment }));
    return card;
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied.'); }
    catch { const ta = el('<textarea style="position:fixed;opacity:0"></textarea>'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('Copied.'); }
  }
  window.Parts = { esc, md, api, el, toast, diff, commentBox, reviewCard, copy };
})();
