# Ruyix: an app display's windows — their list, and one brought to the front (the desk's open things: each folder a
# file manager has open is a row; a click shows that one). Talks to the X server straight through libX11 (ctypes): the
# box has no wmctrl or xdotool, and matchbox — the window manager on each app's display — honours _NET_ACTIVE_WINDOW.
#
#   python3 -I xwin.py list            → [{"id": <window>, "name": "<its title>"}] as JSON, on the display in $DISPLAY
#   python3 -I xwin.py activate <id>   → that window in front (exit 1: no such window)
import ctypes
import ctypes.util
import json
import sys

x = ctypes.cdll.LoadLibrary(ctypes.util.find_library('X11') or 'libX11.so.6')
x.XOpenDisplay.restype = ctypes.c_void_p
x.XOpenDisplay.argtypes = [ctypes.c_char_p]
x.XDefaultRootWindow.restype = ctypes.c_ulong
x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x.XInternAtom.restype = ctypes.c_ulong
x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
x.XGetWindowProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_long, ctypes.c_long, ctypes.c_int, ctypes.c_ulong,
                                 ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong),
                                 ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_void_p)]
x.XFree.argtypes = [ctypes.c_void_p]
x.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.c_void_p]
x.XRaiseWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x.XFlush.argtypes = [ctypes.c_void_p]
x.XCloseDisplay.argtypes = [ctypes.c_void_p]


class ClientMessage(ctypes.Structure):
    _fields_ = [('type', ctypes.c_int), ('serial', ctypes.c_ulong), ('send_event', ctypes.c_int), ('display', ctypes.c_void_p),
                ('window', ctypes.c_ulong), ('message_type', ctypes.c_ulong), ('format', ctypes.c_int), ('l', ctypes.c_long * 5)]


class Event(ctypes.Union):
    _fields_ = [('xclient', ClientMessage), ('pad', ctypes.c_long * 24)]


def prop(d, w, name):
    """A window's property: (its format, its bytes) — none when it has none."""
    typ, fmt, n, after, data = ctypes.c_ulong(), ctypes.c_int(), ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_void_p()
    if x.XGetWindowProperty(d, w, x.XInternAtom(d, name, 0), 0, 1 << 16, 0, 0, ctypes.byref(typ), ctypes.byref(fmt),
                            ctypes.byref(n), ctypes.byref(after), ctypes.byref(data)) != 0 or not data.value:
        return None
    # (format 32 comes as C longs, whatever their size)
    size = n.value * (ctypes.sizeof(ctypes.c_long) if fmt.value == 32 else fmt.value // 8)
    out = (fmt.value, ctypes.string_at(data.value, size))
    x.XFree(data)
    return out


def windows(d, root):
    p = prop(d, root, b'_NET_CLIENT_LIST')
    if not p:
        return []
    ids = (ctypes.c_long * (len(p[1]) // ctypes.sizeof(ctypes.c_long))).from_buffer_copy(p[1])
    out = []
    for w in ids:
        w &= 0xFFFFFFFF
        name = prop(d, w, b'_NET_WM_NAME') or prop(d, w, b'WM_NAME')
        out.append({'id': w, 'name': name[1].decode('utf-8', 'replace') if name else ''})
    return out


def main(argv):
    d = x.XOpenDisplay(None)
    if not d:
        print('no display', file=sys.stderr)
        return 2
    root = x.XDefaultRootWindow(d)
    try:
        if argv[:1] == ['list']:
            print(json.dumps(windows(d, root), ensure_ascii=False))
            return 0
        if argv[:1] == ['activate'] and len(argv) == 2 and argv[1].isdigit():
            w = int(argv[1])
            if w not in [it['id'] for it in windows(d, root)]:
                return 1
            e = Event()
            e.xclient.type, e.xclient.send_event, e.xclient.window, e.xclient.format = 33, 1, w, 32  # (33: ClientMessage)
            e.xclient.message_type = x.XInternAtom(d, b'_NET_ACTIVE_WINDOW', 0)
            e.xclient.l[0] = 2  # (from a pager: the person's own asking)
            # (SubstructureRedirectMask | SubstructureNotifyMask: what a window manager listens for on the root)
            x.XSendEvent(d, root, 0, (1 << 20) | (1 << 19), ctypes.byref(e))
            x.XRaiseWindow(d, w)
            x.XFlush(d)
            return 0
        print('use: xwin.py list | activate <window id>', file=sys.stderr)
        return 2
    finally:
        x.XCloseDisplay(d)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
