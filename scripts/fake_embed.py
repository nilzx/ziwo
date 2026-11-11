"""A stand-in for an OpenAI-compatible embeddings server, for smoke tests only.

Texts are placed on the axis of each topic they mention, plus a small
component on an axis of their own, so texts sharing a topic are close and
everything else is unrelated. Usage: fake_embed.py <port>
"""
import json
import sys
import zlib
from http.server import BaseHTTPRequestHandler, HTTPServer

TOPICS = [
    ["猫", "cat", "feline", "kitten"],
    ["部署", "上线", "deploy", "release"],
    ["纠正", "误解", "corrected", "misunderstood"],
]
OWN = 4096


def embed(text):
    v = [0.0] * (len(TOPICS) + OWN)
    v[len(TOPICS) + zlib.crc32(text.encode()) % OWN] = 0.05
    low = text.lower()
    for axis, words in enumerate(TOPICS):
        if any(w in low for w in words):
            v[axis] = 1.0
    return v


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        sys.stderr.write("embed %s: %s\n" % (body["model"], json.dumps(body["input"], ensure_ascii=False)[:120]))
        out = {"data": [{"index": i, "embedding": embed(t)} for i, t in enumerate(body["input"])]}
        data = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
