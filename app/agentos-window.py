#!/usr/bin/env python3
"""Agentic OS desktop window: a native GTK window around the local Agentic OS backend.

The backend listens only on 127.0.0.1 and answers only requests carrying the app token
(data/app-token, readable only by you). This window presents that token once, gets a
session cookie, and keeps every page inside its own windows. Links to other sites open
in your default browser instead.

The main window has no system title bar: the page draws its own (drag, double-click to
maximize, window buttons) and talks to this process through the `agentos` message
handler. This process also remembers the window's size and position, sends desktop
notifications, and keeps the browser's own right-click menu out of the way.
"""
import json
import os
import subprocess
import sys
import urllib.request

import gi

gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.0')
from gi.repository import Gdk, Gio, GLib, Gtk, WebKit2  # noqa: E402

try:  # the tray icon (StatusNotifier on KDE, AppIndicator elsewhere); optional
    gi.require_version('AppIndicator3', '0.1')
    from gi.repository import AppIndicator3  # noqa: E402
except (ValueError, ImportError):
    AppIndicator3 = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get('WORKPLACE_PORT', '4747'))
BASE = 'http://127.0.0.1:%d' % PORT
ICON = os.path.join(ROOT, 'app', 'icon.png')
STORE = os.path.expanduser('~/.agentos/window-%d' % PORT)
PREFS = os.path.join(STORE, 'prefs.json')
GEOMETRY = os.path.join(STORE, 'geometry.json')
AUTOSTART = os.path.expanduser('~/.config/autostart/agentos.desktop')
BACKGROUND = '--background' in sys.argv

# Right-click items kept in text fields and selections; everything else is the page's own menu.
TEXT_ACTIONS = {getattr(WebKit2.ContextMenuAction, n) for n in (
    'COPY', 'CUT', 'PASTE', 'DELETE', 'SELECT_ALL', 'SPELLING_GUESS', 'NO_GUESSES_FOUND', 'IGNORE_SPELLING',
    'LEARN_SPELLING', 'UNICODE', 'INPUT_METHODS', 'PASTE_AS_PLAIN_TEXT') if hasattr(WebKit2.ContextMenuAction, n)}


def token():
    with open(os.path.join(ROOT, 'data', 'app-token')) as f:
        return f.read().strip()


def ours(uri):
    return uri.startswith(BASE + '/') or uri == BASE or uri.startswith('about:') or uri.startswith('data:')


def load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save(path, data):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f)
    os.replace(tmp, path)


def version():
    try:
        out = subprocess.run(['git', '-C', ROOT, 'log', '-1', '--format=%h · %cd', '--date=short'], capture_output=True, text=True, timeout=3)
        return out.stdout.strip() or 'local build'
    except Exception:
        return 'local build'


class AgenticOS(Gtk.Application):
    def __init__(self):
        super().__init__(application_id='local.agentos.AgenticOS%d' % PORT, flags=Gio.ApplicationFlags.FLAGS_NONE)
        self.context = None
        self.main = None
        self.main_view = None
        self.last_press = None
        self.prefs = {}
        self.geometry_timer = None
        self.tray = None
        self.tray_status = None

    def do_startup(self):
        Gtk.Application.do_startup(self)
        GLib.set_prgname('AgenticOS')
        GLib.set_application_name('Agentic OS')
        os.makedirs(STORE, mode=0o700, exist_ok=True)
        self.prefs = load(PREFS, {})
        manager = WebKit2.WebsiteDataManager(base_data_directory=STORE, base_cache_directory=os.path.join(STORE, 'cache'))
        self.context = WebKit2.WebContext.new_with_website_data_manager(manager)
        self.context.get_cookie_manager().set_persistent_storage(os.path.join(STORE, 'cookies.sqlite'), WebKit2.CookiePersistentStorage.SQLITE)
        self.context.set_cache_model(WebKit2.CacheModel.DOCUMENT_VIEWER)
        self.context.set_spell_checking_enabled(True)
        open_job = Gio.SimpleAction.new('open-job', GLib.VariantType.new('s'))
        open_job.connect('activate', lambda _a, p: self.open_job(p.get_string()))
        self.add_action(open_job)
        for name, accel, fn in (('quit', '<Control>q', lambda *_: self.main and self.main.close()),
                                ('fullscreen', 'F11', lambda *_: self.toggle_fullscreen())):
            act = Gio.SimpleAction.new(name, None)
            act.connect('activate', fn)
            self.add_action(act)
            self.set_accels_for_action('app.' + name, [accel])

    def do_activate(self):
        if self.main:
            self.show_window()
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
        self.setup_tray()
        if BACKGROUND and self.tray:
            self.main.hide()

    # ------------------------------------------------------------------ windows

    def window(self, width, height, related=None):
        win = Gtk.ApplicationWindow(application=self, title='Agentic OS')
        if os.path.exists(ICON):
            win.set_icon_from_file(ICON)
        if related:
            view = WebKit2.WebView.new_with_related_view(related)
            win.set_default_size(width, height)
        else:
            ucm = WebKit2.UserContentManager()
            ucm.register_script_message_handler('agentos')
            ucm.connect('script-message-received::agentos', self.on_message)
            layout = Gtk.Settings.get_default().get_property('gtk-decoration-layout') or ':minimize,maximize,close'
            ucm.add_script(WebKit2.UserScript(
                'document.documentElement.dataset.native = "1"; window.osNativeInfo = %s;' % json.dumps({'layout': layout, 'version': version(), 'autostart': os.path.exists(AUTOSTART), 'tray': AppIndicator3 is not None}),
                WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserScriptInjectionTime.START, None, None))
            view = WebKit2.WebView(web_context=self.context, user_content_manager=ucm)
            # An empty title bar widget keeps the window's shadow and resize edges but hides the system title bar.
            win.set_titlebar(Gtk.Box())
            self.restore_geometry(win, width, height)
            win.connect('configure-event', lambda *_: self.queue_geometry(win))
            win.connect('window-state-event', lambda *_: (self.queue_geometry(win), self.push_state()))
            win.connect('notify::is-active', lambda *_: self.push_state())
            view.connect('button-press-event', self.remember_press)
            view.connect('context-menu', self.context_menu)
            view.connect('script-dialog', self.script_dialog)
            view.connect('load-changed', lambda v, ev: ev == WebKit2.LoadEvent.FINISHED and self.push_state())
            view.set_zoom_level(float(self.prefs.get('zoom', 1.0)))
            self.main, self.main_view = win, view
        settings = view.get_settings()
        settings.set_enable_developer_extras(False)
        settings.set_javascript_can_open_windows_automatically(True)
        settings.set_javascript_can_access_clipboard(True)
        settings.set_enable_write_console_messages_to_stdout(False)
        settings.set_enable_back_forward_navigation_gestures(False)
        settings.set_enable_smooth_scrolling(True)
        view.connect('decide-policy', self.policy)
        view.connect('create', self.popup)
        view.connect('load-failed', self.failed)
        if related:
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

    def restore_geometry(self, win, width, height):
        g = load(GEOMETRY, {})
        win.set_default_size(int(g.get('w', width)), int(g.get('h', height)))
        screen = Gdk.Screen.get_default()
        if 'x' in g and screen and 0 <= g['x'] < screen.get_width() - 80 and 0 <= g['y'] < screen.get_height() - 80:
            win.move(int(g['x']), int(g['y']))
        if g.get('max'):
            win.maximize()

    def queue_geometry(self, win):
        if self.geometry_timer:
            GLib.source_remove(self.geometry_timer)
        self.geometry_timer = GLib.timeout_add(400, self.save_geometry, win)

    def save_geometry(self, win):
        self.geometry_timer = None
        g = load(GEOMETRY, {})
        state = win.get_window().get_state() if win.get_window() else 0
        g['max'] = bool(state & Gdk.WindowState.MAXIMIZED)
        if not g['max'] and not state & Gdk.WindowState.FULLSCREEN:
            g['w'], g['h'] = win.get_size()
            g['x'], g['y'] = win.get_position()
        try:
            save(GEOMETRY, g)
        except OSError:
            pass
        return False

    def toggle_fullscreen(self):
        win = self.main
        if not win or not win.get_window():
            return
        if win.get_window().get_state() & Gdk.WindowState.FULLSCREEN:
            win.unfullscreen()
        else:
            win.fullscreen()

    # ------------------------------------------------------------------ page <-> window

    def js(self, code):
        if self.main_view:
            self.main_view.run_javascript(code, None, None, None)

    def push_state(self):
        win = self.main
        if not win or not win.get_window():
            return
        state = win.get_window().get_state()
        self.js('window.osNativeState && osNativeState(%s)' % json.dumps({
            'maximized': bool(state & Gdk.WindowState.MAXIMIZED), 'fullscreen': bool(state & Gdk.WindowState.FULLSCREEN),
            'active': win.is_active(), 'zoom': self.main_view.get_zoom_level()}))

    def remember_press(self, _view, ev):
        if ev.type == Gdk.EventType.BUTTON_PRESS and ev.button == 1:
            self.last_press = (ev.button, ev.x_root, ev.y_root, ev.time)
        return False

    def on_message(self, _ucm, result):
        try:
            msg = json.loads(result.get_js_value().to_string())
        except Exception:
            return
        cmd, win = msg.get('cmd'), self.main
        if cmd == 'drag' and self.last_press:
            button, x, y, t = self.last_press
            win.begin_move_drag(button, int(x), int(y), t)
        elif cmd == 'minimize':
            win.iconify()
        elif cmd == 'maximize':
            win.unmaximize() if win.is_maximized() else win.maximize()
        elif cmd == 'fullscreen':
            self.toggle_fullscreen()
        elif cmd == 'close':
            win.close()
        elif cmd == 'zoom':
            level = max(0.6, min(2.0, float(msg.get('level', 1.0))))
            self.main_view.set_zoom_level(level)
            self.set_pref('zoom', level)
            self.push_state()
        elif cmd == 'prefs':
            for k, v in (msg.get('prefs') or {}).items():
                self.set_pref(k, v)
        elif cmd == 'notify':
            self.desktop_notify(msg)
        elif cmd == 'about':
            self.about()
        elif cmd == 'autostart':
            self.set_autostart(bool(msg.get('on')))
        elif cmd == 'openPath':
            path = os.path.realpath(os.path.expanduser(str(msg.get('path', ''))))
            if path.startswith(os.path.expanduser('~') + os.sep) and os.path.exists(path):
                Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(path, None), None)

    # ------------------------------------------------------------------ tray icon and start at login

    def to_background(self):
        # With a tray icon the window just hides and the office keeps running; without one the window closes and the backend stays.
        if self.tray:
            self.main.hide()
            self.notify_hidden()
            return True
        self.quit()
        return False

    def notify_hidden(self):
        if self.prefs.get('trayHintShown'):
            return
        self.set_pref('trayHintShown', True)
        n = Gio.Notification.new('Agentic OS keeps working in the background')
        n.set_body('Open it again from the tray icon. Quit from the tray menu to stop everything.')
        self.send_notification('tray-hint', n)

    def setup_tray(self):
        if self.tray or AppIndicator3 is None:
            return
        ind = AppIndicator3.Indicator.new('agentos-%d' % PORT, ICON, AppIndicator3.IndicatorCategory.APPLICATION_STATUS)
        ind.set_status(AppIndicator3.IndicatorStatus.ACTIVE)
        ind.set_title('Agentic OS')
        menu = Gtk.Menu()
        self.tray_status = Gtk.MenuItem(label='Agentic OS')
        self.tray_status.set_sensitive(False)
        menu.append(self.tray_status)
        menu.append(Gtk.SeparatorMenuItem())
        for label, fn in (('Open Agentic OS', self.show_window), ('New job…', lambda *_: self.show_window(app='newjob')),
                          ('Restart when idle', lambda *_: self.restart_idle())):
            item = Gtk.MenuItem(label=label)
            item.connect('activate', lambda _i, f=fn: f())
            menu.append(item)
        menu.append(Gtk.SeparatorMenuItem())
        quit_item = Gtk.MenuItem(label='Quit Agentic OS')
        quit_item.connect('activate', lambda _i: self.main and self.main.close() if self.main.get_visible() else self.quit_from_tray())
        menu.append(quit_item)
        menu.show_all()
        ind.set_menu(menu)
        ind.set_secondary_activate_target(menu.get_children()[2])
        self.tray = ind
        self.update_tray()
        GLib.timeout_add_seconds(15, self.update_tray)

    def show_window(self, app=None):
        if not self.main:
            return
        self.main.show()
        self.main.present()
        if app:
            self.js("window.openApp && openApp(%s)" % json.dumps(app))

    def quit_from_tray(self):
        # The window is hidden: ask the same question as closing it, in front of the user.
        self.main.show()
        self.main.present()
        GLib.idle_add(lambda: self.main.close() and False)

    def restart_idle(self):
        try:
            req = urllib.request.Request(BASE + '/api/restart', method='POST', headers={'x-agentos-token': token(), 'content-type': 'application/json'}, data=b'{"when":"idle"}')
            urllib.request.urlopen(req, timeout=4).read()
        except Exception:  # noqa: BLE001
            pass

    def update_tray(self):
        if not self.tray:
            return False
        try:
            state = self.call('GET', '/api/state')
        except Exception:  # noqa: BLE001
            self.tray_status.set_label('Agentic OS · backend not running')
            return True
        work = [a for a in state.get('agents', []) if a.get('status') in ('running', 'delegating') or (a.get('resident') and a.get('current'))]
        tickets = state.get('tickets', [])
        needs = [t for t in tickets if t.get('waiting') or (t.get('plan') or {}).get('status') == 'pending' or any(c.get('status') == 'pending' for c in t.get('commands') or [])]
        parts = ['%d working' % len(work) if work else 'idle'] + (['%d need%s you' % (len(needs), '' if len(needs) != 1 else 's')] if needs else [])
        self.tray_status.set_label('Agentic OS · ' + ' · '.join(parts))
        self.tray.set_title('Agentic OS · ' + ' · '.join(parts))
        self.tray.set_status(AppIndicator3.IndicatorStatus.ATTENTION if needs else AppIndicator3.IndicatorStatus.ACTIVE)
        if needs:
            self.tray.set_attention_icon_full(ICON, 'Needs you')
        return True

    def set_autostart(self, on):
        if on:
            os.makedirs(os.path.dirname(AUTOSTART), exist_ok=True)
            with open(AUTOSTART, 'w') as f:
                f.write('[Desktop Entry]\nType=Application\nName=Agentic OS\nComment=Your permanent team of Claude agents\n'
                        'Exec=%s --background\nIcon=%s\nTerminal=false\nX-GNOME-Autostart-enabled=true\n' % (os.path.join(ROOT, 'agentos'), ICON))
        elif os.path.exists(AUTOSTART):
            os.remove(AUTOSTART)

    def set_pref(self, key, value):
        self.prefs[key] = value
        try:
            save(PREFS, self.prefs)
        except OSError:
            pass

    def desktop_notify(self, msg):
        # Only while the window is in the background; in front, the page shows its own toast.
        if self.main and self.main.is_active() and not msg.get('always'):
            return
        n = Gio.Notification.new(str(msg.get('title') or 'Agentic OS'))
        n.set_body(str(msg.get('body') or '')[:300])
        if os.path.exists(ICON):
            n.set_icon(Gio.FileIcon.new(Gio.File.new_for_path(ICON)))
        if msg.get('kind') in ('question', 'limit'):
            n.set_priority(Gio.NotificationPriority.HIGH)
        ticket = msg.get('ticket')
        if ticket:
            n.set_default_action_and_target_value('app.open-job', GLib.Variant('s', str(ticket)))
        self.send_notification(str(ticket or msg.get('kind') or 'agentos'), n)

    def open_job(self, ticket):
        if self.main:
            self.main.present()
        self.js('window.osOpenJob && osOpenJob(%s)' % json.dumps(ticket))

    def about(self):
        d = Gtk.AboutDialog(transient_for=self.main, modal=True)
        d.set_program_name('Agentic OS')
        d.set_version(version())
        d.set_comments('A permanent team of Claude agents, run like an operating system.')
        d.set_license_type(Gtk.License.CUSTOM)
        d.set_license('Personal software. Uses your Claude Code login; everything runs on this computer.')
        if os.path.exists(ICON):
            d.set_logo(Gtk.Image.new_from_file(ICON).get_pixbuf())
        d.set_website('file://' + ROOT)
        d.set_website_label('Open the install folder')
        d.connect('response', lambda dlg, _r: dlg.destroy())
        d.show()

    def script_dialog(self, _view, dialog):
        # confirm() and alert() from the page become native dialogs instead of the browser's.
        kind = dialog.get_dialog_type()
        text = dialog.get_message() or ''
        head, _, rest = text.partition('\n')
        if kind == WebKit2.ScriptDialogType.CONFIRM:
            d = Gtk.MessageDialog(transient_for=self.main, modal=True, message_type=Gtk.MessageType.QUESTION, buttons=Gtk.ButtonsType.NONE, text=head)
            if rest.strip():
                d.format_secondary_text(rest.strip())
            d.add_button('Cancel', Gtk.ResponseType.CANCEL)
            ok = d.add_button('OK', Gtk.ResponseType.OK)
            if any(w in text.lower() for w in ('delete', 'stop', 'undo', 'remove', 'reset')):
                ok.get_style_context().add_class('destructive-action')
            else:
                ok.get_style_context().add_class('suggested-action')
            d.set_default_response(Gtk.ResponseType.OK)
            dialog.confirm_set_confirmed(d.run() == Gtk.ResponseType.OK)
            d.destroy()
            return True
        if kind == WebKit2.ScriptDialogType.ALERT:
            d = Gtk.MessageDialog(transient_for=self.main, modal=True, message_type=Gtk.MessageType.INFO, buttons=Gtk.ButtonsType.OK, text=head)
            if rest.strip():
                d.format_secondary_text(rest.strip())
            d.run()
            d.destroy()
            return True
        return False

    def context_menu(self, _view, menu, _event, hit):
        if not (hit.context_is_editable() or hit.context_is_selection()):
            return True
        for item in list(menu.get_items()):
            if item.is_separator() or item.get_stock_action() not in TEXT_ACTIONS:
                menu.remove(item)
        return menu.get_n_items() == 0

    # ------------------------------------------------------------------ closing

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
        if self.geometry_timer:
            self.save_geometry(win)
        try:
            work, jobs = self.busy()
        except Exception:
            self.quit()
            return False
        if not work and not jobs:
            self.stop_backend()
            self.quit()
            return False
        choice = self.prefs.get('closeAction', 'ask')
        if choice == 'background':
            return self.to_background()
        if choice == 'stop':
            self.stop_backend()
            self.quit()
            return False
        names = ', '.join(sorted({a.get('persona') or a.get('id') for a in work})[:6])
        dialog = Gtk.MessageDialog(transient_for=win, modal=True, message_type=Gtk.MessageType.QUESTION, buttons=Gtk.ButtonsType.NONE,
                                   text='%d job%s still running' % (len(jobs) or 1, '' if (len(jobs) or 1) == 1 else 's'))
        dialog.format_secondary_text(('Working now: %s.\n\n' % names if names else '') +
                                     'Stop them and quit Agentic OS, or close the window and let them finish in the background? '
                                     'You can reopen the window any time from the applications menu.')
        remember = Gtk.CheckButton.new_with_label("Don't ask again (change it in Preferences)")
        dialog.get_message_area().pack_start(remember, False, False, 6)
        remember.show()
        dialog.add_button('Cancel', Gtk.ResponseType.CANCEL)
        dialog.add_button('Keep running in background', Gtk.ResponseType.NO)
        dialog.add_button('Stop them and quit', Gtk.ResponseType.YES)
        dialog.set_default_response(Gtk.ResponseType.NO)
        answer = dialog.run()
        keep = remember.get_active()
        dialog.destroy()
        if answer in (Gtk.ResponseType.YES, Gtk.ResponseType.NO) and keep:
            self.set_pref('closeAction', 'stop' if answer == Gtk.ResponseType.YES else 'background')
        if answer == Gtk.ResponseType.YES:
            self.stop_backend()
            self.quit()
            return False
        if answer == Gtk.ResponseType.NO:
            return self.to_background()
        return True

    def stop_backend(self):
        try:
            self.call('POST', '/api/shutdown')
        except Exception:
            pass

    # ------------------------------------------------------------------ keys, links, files

    def keys(self, view, ev):
        ctrl = ev.state & Gdk.ModifierType.CONTROL_MASK
        if ev.keyval == Gdk.KEY_F5 or (ctrl and ev.keyval in (Gdk.KEY_r, Gdk.KEY_R)):
            view.reload()
            return True
        zoom = None
        if ctrl and ev.keyval in (Gdk.KEY_plus, Gdk.KEY_equal, Gdk.KEY_KP_Add):
            zoom = min(2.0, view.get_zoom_level() + 0.1)
        elif ctrl and ev.keyval in (Gdk.KEY_minus, Gdk.KEY_KP_Subtract):
            zoom = max(0.6, view.get_zoom_level() - 0.1)
        elif ctrl and ev.keyval in (Gdk.KEY_0, Gdk.KEY_KP_0):
            zoom = 1.0
        if zoom is not None:
            view.set_zoom_level(round(zoom, 2))
            if view is self.main_view:
                self.set_pref('zoom', round(zoom, 2))
                self.push_state()
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
        if uri.startswith(('http://', 'https://', 'mailto:', 'file://')):
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
        # The main window has no system title bar, so this page brings a minimal one of its own.
        post = "window.webkit&&webkit.messageHandlers.agentos&&webkit.messageHandlers.agentos.postMessage(JSON.stringify({cmd:'%s'}))"
        return ('<html><body style="margin:0;font:15px system-ui,sans-serif;background:#0e1319;color:#e4eaf1">'
                '<div onmousedown="if(event.target===this)%s" ondblclick="%s" style="height:40px;display:flex;align-items:center;'
                'justify-content:flex-end;padding:0 8px;border-bottom:1px solid #26313e;user-select:none">'
                '<button onclick="%s" style="border:0;background:none;color:#8b97a6;font-size:18px;width:36px;height:28px;cursor:default">&#x2715;</button></div>'
                '<div style="display:grid;place-items:center;height:calc(100vh - 80px)"><div style="max-width:520px;text-align:center">'
                '<h2>Agentic OS</h2><p>%s</p></div></div></body></html>') % (post % 'drag', post % 'maximize', post % 'close', text)


if __name__ == '__main__':
    sys.exit(AgenticOS().run(sys.argv[:1]))
