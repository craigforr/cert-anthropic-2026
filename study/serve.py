#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Serve the Claude certification study app locally.

Runs a tiny standard-library HTTP server rooted at this ``study/`` directory so
the browser can ``fetch()`` the JSON data files (which it cannot do from a raw
``file://`` page), then opens the app at ``/web/``. Stdlib only — no third-party
dependencies — so ``uv run study/serve.py`` provisions and runs it directly.

Prefer a downloaded single binary instead? Any static file server works, e.g.:
    caddy file-server --root . --listen :8000     # then open /web/
    static-web-server -d . -p 8000
    miniserve . -p 8000
"""

from __future__ import annotations

import argparse
import contextlib
import functools
import http.server
import sys
import threading
import webbrowser
from pathlib import Path

__version__ = "3.2.2"

STUDY_ROOT = Path(__file__).resolve().parent


class _Handler(http.server.SimpleHTTPRequestHandler):
    """Serve the study files with caching DISABLED.

    This is a local, frequently-edited app, so `no-store` avoids the classic
    "I'm still seeing the old version" problem when CSS/JS/JSON change. Request
    logging is left at the stdlib default so you can watch requests in the
    terminal that runs the server.
    """

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="serve.py",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description="Serve the Claude certification study app on http://localhost and open it in your browser.",
        epilog=(
            "Examples:\n"
            "  # Start the app (auto-opens the browser at /web/):\n"
            "  uv run study/serve.py\n\n"
            "  # Use a specific port:\n"
            "  uv run study/serve.py --port 8123\n\n"
            "  # Start the server but do not open a browser (e.g. headless):\n"
            "  uv run study/serve.py --no-browser\n\n"
            "  # Print the version:\n"
            "  uv run study/serve.py --version\n"
        ),
    )
    parser.add_argument(
        "--port", type=int, default=None,
        help="Port to bind. Default 8000; if you don't pass --port and 8000 is "
             "unavailable, an open port is chosen automatically. An explicit "
             "--port is honored exactly (errors out if it can't be bound).",
    )
    parser.add_argument(
        "--host", default="127.0.0.1",
        help="Host/interface to bind (default: 127.0.0.1, i.e. local only).",
    )
    parser.add_argument(
        "--no-browser", action="store_true",
        help="Do not automatically open the browser.",
    )
    parser.add_argument(
        "--version", action="version", version=f"%(prog)s {__version__}",
    )
    return parser


class _Server(http.server.ThreadingHTTPServer):
    # The stdlib's listen backlog is 5, but the app's boot fires ~10 parallel
    # fetches; on macOS an overflowing backlog resets connections, which showed
    # up as an occasional "Could not load study data" (ERR_CONNECTION_RESET).
    request_queue_size = 128


def _serve(host: str, port: int, handler) -> http.server.ThreadingHTTPServer:
    # ThreadingHTTPServer sets allow_reuse_address=True, so it binds cleanly even
    # when the port is briefly in TIME_WAIT from a previous run. We bind the real
    # server directly (no throwaway probe socket, which would be more pessimistic).
    return _Server((host, port), handler)


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    handler = functools.partial(_Handler, directory=str(STUDY_ROOT))
    explicit = args.port is not None
    preferred = args.port if explicit else 8000

    try:
        httpd = _serve(args.host, preferred, handler)
    except OSError as exc:
        if explicit:
            print(f"ERROR: could not bind {args.host}:{preferred} — {exc}", file=sys.stderr)
            print("The port may be in use, or on Windows reserved by an OS excluded "
                  "range (Hyper-V/WSL). Try another port (e.g. --port 8080).", file=sys.stderr)
            print("  Windows, list reserved ranges: netsh int ipv4 show excludedportrange tcp",
                  file=sys.stderr)
            return 1
        # No --port given: 8000 wasn't available, so let the OS pick an open port.
        try:
            httpd = _serve(args.host, 0, handler)
        except OSError as exc2:
            print(f"ERROR: could not start a server on {args.host} — {exc2}", file=sys.stderr)
            return 1
        print(f"Note: port {preferred} was unavailable ({exc}); using an open port instead.")

    port = httpd.server_address[1]
    url = f"http://{args.host}:{port}/web/"
    with httpd:
        print(f"Claude certification study app serving {STUDY_ROOT}")
        print(f"  → {url}")
        print("Press Ctrl+C to stop.")
        if not args.no_browser:
            threading.Timer(0.5, lambda: webbrowser.open(url)).start()
        with contextlib.suppress(KeyboardInterrupt):
            httpd.serve_forever()
        print("\nStopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
