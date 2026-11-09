"""Serve the bundled editor on loopback."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

if __name__ == "__main__":
    app = Path(__file__).resolve().parent / "dist"
    if not (app / "index.html").exists():
        raise SystemExit("Build the editor first with npm ci && npm run build.")
    handler = partial(SimpleHTTPRequestHandler, directory=str(app))
    with ThreadingHTTPServer(("127.0.0.1", 8046), handler) as server:
        print("Open http://127.0.0.1:8046/ in Chrome. Ctrl+C stops the server.", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
