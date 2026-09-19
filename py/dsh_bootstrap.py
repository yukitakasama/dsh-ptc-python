"""CPython bootstrap for the DeepSeek Harness fd-3 code-runtime protocol.

This file is the CHILD side of a versionless wire protocol. The host (a Node
plugin, ``lib/python-runtime.js``) spawns it once per run as::

    python -I /path/to/dsh_bootstrap.py

and pins the fourth stdio entry (fd 3) as the framed-JSON channel, so stdout and
stderr stay free for the program's own output. Frames are JSON-lines, one object
per line::

    host -> child   boot (first), run (after boot-ack), reply (one per call)
    child -> host   boot-ack, call, log, done

The host validates every inbound frame as hostile input, because model code has
full access to fd 3 and can forge any frame. This side trusts host replies: the
host is not model-controlled.

Trust posture matches the seam's documented one -- containment, not a security
boundary. The program runs in this process with bash-equivalent trust; what this
bootstrap adds is a bounded accounting of that fact, not isolation from the host.

The program's stdin is closed by the host, and this bootstrap installs an
EOF-only ``sys.stdin`` so ``input()`` fails immediately instead of hanging to the
host's wall-clock ceiling. Programs reach the world through their tool bindings.

Concurrency has one hard rule: exactly ONE thread ever reads fd 3. A Windows
named pipe serializes concurrent read and write on the same handle -- a thread
blocked in a read prevents another thread's write from completing -- so a
design that reads replies on one thread while the run's thread writes a ``call``
deadlocks. This bootstrap therefore runs a single daemon reader thread that owns
every read, and lets both the reader and the run's thread write through one
lock-protected writer. The reader runs first, so the pre-run handshake and the
reply stream share it rather than competing for the channel.

This module is standalone on purpose: it imports only the standard library, so
it can be copied to any Python 3.8+ interpreter without the rest of the package.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import textwrap
import threading
import traceback
import types

# The protocol channel, from the child's perspective: it READS host frames on
# its stdin and WRITES child frames to its stdout. Two independent pipes, never
# one duplex handle -- a Windows pipe serializes a blocked read against a write
# on the same handle, which would deadlock a reply read against a call write.
# fd 1 is duplicated for the protocol before the program's stdout is redirected,
# so bytes the program writes below the Python level cannot corrupt the frame
# stream; they land on stderr, which the host captures as stray output.
PROTOCOL_IN_FD = 0
PROTOCOL_OUT_FD = 1

# Recursion limit used while PARSING an inbound frame. CPython's JSON scanner
# recurses one level per nesting level, so a tool result nested deeper than the
# interpreter's default limit (1000) would be unreadable. The host's inbound
# frame-size guard is what bounds a hostile payload; this only stops an honest
# deep value from failing to parse.
DEEP_PARSE_RECURSION_LIMIT = 20_000

# Source lines the program wrapper occupies before the program's own first line:
# the ``async def`` header and the blank line after it. A reported frame line is
# the program's line plus this offset.
WRAPPER_LINES = 2

# Captured before anything can patch them: these are the real process streams,
# used only for diagnostics that must never recurse back into the log frames.
_REAL_STDERR = sys.stderr


def log_truncation_marker(max_bytes: int) -> str:
    """Return the in-band marker for a log ledger that exhausted its budget.

    Byte-identical to the host's ``logTruncationMarker``, so a truncated run
    reads the same however the cap was hit.
    """

    return "[dsh-code-runtime-python] log capture truncated at {} bytes".format(max_bytes)


def json_string_bytes(text: str, max_bytes: int) -> int | None:
    """Exact UTF-8 byte length of ``text``'s compact JSON form, or None past the cap.

    Mirrors the host's non-allocating scanner, including the escaping rules the
    default encoder uses for the characters that matter here.
    """

    total = 2  # the two quotes
    if total > max_bytes:
        return None
    for char in text:
        code = ord(char)
        if char in ('"', "\\") or code in (0x08, 0x09, 0x0A, 0x0C, 0x0D):
            total += 2
        elif code < 0x20:
            total += 6
        elif code < 0x80:
            total += 1
        elif code < 0x800:
            total += 2
        elif 0xD800 <= code <= 0xDFFF:
            total += 6
        elif code < 0x10000:
            total += 3
        else:
            total += 4
        if total > max_bytes:
            return None
    return total


def truncate_json_string(text: str, max_bytes: int) -> str:
    """Longest prefix of ``text`` whose compact JSON form fits ``max_bytes``."""

    if max_bytes < 2:
        return ""
    low, high = 0, len(text)
    while low < high:
        mid = (low + high + 1) // 2
        if json_string_bytes(text[:mid], max_bytes) is not None:
            low = mid
        else:
            high = mid - 1
    return text[:low]


def encode_value(value) -> str:
    """Serialize one value as compact JSON, rejecting anything outside lossless JSON.

    Written iteratively rather than with ``json.dumps``: the seam's
    ``CodeJsonValue`` has no depth limit, and the encoder both recurses per
    nesting level and refuses to exceed ``sys.getrecursionlimit()``, so a deep
    value that fits the byte budget must still cross. Raises ``TypeError`` or
    ``ValueError`` for anything JSON cannot carry losslessly -- a non-finite
    float, a non-string key, or an unsupported object.
    """

    chunks = []
    tasks = [(False, value)]
    while tasks:
        is_text, current = tasks.pop()
        if is_text:
            chunks.append(current)
            continue
        if current is None:
            chunks.append("null")
        elif current is True:
            chunks.append("true")
        elif current is False:
            chunks.append("false")
        elif isinstance(current, str):
            chunks.append(json.dumps(current))
        elif isinstance(current, int):
            chunks.append(repr(current))
        elif isinstance(current, float):
            if current != current or current in (float("inf"), float("-inf")):
                raise ValueError("Out of range float values are not JSON compliant")
            chunks.append(repr(current))
        elif isinstance(current, (list, tuple)):
            chunks.append("[")
            tasks.append((True, "]"))
            for index in range(len(current) - 1, -1, -1):
                if index < len(current) - 1:
                    tasks.append((True, ","))
                tasks.append((False, current[index]))
        elif isinstance(current, dict):
            chunks.append("{")
            tasks.append((True, "}"))
            keys = list(current.keys())
            for index in range(len(keys) - 1, -1, -1):
                key = keys[index]
                if not isinstance(key, str):
                    raise TypeError("keys must be str, not {}".format(type(key).__name__))
                if index < len(keys) - 1:
                    tasks.append((True, ","))
                tasks.append((False, current[key]))
                tasks.append((True, json.dumps(key) + ":"))
        else:
            raise TypeError("Object of type {} is not JSON serializable".format(type(current).__name__))
    return "".join(chunks)


def parse_json(text: str):
    """Parse JSON text, including text nested deeper than CPython's default.

    ``json.loads`` recurses one level per nesting level and its scanner honours
    the interpreter's recursion limit, so an honest deep payload would otherwise
    be unreadable. The limit is raised around the parse only -- the seam leaves
    value depth unbounded -- and the host's matching frame guard bounds a
    hostile one. ``parse_int=int`` keeps an integer exact rather than routing it
    through a float, which is what lets a large counter or id cross unchanged.
    """

    previous = sys.getrecursionlimit()
    raised = previous < DEEP_PARSE_RECURSION_LIMIT
    if raised:
        sys.setrecursionlimit(DEEP_PARSE_RECURSION_LIMIT)
    try:
        return json.loads(text, parse_int=int)
    finally:
        if raised:
            sys.setrecursionlimit(previous)


# Byte-level sentinel: the frame parsed as JSON but nests deeper than this
# interpreter can read, which the reader must report instead of stalling.
_FRAME_TOO_DEEP = object()


class ProtocolChannel:
    """The framed-JSON channel: JSON-lines in on stdin, JSON-lines out on stdout.

    The two directions are separate pipes, never one duplex handle: a Windows
    pipe serializes a blocked read against a write on the same handle, so a
    reply reader and a call writer sharing one handle deadlock. Reads go through
    :meth:`read_frame` on the single reader thread only; writes go through
    :meth:`send` from any thread under one lock. The raw ``os`` calls are
    deliberate: a Python file object would add a second, independent lock around
    the same descriptor.
    """

    def __init__(self, read_fd: int = PROTOCOL_IN_FD, write_fd: int = PROTOCOL_OUT_FD) -> None:
        self._read_fd = os.dup(read_fd)
        self._write_fd = os.dup(write_fd)
        self._write_lock = threading.Lock()
        self._closed = False
        self._buffer = b""

    def send(self, frame: dict) -> None:
        """Write one frame, flushing immediately so output survives termination."""

        with self._write_lock:
            if self._closed:
                return
            try:
                os.write(self._write_fd, (encode_value(frame) + "\n").encode("utf-8"))
            except OSError:
                self._closed = True

    def read_frame(self):
        """Block until one complete frame arrives, or None at end of stream.

        Only the dedicated reader thread may call this; keeping every read on one
        thread is what makes the channel usable on a Windows pipe. Returns
        ``_FRAME_TOO_DEEP`` for a frame this interpreter cannot parse, which the
        caller must turn into a run failure rather than a silent stall.
        """

        while True:
            index = self._buffer.find(b"\n")
            if index >= 0:
                line, self._buffer = self._buffer[:index], self._buffer[index + 1 :]
                text = line.decode("utf-8", "replace").strip()
                if text == "":
                    continue
                try:
                    return parse_json(text)
                except RecursionError:
                    return _FRAME_TOO_DEEP
                except ValueError:
                    # Junk on the wire is dropped rather than fatal, matching the
                    # host's own hostile-frame stance in the other direction.
                    continue
            try:
                chunk = os.read(self._read_fd, 65_536)
            except OSError:
                return None
            if not chunk:
                return None
            self._buffer += chunk

    def interrupt(self) -> None:
        """Close the descriptor so a blocked read returns at once."""

        if self._closed:
            return
        self._closed = True
        for fd in (self._read_fd, self._write_fd):
            try:
                os.close(fd)
            except OSError:
                pass


class LogSink:
    """Ordered text capture under the shared outer JSON-byte budget.

    The budget includes the log array's syntax and string escaping, matching the
    host's own ledger so both sides account for the same bytes. Once exhausted it
    emits the fitting prefix, reports the limit once with the in-band truncation
    marker, and drops everything after.
    """

    def __init__(self, channel: ProtocolChannel, max_bytes: int) -> None:
        self._channel = channel
        self._max_bytes = max_bytes
        self._bytes = 2  # JSON serialization of the empty logs array: []
        self._entries = 0
        self._truncated = False

    @property
    def truncated(self) -> bool:
        """Whether the budget has been exhausted."""

        return self._truncated

    def push(self, text: str) -> None:
        """Emit text to the host, charging it against the budget."""

        if self._truncated:
            return
        separator_bytes = 1 if self._entries > 0 else 0
        available = self._max_bytes - self._bytes - separator_bytes
        encoded = json_string_bytes(text, available)
        if encoded is None:
            self._truncated = True
            prefix = truncate_json_string(text, available)
            if prefix:
                prefix_bytes = json_string_bytes(prefix, available)
                if prefix_bytes is not None:
                    self._bytes += prefix_bytes + separator_bytes
                    self._entries += 1
                    self._channel.send({"type": "log", "text": prefix})
            self._channel.send(
                {"type": "log", "text": log_truncation_marker(self._max_bytes), "truncated": True}
            )
            return
        self._bytes += encoded + separator_bytes
        self._entries += 1
        self._channel.send({"type": "log", "text": text})


class StreamProxy:
    """A ``sys.stdout``/``sys.stderr`` replacement that emits ordered log frames.

    Writes are buffered up to and including a newline and emitted one complete
    line at a time, because Python's ``print`` writes each argument separately
    (``print("a", 1)`` is three writes: ``"a"``, ``" "``, ``"1"``) and the ledger
    is more useful to the model as one entry per printed line. A trailing
    fragment with no newline is emitted by :meth:`flush` when the program
    settles.
    """

    def __init__(self, sink: LogSink, fallback, name: str) -> None:
        self._sink = sink
        self._fallback = fallback
        self._name = name
        self._buffer = ""

    def write(self, text) -> int:
        """Buffer ``text`` and emit whole lines; returns characters consumed."""

        if not isinstance(text, str):
            text = str(text)
        if text:
            self._buffer += text
            while True:
                index = self._buffer.find("\n")
                if index < 0:
                    break
                line, self._buffer = self._buffer[: index + 1], self._buffer[index + 1 :]
                self._sink.push(line)
        return len(text)

    def flush(self) -> None:
        """Emit any unterminated fragment as its own entry."""

        if self._buffer:
            fragment, self._buffer = self._buffer, ""
            self._sink.push(fragment)

    def isatty(self) -> bool:
        """Always false: captured output is not a terminal."""

        return False

    def writable(self) -> bool:
        """Always true."""

        return True

    def readable(self) -> bool:
        """Always false."""

        return False

    def seekable(self) -> bool:
        """Always false."""

        return False

    def fileno(self) -> int:
        """Expose the real descriptor, bypassing the ledger.

        Bytes written straight to the descriptor land on the pipe and the host
        appends them after the framed logs.
        """

        return self._fallback.fileno()

    @property
    def encoding(self) -> str:
        """The encoding used on the wire."""

        return "utf-8"

    @property
    def errors(self) -> str:
        """The error policy used on the wire."""

        return "replace"

    @property
    def buffer(self):
        """Expose the real binary buffer for byte-level writes."""

        return self._fallback.buffer

    def __repr__(self) -> str:
        return "<dsh {} proxy>".format(self._name)


class EofStdin:
    """An immediate-EOF ``sys.stdin``.

    The host closes the program's stdin, so an unbounded read (``input()``,
    ``sys.stdin.read()``) would otherwise block until the wall-clock ceiling.
    Reporting EOF at once turns that into an ordinary ``EOFError`` the program can
    handle, and tool bindings remain the way to reach the world.
    """

    @property
    def encoding(self) -> str:
        """The encoding reported to callers."""

        return "utf-8"

    def read(self, size: int = -1) -> str:
        """Return empty input."""

        return ""

    def readline(self, size: int = -1) -> str:
        """Return empty input."""

        return ""

    def readlines(self, hint: int = -1) -> list:
        """Return no lines."""

        return []

    def isatty(self) -> bool:
        """Always false."""

        return False

    def readable(self) -> bool:
        """Always true."""

        return True

    def writable(self) -> bool:
        """Always false."""

        return False

    def __iter__(self):
        return iter(())


def make_error_class(name: str, member_property: str):
    """Materialize the real exception class one namespace declares.

    Rejected calls raise instances of this class carrying the failed member name
    on ``member_property``, so a program can branch on which tool failed.
    """

    return type(name, (Exception,), {}), member_property


def make_namespaces(namespaces: list, error_classes: dict, call_binding) -> dict:
    """Build the namespace objects the program sees.

    Each declared name becomes an async callable that bridges to the host, so
    ``await tools.name(args)`` is an ordinary call from inside the program.
    """

    objects = {}
    for namespace in namespaces:
        global_name = namespace["global"]
        error_class, member_property = error_classes.get(global_name, (None, None))
        attributes = {
            function_name: _make_binding(
                global_name, function_name, error_class, member_property, call_binding
            )
            for function_name in namespace["names"]
        }
        objects[global_name] = types.SimpleNamespace(**attributes)
    return objects


def _make_binding(global_name, function_name, error_class, member_property, call_binding):
    """Create one program-callable binding function."""

    async def binding(args=None):
        return await call_binding(global_name, function_name, args, error_class, member_property)

    binding.__name__ = function_name
    binding.__qualname__ = "{}.{}".format(global_name, function_name)
    return binding


async def run_program(program: str, globals_map: dict):
    """Execute ``program`` as the body of an async function.

    Top-level ``await`` and ``return`` work, matching the seam's contract.

    The wrapper is the ``async def`` header plus one blank line, with the program
    re-indented one level under it. The blank line is what lets every program
    line keep its own number AND lets an opening comment or blank line belong to
    the body; the two wrapper lines are {@link WRAPPER_LINES} and every reported
    line subtracts them.
    """

    source = "async def __dsh_main__():\n\n" + textwrap.indent(program, " " * 4)
    code = compile(source, "<run_code>", "exec")
    namespace = dict(globals_map)
    namespace["__name__"] = "__dsh_main__"
    exec(code, namespace)
    return await namespace["__dsh_main__"]()


def format_traceback(error: BaseException) -> str:
    """Render one program failure as the message the model reads.

    A Python traceback frames each entry as two source lines. The program's
    lines are rewritten to name ``<run_code>`` and to report the model's own
    line numbers; the bootstrap's own frames are dropped entirely, because the
    wrapper's lines shift their numbers off the program's numbering and a
    misleading number is worse than no frame at all.
    """

    if isinstance(error, SyntaxError):
        reported = error.lineno - WRAPPER_LINES if error.lineno else None
        location = "line {}".format(reported) if reported else "unknown line"
        return "SyntaxError: {} ({})".format(error.msg, location)
    lines = traceback.format_exception(type(error), error, error.__traceback__)
    filtered = []
    index = 0
    while index < len(lines):
        chunk = lines[index]
        if 'File "<run_code>"' in chunk and index + 1 < len(lines):
            filtered.append(_program_frame(chunk, lines[index + 1]))
            index += 2
            continue
        if 'File "' in chunk:
            # A bootstrap frame: its "source" line is the next chunk, so skip both.
            index += 2
            continue
        filtered.append(chunk)
        index += 1
    rendered = "".join(filtered).strip()
    return rendered if rendered else "{}: {}".format(type(error).__name__, error)


def _program_frame(location_line: str, source_line: str) -> str:
    """Rewrite one program frame to ``<run_code>`` with the model's line number."""

    match = re.search(r"line (\d+)", location_line)
    if match is None:
        return location_line
    reported = max(int(match.group(1)) - WRAPPER_LINES, 1)
    rewritten = re.sub(
        r'File "[^"]*", line \d+', 'File "<run_code>", line {}'.format(reported), location_line, count=1
    )
    return rewritten + source_line


def apply_posix_limits(cpu_seconds: int, address_space_bytes: int) -> None:
    """Arm the child's own POSIX resource limits before model code runs.

    Absent the ``resource`` module (Windows) the host's wall-clock ceiling is the
    only bound, which is a documented platform limitation rather than a silent
    degradation.
    """

    try:
        import resource  # noqa: PLC0415 -- POSIX-only, deliberately optional
    except ImportError:
        return
    limits = (
        (resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 5)),
        (resource.RLIMIT_AS, (address_space_bytes, address_space_bytes)),
    )
    for limit, value in limits:
        try:
            resource.setrlimit(limit, value)
        except (ValueError, OSError):
            # A host that forbids raising the soft limit, or a limit the kernel
            # rejects, leaves that budget to the host's own timers.
            pass


class Session:
    """One run's bootstrap state: the channel, the ledger, and the call bridge."""

    def __init__(self, channel: ProtocolChannel, boot: dict, loop) -> None:
        self.chan = channel
        self._boot = boot
        self._loop = loop
        self._pending: dict = {}
        self._next_id = 1
        self._done_sent = False
        self._reader_thread = None
        self._reader_error = RuntimeError("python bootstrap lost the host channel")
        self._log_sink = LogSink(channel, int(boot.get("maxLogBytes", 1_048_576)))
        self._stream_proxies: list = []

    def install_streams(self) -> None:
        """Route the program's stdout/stderr into the log ledger."""

        stdout_proxy = StreamProxy(self._log_sink, sys.stdout, "stdout")
        stderr_proxy = StreamProxy(self._log_sink, sys.stderr, "stderr")
        self._stream_proxies = [stdout_proxy, stderr_proxy]
        sys.stdout = stdout_proxy  # type: ignore[assignment]
        sys.stderr = stderr_proxy  # type: ignore[assignment]
        sys.stdin = EofStdin()  # type: ignore[assignment]

    def flush_streams(self) -> None:
        """Emit any unterminated output fragment before the run settles."""

        for proxy in self._stream_proxies:
            proxy.flush()

    def start_reader(self) -> None:
        """Start the one thread that ever reads the channel."""

        self._reader_thread = threading.Thread(
            target=self._read_frames, name="dsh-protocol-reader", daemon=True
        )
        self._reader_thread.start()

    def _read_frames(self) -> None:
        """Own every channel read and hand each frame to the event loop.

        A frame this interpreter cannot parse fails the bindings waiting on it
        and stops reading, so the program sees an error instead of waiting
        forever for a reply that will never arrive.
        """

        while True:
            try:
                frame = self.chan.read_frame()
            except BaseException:  # noqa: BLE001 -- a reader fault must not stall the run
                self._loop.call_soon_threadsafe(self._fail_pending)
                return
            if frame is _FRAME_TOO_DEEP:
                self._loop.call_soon_threadsafe(self._fail_too_deep)
                return
            self._loop.call_soon_threadsafe(self._on_frame, frame)
            if frame is None:
                return

    def _fail_too_deep(self) -> None:
        """Fail every pending call, naming the frame that could not be parsed."""

        error = RuntimeError("a host frame nests deeper than this Python interpreter can parse")
        for future in self._pending.values():
            if not future.done():
                future.set_exception(error)
        self._pending.clear()

    def _on_frame(self, frame) -> None:
        """Resolve a pending binding call on the event-loop thread."""

        if frame is None:
            self._fail_pending()
            return
        if frame.get("type") != "reply":
            return
        future = self._pending.pop(frame.get("id"), None)
        if future is not None and not future.done():
            future.set_result(frame)

    def _fail_pending(self) -> None:
        """Fail every binding call still waiting for a reply."""

        for future in self._pending.values():
            if not future.done():
                future.set_exception(self._reader_error)
        self._pending.clear()

    def stop_reader(self) -> None:
        """Stop the read loop and release its blocked read.

        The reader is a daemon, so a peer that never sends another frame cannot
        hold interpreter shutdown open; interrupting the channel makes the
        blocked read return immediately.
        """

        self.chan.interrupt()
        if self._reader_thread is not None:
            self._reader_thread.join(timeout=2.0)
            self._reader_thread = None

    async def call_binding(self, global_name, function_name, args, error_class, member_property):
        """Bridge one program call to the host and await its reply."""

        try:
            encode_value(args)
        except (TypeError, ValueError):
            raise _binding_failure(
                error_class, member_property, function_name, "binding arguments must be lossless JSON"
            )
        call_id = self._next_id
        self._next_id += 1
        future = self._loop.create_future()
        self._pending[call_id] = future
        self.chan.send(
            {
                "type": "call",
                "id": call_id,
                "global": global_name,
                "name": function_name,
                "args": args,
            }
        )
        reply = await future
        if reply.get("ok") is True:
            return reply.get("value")
        raise _binding_failure(
            error_class, member_property, function_name, str(reply.get("message", "binding call failed"))
        )

    def send_done(self, **payload) -> None:
        """Post the single terminal frame for this run."""

        if self._done_sent:
            return
        self._done_sent = True
        self.chan.send(dict({"type": "done"}, **payload))

    async def execute(self, program: str) -> None:
        """Run one program and post its terminal frame."""

        namespaces = self._boot.get("namespaces", [])
        error_classes = {}
        for namespace in namespaces:
            descriptor = namespace.get("errorClass")
            if descriptor:
                error_classes[namespace["global"]] = make_error_class(
                    descriptor["name"], descriptor["memberNameProperty"]
                )
        globals_map = make_namespaces(namespaces, error_classes, self.call_binding)
        for error_class, _member in error_classes.values():
            globals_map[error_class.__name__] = error_class

        try:
            value = await run_program(program, globals_map)
        except asyncio.CancelledError:
            self.flush_streams()
            self.send_done(error={"kind": "exception", "message": "program cancelled"})
            raise
        except BaseException as error:  # noqa: BLE001 -- every program failure is a result field
            self.flush_streams()
            self.send_done(error={"kind": "exception", "message": format_traceback(error)})
            return

        # Output written without a trailing newline is still the program's output.
        self.flush_streams()
        if value is None:
            self.send_done()
            return
        try:
            encoded = encode_value(value)
        except (TypeError, ValueError):
            self.send_done(
                error={"kind": "invalid-output", "message": "program completion must be lossless JSON"}
            )
            return
        max_value_bytes = int(self._boot.get("maxValueBytes", 4_194_304))
        if len(encoded.encode("utf-8")) > max_value_bytes:
            self.send_done(
                error={
                    "kind": "output-limit",
                    "message": "program completion exceeded {} bytes".format(max_value_bytes),
                }
            )
            return
        # Round-tripping through the decoder keeps the frame's value exactly what
        # the host will parse, so the byte metering above measured the real payload.
        self.send_done(value=parse_json(encoded))


def _binding_failure(error_class, member_property, member_name, message):
    """Create the program-visible rejection for one failed binding call."""

    if error_class is None:
        return RuntimeError(message)
    error = error_class(message)
    setattr(error, member_property, member_name)
    return error


async def main() -> int:
    """Boot, read the program, run it, and settle. Returns the process exit code."""

    channel = ProtocolChannel()
    session = None
    loop = asyncio.get_running_loop()
    try:
        # The handshake reads on THIS thread, before the reply reader exists, so
        # exactly one reader is ever active. Reads and writes travel on separate
        # pipes, so neither direction can block the other.
        boot = channel.read_frame()
        if boot is None or boot.get("type") != "boot":
            _REAL_STDERR.write("dsh_bootstrap: expected a boot frame on stdin\n")
            _REAL_STDERR.flush()
            return 2
        apply_posix_limits(
            int(boot.get("cpuSeconds", 60)), int(boot.get("addressSpaceBytes", 2_147_483_648))
        )
        session = Session(channel, boot, loop)
        # The protocol owns fd 1 from here on: point the program's stdout at
        # stderr so bytes written below the Python level cannot corrupt the
        # frame stream, and the host still captures them as stray output.
        os.dup2(2, 1)
        session.install_streams()
        channel.send({"type": "boot-ack"})

        run_frame = channel.read_frame()
        if run_frame is None:
            session.send_done(
                error={"kind": "exception", "message": "host closed the channel before sending a program"}
            )
            return 0
        session.start_reader()
        await session.execute(str(run_frame.get("program", "")))
        return 0
    finally:
        if session is not None:
            session.stop_reader()
        channel.interrupt()


def cli() -> int:
    """Run the bootstrap as ``__main__``."""

    try:
        return asyncio.run(main())
    except KeyboardInterrupt:
        # The host aborted the run and terminated this process; nothing is left
        # to report on a channel the host has already stopped reading.
        return 130
    except BaseException as error:  # noqa: BLE001 -- a bootstrap failure must be diagnosable
        _REAL_STDERR.write("dsh_bootstrap: {}: {}\n".format(type(error).__name__, error))
        _REAL_STDERR.flush()
        return 1


if __name__ == "__main__":
    sys.exit(cli())
