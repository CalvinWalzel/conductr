# Prints, as JSON, every process under the named roots (Herdr and herdr-core) with its CPU time
# and memory footprint, so conductr-resources can show what Herdr and its terminals use.
# CPU time comes from proc_pid_rusage (mach ticks, turned into ns); memory is phys_footprint,
# the number Activity Monitor shows.
import ctypes, json, os, subprocess, sys, time

libc = ctypes.CDLL("/usr/lib/libSystem.dylib")


class Timebase(ctypes.Structure):
    _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]


timebase = Timebase()
libc.mach_timebase_info(ctypes.byref(timebase))
info = (ctypes.c_uint64 * 64)()
roots = set(sys.argv[1:])
me = os.getpid()


def table(columns):
    out = subprocess.run(["ps", "-axo", columns], capture_output=True, text=True).stdout
    rows = {}
    for line in out.splitlines():
        parts = line.strip().split(None, 2 if columns.count(",") == 2 else 1)
        if len(parts) >= 2:
            rows[parts[0]] = parts[1:]
    return rows


commands = table("pid=,ppid=,comm=")
arguments = table("pid=,args=")

INTERPRETERS = {"node", "python", "python3", "Python", "ruby", "bun", "deno"}


def argv(pid):
    # The real argument list (KERN_PROCARGS2): ps joins it with spaces, which paths contain too.
    size = ctypes.c_size_t(1 << 16)
    buffer = ctypes.create_string_buffer(size.value)
    mib = (ctypes.c_int * 3)(1, 49, pid)
    if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) != 0:
        return []
    raw = buffer.raw[: size.value]
    count = int.from_bytes(raw[:4], "little")
    parts = [part for part in raw[4:].split(b"\0") if part][1 : count + 1]
    return [part.decode(errors="replace") for part in parts]


def name(pid, command):
    # An absolute path is an executable; anything else is a title the process set (puma, sidekiq).
    base = command.rsplit("/", 1)[-1] if command.startswith("/") else command
    if base in INTERPRETERS:
        for token in argv(pid)[1:]:
            if token.startswith("-"):
                if token == "-c":
                    break
                continue
            return token.rsplit("/", 1)[-1]
    return base


children = {}
for pid, (ppid, *rest) in commands.items():
    children.setdefault(ppid, []).append(pid)

counted = []
seen = set()
stack = [pid for pid, (_ppid, *rest) in commands.items() if rest and rest[0].rsplit("/", 1)[-1] in roots]
while stack:
    pid = stack.pop()
    if pid in seen or int(pid) == me:
        continue
    seen.add(pid)
    counted.append(pid)
    stack.extend(children.get(pid, []))

processes = []
for pid in counted:
    if libc.proc_pid_rusage(int(pid), 6, info) != 0:
        continue
    ppid, command = commands[pid][0], commands[pid][1] if len(commands[pid]) > 1 else "?"
    args = arguments.get(pid, [""])[0]
    cpu = (info[2] + info[3]) * timebase.numer // timebase.denom
    processes.append([int(pid), int(ppid), name(int(pid), command), args[:400], cpu, info[9]])

print(json.dumps({"now": time.time_ns(), "processes": processes}))
