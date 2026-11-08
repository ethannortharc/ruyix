#!/usr/bin/env python3
# A pseudo-terminal for one program, for the App Center's terminal (lib/term.js): `termpty.py <cols> <rows> -- <argv…>`
# (not pty.py: a script by that name would shadow the standard module; run with -I all the same)
# runs argv on a terminal of its own and relays — fd 0 → the terminal (the keys), the terminal → fd 1 (what it shows);
# fd 3 takes the window's size, one "<cols> <rows>" line per change. The program ending ends this, with its exit
# status; fd 0 closing (the page went away) hangs the terminal up (SIGHUP), as closing a terminal window does.
# Python's pty and select, not a native Node module: the box has python3, and nothing here needs a compiler.
import errno, fcntl, os, select, signal, struct, sys, termios

MAX_KEYS = 1 << 20  # keys the program has not taken: past this, fd 0 waits (the page is held back, not this memory)

def set_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', max(1, min(rows, 1000)), max(1, min(cols, 1000)), 0, 0))

def write_all(fd, data):
    while data:
        try:
            data = data[os.write(fd, data):]
        except InterruptedError:
            pass

def main():
    args = sys.argv[1:]
    if len(args) < 4 or args[2] != '--':
        sys.stderr.write('usage: termpty.py <cols> <rows> -- <program> [args…]\n')
        return 2
    cols, rows, argv = int(args[0]), int(args[1]), args[3:]
    # the size first, on the terminal itself, before the program starts (a full-screen program reads it once at its
    # start) — set here, not in the child: a resize already waiting on fd 3 is then never undone by the start's size
    fd, slave = os.openpty()
    set_size(fd, cols, rows)
    pid = os.fork()
    if pid == 0:
        # the program's side: a session of its own with this terminal as its controlling terminal, as pty.fork does
        os.close(fd)
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        for n in (0, 1, 2):
            os.dup2(slave, n)
        os.close(slave)
        try:
            os.close(3)  # (the size messages are this helper's; a daemon the program starts must not keep them open)
        except OSError:
            pass
        try:
            os.execvp(argv[0], argv)
        except OSError as err:
            os.write(2, f'{argv[0]}: {err.strerror}\r\n'.encode())
        os._exit(127)
    os.close(slave)

    os.set_blocking(fd, False)
    keys = b''  # keys the program has not taken yet (a busy program reads slowly: never block on it)
    ctl = b''
    readers = [0, fd, 3]
    status = None
    while True:
        try:
            r, w, _ = select.select([x for x in readers if x != 0 or len(keys) < MAX_KEYS], [fd] if keys else [], [], 1.0)
        except InterruptedError:
            continue
        if fd in r:
            try:
                out = os.read(fd, 65536)
            except BlockingIOError:
                out = None
            except OSError as err:
                if err.errno != errno.EIO:
                    raise
                out = b''  # EIO: no one holds the terminal's other side any more
            if out == b'':
                break
            if out:
                write_all(1, out)  # (blocks while the page is behind: the program then waits for it)
        if fd in w and keys:
            try:
                keys = keys[os.write(fd, keys):]
            except BlockingIOError:
                pass
        if 0 in r:
            data = os.read(0, 65536)
            if data:
                keys += data
            else:
                readers.remove(0)
                try:
                    os.killpg(pid, signal.SIGHUP)  # (the program leads its own session: its group is its pid)
                except ProcessLookupError:
                    pass
        if 3 in r:
            data = os.read(3, 4096)
            if not data:
                readers.remove(3)
            ctl += data
            *lines, ctl = ctl.split(b'\n')
            for line in lines:
                try:
                    c, h = (int(v) for v in line.split())
                    set_size(fd, c, h)  # (the kernel tells the program: SIGWINCH)
                except ValueError:
                    pass
        # the program gone while something it started still holds the terminal: this ends all the same
        if status is None:
            done, st = os.waitpid(pid, os.WNOHANG)
            if done:
                status = st
                readers = [x for x in readers if x != 0]
                # what it wrote last, then out
                try:
                    while True:
                        out = os.read(fd, 65536)
                        if not out:
                            break
                        write_all(1, out)
                except OSError:
                    pass
                break
    if status is None:
        _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status)

if __name__ == '__main__':
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    sys.exit(main())
