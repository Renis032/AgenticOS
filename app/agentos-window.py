#!/usr/bin/env python3
"""Agentic OS desktop window: a native GTK window around the local Agentic OS backend.

The backend listens only on 127.0.0.1 and answers only requests carrying the app token
(data/app-token, readable only by you). This window presents that token once, gets a
session cookie, and keeps every page inside its own windows. Links to other sites open
in your default browser instead.
"""
import json
import os
import sys
import urllib.request

import gi

gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.0')
from gi.repository import Gdk, Gio, GLib, Gtk, WebKit2  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get('WORKPLACE_PORT', '4747'))
BASE = 'http://127.0.0.1:%d' % PORT
ICON = os.path.join(ROOT, 'app', 'icon.png')
STORE = os.path.expanduser('~/.agentos/window-%d' % PORT)


def token():
    with open(os.path.join(ROOT, 'data', 'app-token')) as f:
        return f.read().strip()


def ours(uri):
    return uri.startswith(BASE + '/') or uri == BASE or uri.startswith('about:') or uri.startswith('data:')


class AgenticOS(Gtk.Application):
    def __init__(self):
        super().__init__(application_id='local.agentos.AgenticOS%d' % PORT, flags=Gio.ApplicationFlags.FLAGS_NONE)
        self.context = None

    def do_startup(self):
        Gtk.Application.do_startup(self)
        GLib.set_prgname('AgenticOS')
        GLib.set_application_name('Agentic OS')
        os.makedirs(STORE, mode=0o700, exist_ok=True)
        manager = WebKit2.WebsiteDataManager(base_data_directory=STORE, base_cache_directory=os.path.join(STORE, 'cache'))
        self.context = WebKit2.WebContext.new_with_website_data_manager(manager)
        self.context.get_cookie_manager().set_persistent_storage(os.path.join(STORE, 'cookies.sqlite'), WebKit2.CookiePersistentStorage.SQLITE)
        self.context.set_cache_model(WebKit2.CacheModel.DOCUMENT_VIEWER)

    def do_activate(self):
        wins = self.get_windows()
        if wins:
            wins[0].present()
            return
        try:
            first = '%s/__app?t=%s' % (BASE, token())
        except OSError:
            first = None
        view = self.window(1440, 900)
        if first:
            view.load_uri(first)
        else:
            view.load_html(self.message('Agentic OS is not set up yet. Start it with ./agentos'), BASE + '/')

    def window(self, width, height, related=None):
        win = Gtk.ApplicationWindow(application=self, title='Agentic OS')
        win.set_default_size(width, height)
        if os.path.exists(ICON):
            win.set_icon_from_file(ICON)
        view = WebKit2.WebView.new_with_related_view(related) if related else WebKit2.WebView.new_with_context(self.context)
        settings = view.get_settings()
        settings.set_enable_developer_extras(False)
        settings.set_javascript_can_open_windows_automatically(True)
        settings.set_javascript_can_access_clipboard(True)
        settings.set_enable_write_console_messages_to_stdout(False)
        view.connect('decide-policy', self.policy)
        view.connect('create', self.popup)
        view.connect('load-failed', self.failed)
        view.connect('notify::title', lambda v, _p: win.set_title(v.get_title() or 'Agentic OS'))
        view.connect('close', lambda _v: win.destroy())
        win.connect('key-press-event', lambda _w, ev: self.keys(view, ev))
        win.add(view)
        if related is None:
            win.connect('delete-event', self.on_close)
            win.show_all()
        else:
            view.connect('ready-to-show', lambda _v: win.show_all())
        return view

    def call(self, method, path):
        req = urllib.request.Request(BASE + path, method=method, headers={'x-agentos-token': token(), 'content-type': 'application/json'}, data=b'{}' if method == 'POST' else None)
        with urllib.request.urlopen(req, timeout=4) as r:
            return json.loads(r.read().decode('utf-8'))

    def busy(self):
        state = self.call('GET', '/api/state')
        work = [a for a in state.get('agents', []) if a.get('status') in ('running', 'delegating', 'queued') or (a.get('resident') and a.get('current'))]
        jobs = [t for t in state.get('tickets', []) if t.get('status') in ('open', 'paused')]
        return work, jobs

    def on_close(self, win, _event):
        try:
            work, jobs = self.busy()
        except Exception:
            self.quit()
            return False
        if not work and not jobs:
            self.stop_backend()
            self.quit()
            return False
        names = ', '.join(sorted({a.get('persona') or a.get('id') for a in work})[:6])
        dialog = Gtk.MessageDialog(transient_for=win, modal=True, message_type=Gtk.MessageType.QUESTION, buttons=Gtk.ButtonsType.NONE,
                                   text='%d job%s still running' % (len(jobs) or 1, '' if (len(jobs) or 1) == 1 else 's'))
        dialog.format_secondary_text(('Working now: %s.\n\n' % names if names else '') +
                                     'Stop them and quit Agentic OS, or close the window and let them finish in the background? '
                                     'You can reopen the window any time from the applications menu.')
        dialog.add_button('Cancel', Gtk.ResponseType.CANCEL)
        dialog.add_button('Keep running in background', Gtk.ResponseType.NO)
        dialog.add_button('Stop them and quit', Gtk.ResponseType.YES)
        dialog.set_default_response(Gtk.ResponseType.NO)
        answer = dialog.run()
        dialog.destroy()
        if answer == Gtk.ResponseType.YES:
            self.stop_backend()
            self.quit()
            return False
        if answer == Gtk.ResponseType.NO:
            self.quit()
            return False
        return True

    def stop_backend(self):
        try:
            self.call('POST', '/api/shutdown')
        except Exception:
            pass

    def keys(self, view, ev):
        ctrl = ev.state & Gdk.ModifierType.CONTROL_MASK
        if ev.keyval == Gdk.KEY_F5 or (ctrl and ev.keyval in (Gdk.KEY_r, Gdk.KEY_R)):
            view.reload()
            return True
        if ctrl and ev.keyval in (Gdk.KEY_plus, Gdk.KEY_equal):
            view.set_zoom_level(min(2.0, view.get_zoom_level() + 0.1))
            return True
        if ctrl and ev.keyval == Gdk.KEY_minus:
            view.set_zoom_level(max(0.5, view.get_zoom_level() - 0.1))
            return True
        if ctrl and ev.keyval == Gdk.KEY_0:
            view.set_zoom_level(1.0)
            return True
        return False

    def popup(self, view, action):
        uri = action.get_request().get_uri()
        if uri and not ours(uri):
            self.external(uri)
            return None
        return self.window(1280, 860, related=view)

    def policy(self, _view, decision, kind):
        if kind in (WebKit2.PolicyDecisionType.NAVIGATION_ACTION, WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION):
            uri = decision.get_navigation_action().get_request().get_uri()
            if uri and not ours(uri):
                decision.ignore()
                self.external(uri)
                return True
        if kind == WebKit2.PolicyDecisionType.RESPONSE and not decision.is_mime_type_supported():
            uri = decision.get_request().get_uri()
            decision.ignore()
            self.open_file(uri)
            return True
        return False

    def open_file(self, uri):
        rel = uri[len(BASE):].split('?')[0]
        local = None
        if rel.startswith('/artifacts/'):
            local = os.path.join(ROOT, 'artifacts', GLib.uri_unescape_string(rel[len('/artifacts/'):], None) or '')
        elif rel.startswith('/api/uploads/'):
            local = os.path.join(ROOT, 'data', 'uploads', GLib.uri_unescape_string(rel[len('/api/uploads/'):], None) or '')
        if local and os.path.realpath(local).startswith(ROOT + os.sep) and os.path.isfile(local):
            Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(os.path.realpath(local), None), None)

    def external(self, uri):
        if uri.startswith(('http://', 'https://', 'mailto:')):
            try:
                Gio.AppInfo.launch_default_for_uri(uri, None)
            except GLib.Error:
                pass

    def failed(self, view, _event, uri, _error):
        if ours(uri):
            view.load_html(self.message('The Agentic OS backend is not running. Start it with ./agentos (or from the applications menu), then reopen this window.'), BASE + '/')
            return True
        return False

    @staticmethod
    def message(text):
        return ('<html><body style="font:15px system-ui,sans-serif;background:#0e1319;color:#e4eaf1;display:grid;'
                'place-items:center;height:96vh"><div style="max-width:520px;text-align:center"><h2>Agentic OS</h2><p>%s</p></div></body></html>') % text


if __name__ == '__main__':
    sys.exit(AgenticOS().run(sys.argv[:1]))
