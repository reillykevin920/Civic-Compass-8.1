#!/usr/bin/env python3
"""
Corpa Compass — double-click to open (Mac)
Starts a local web server and opens your browser automatically.
Close this window to stop.
"""
import os, sys, time, threading, webbrowser, socketserver, http.server

PORT = 8788
URL  = f"http://127.0.0.1:{PORT}"

os.chdir(os.path.dirname(os.path.abspath(__file__)))

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass  # silence request log

def open_browser():
    time.sleep(1.2)
    webbrowser.open(URL)

print(f"\n  Corpa Compass is running at {URL}")
print("  Close this window to stop.\n")
threading.Thread(target=open_browser, daemon=True).start()
try:
    with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
        httpd.serve_forever()
except KeyboardInterrupt:
    print("\nStopped.")
