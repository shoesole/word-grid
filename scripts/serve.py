"""Local test server for public/ that tells browsers never to cache.

Usage: python3 scripts/serve.py [port]   (default 8000)
Then open http://localhost:8000 on the Mac, or http://<Mac's Wi-Fi IP>:8000 on a phone.
"""
import http.server, os, sys

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public"))
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
http.server.ThreadingHTTPServer(("0.0.0.0", port), NoCache).serve_forever()
