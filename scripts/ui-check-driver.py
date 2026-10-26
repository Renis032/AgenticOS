#!/usr/bin/env python3
"""Drives the Agentic OS page in the same WebKitGTK engine as the real window, step by step, for scripts/ui-check.js.

usage: ui-check-driver.py <url> <steps.json> <out dir> <width> <height>
Prints one JSON line per step: {"step": name, "problems": [...], "shot": path}.
"""
import json
import os
import sys

import gi

gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.0')
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

URL, STEPS, OUT, W, H = sys.argv[1], json.load(open(sys.argv[2])), sys.argv[3], int(sys.argv[4]), int(sys.argv[5])

# Collects page errors so each step can report them.
CAPTURE = """
window.__uiErrors = [];
addEventListener('error', (e) => __uiErrors.push(`${e.message} @ ${String(e.filename || '').split('/').pop()}:${e.lineno}`));
addEventListener('unhandledrejection', (e) => __uiErrors.push(`unhandled promise: ${(e.reason && e.reason.message) || e.reason}`));
const __ce = console.error; console.error = (...a) => { __uiErrors.push('console.error: ' + a.join(' ')); __ce(...a); };
document.documentElement.dataset.native = '1';
window.osNativeInfo = { layout: ':minimize,maximize,close', version: 'ui-check' };
"""

# What counts as broken after each step.
CHECK = """JSON.stringify((() => {
  const p = (window.__uiErrors || []).splice(0).map((e) => 'JS error: ' + e);
  const acts = [...new Set([...document.querySelectorAll('[data-act]')].filter((e) => e.offsetParent || e.closest('.on')).map((e) => e.dataset.act))];
  for (const a of acts) if (typeof ACT === 'undefined' || !ACT[a]) p.push('button with no action: ' + a);
  for (const b of document.querySelectorAll('.banner button, .modal-wrap.on button, .menu.on .mi, .pop.on button, .composer button')) {
    const r = b.getBoundingClientRect();
    let scroller = b.parentElement;
    while (scroller && !(/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight + 1)) scroller = scroller.parentElement;
    if (scroller) continue;
    if (r.width && b.offsetParent && (r.bottom > innerHeight + 1 || r.top < 0 || r.right > innerWidth + 1)) p.push('off screen: ' + (b.textContent || b.dataset.act || '').trim().slice(0, 40));
  }
  for (const el of document.querySelectorAll('#top, .jhead h2, .toolbar, .prow')) if (el.offsetParent && el.scrollWidth > el.clientWidth + 4) p.push('overflows: ' + (el.id ? '#' + el.id : el.className.split(' ')[0]) + ' (' + el.scrollWidth + ' > ' + el.clientWidth + ')');
  const top = document.getElementById('top');
  if (top && Math.round(top.getBoundingClientRect().height) > 50) p.push('title bar wraps to ' + Math.round(top.getBoundingClientRect().height) + 'px');
  if (document.body.scrollWidth > innerWidth + 2) p.push('page scrolls sideways');
  return p;
})())"""

win = Gtk.Window()
win.set_default_size(W, H)
ucm = WebKit2.UserContentManager()
ucm.register_script_message_handler('agentos')
ucm.add_script(WebKit2.UserScript(CAPTURE, WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserScriptInjectionTime.START, None, None))
view = WebKit2.WebView(user_content_manager=ucm)
view.get_settings().set_enable_write_console_messages_to_stdout(False)
win.add(view)
win.show_all()
state = {'i': -1, 'loaded': False}


def js(code, done=None):
    def cb(v, res):
        try:
            out = v.run_javascript_finish(res).get_js_value().to_string()
        except Exception as e:  # noqa: BLE001
            out = json.dumps(['driver: ' + str(e)])
        if done:
            done(out)
    view.run_javascript(code, None, cb)


def shot(name, then):
    path = os.path.join(OUT, '%02d-%s.png' % (state['i'] + 1, name))

    def cb(v, res):
        try:
            v.get_snapshot_finish(res).write_to_png(path)
        except Exception:  # noqa: BLE001
            pass
        then(path)
    view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, cb)


def next_step():
    state['i'] += 1
    if state['i'] >= len(STEPS):
        Gtk.main_quit()
        return False
    step = STEPS[state['i']]
    if step.get('size'):
        win.resize(*step['size'])
    js('(async () => { try { %s } catch (e) { __uiErrors.push("step failed: " + e.message); } })(); "ok"' % step['js'])
    GLib.timeout_add(int(step.get('wait', 700)), lambda: check(step))
    return False


def check(step):
    def got(out):
        try:
            problems = json.loads(out)
        except ValueError:
            problems = ['driver: ' + out[:200]]
        shot(step['name'], lambda path: (print(json.dumps({'step': step['name'], 'problems': problems, 'shot': path}), flush=True), next_step()))
    js(CHECK, got)
    return False


def loaded(v, ev):
    if ev == WebKit2.LoadEvent.FINISHED and not state['loaded'] and '/__app' not in (v.get_uri() or ''):
        state['loaded'] = True
        GLib.timeout_add(2500, next_step)


view.connect('load-changed', loaded)
view.load_uri(URL)
GLib.timeout_add_seconds(240, Gtk.main_quit)
Gtk.main()
