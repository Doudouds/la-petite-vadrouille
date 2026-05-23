from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class NoCacheRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, directory: str | None = None, **kwargs):
        super().__init__(*args, directory=directory, **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def send_head(self):
        if "If-Modified-Since" in self.headers:
            self.headers.replace_header("If-Modified-Since", "")
        return super().send_head()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve the GR app locally without browser caching.")
    parser.add_argument("--port", type=int, default=8010, help="Port to bind the local server to.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = Path(__file__).resolve().parent
    handler = partial(NoCacheRequestHandler, directory=str(root))
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    print(f"Serving {root} on http://127.0.0.1:{args.port} with cache disabled")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped")
    finally:
        server.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())