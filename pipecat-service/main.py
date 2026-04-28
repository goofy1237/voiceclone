import os
import asyncio
import threading

from dotenv import load_dotenv
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

# Fix macOS Python SSL certificate issue
import certifi
os.environ.setdefault("SSL_CERT_FILE", certifi.where())
os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())

from http.server import HTTPServer, SimpleHTTPRequestHandler
from pipecat.pipeline.runner import PipelineRunner
from pipeline import create_pipeline
from prompt.loader import get_system_prompt

TEST_PAGE = """<!DOCTYPE html>
<html>
<head><title>Sarah — voice test</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:0 20px">
  <h2>Sarah voice test</h2>
  <p id="status">Click Start to connect</p>
  <button id="btn" onclick="start()">Start call</button>
  <button onclick="stop()" style="margin-left:8px">Stop</button>
  <div id="log" style="margin-top:16px;font-size:13px;color:#333;max-height:400px;overflow-y:auto"></div>
  <p style="font-size:12px;color:#888;margin-top:20px">
    Speak naturally. Sarah will respond via Fish Audio TTS.
  </p>
  <script>
    let ws, ctx, workletNode, playCtx, nextPlayTime = 0;
    function log(msg) {
      const d = document.getElementById('log');
      const p = document.createElement('p');
      p.style.margin = '4px 0';
      p.textContent = msg;
      d.prepend(p);
      console.log(msg);
    }
    async function start() {
      document.getElementById('status').textContent = 'Connecting...';
      ws = new WebSocket('ws://localhost:8765');
      ws.binaryType = 'arraybuffer';

      ws.onopen = async () => {
        document.getElementById('status').textContent = 'Connected — speak now';
        log('[connected]');
        ctx = new AudioContext({ sampleRate: 16000 });
        playCtx = new AudioContext({ sampleRate: 44100 });
        nextPlayTime = 0;
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mic = ctx.createMediaStreamSource(stream);
        await ctx.audioWorklet.addModule('data:application/javascript,' + encodeURIComponent(`
          class PcmProcessor extends AudioWorkletProcessor {
            process(inputs) {
              const ch = inputs[0][0];
              if (ch) {
                const buf = new Int16Array(ch.length);
                for (let i = 0; i < ch.length; i++)
                  buf[i] = Math.max(-32768, Math.min(32767, ch[i] * 32768));
                this.port.postMessage(buf.buffer, [buf.buffer]);
              }
              return true;
            }
          }
          registerProcessor('pcm-processor', PcmProcessor);
        `));
        workletNode = new AudioWorkletNode(ctx, 'pcm-processor');
        mic.connect(workletNode);
        workletNode.port.onmessage = e => {
          if (ws.readyState === 1) ws.send(e.data);
        };
      };

      ws.onmessage = e => {
        if (e.data instanceof ArrayBuffer && e.data.byteLength > 0) {
          const view = new DataView(e.data);
          const numSamples = Math.floor(e.data.byteLength / 2);
          if (numSamples === 0) return;
          const buf = playCtx.createBuffer(1, numSamples, 44100);
          const ch = buf.getChannelData(0);
          for (let i = 0; i < numSamples; i++) {
            ch[i] = view.getInt16(i * 2, true) / 32768;
          }
          const src = playCtx.createBufferSource();
          src.buffer = buf;
          src.connect(playCtx.destination);
          const now = playCtx.currentTime;
          if (nextPlayTime < now) nextPlayTime = now;
          src.start(nextPlayTime);
          nextPlayTime += buf.duration;
        }
      };
      ws.onclose = () => {
        document.getElementById('status').textContent = 'Disconnected';
        log('[disconnected]');
      };
      ws.onerror = () => log('[error] WebSocket error');
    }
    function stop() {
      if (ws) ws.close();
      if (ctx) ctx.close();
      if (playCtx) playCtx.close();
      document.getElementById('status').textContent = 'Stopped';
    }
  </script>
</body>
</html>"""


class TestPageHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(TEST_PAGE.encode())

    def log_message(self, format, *args):
        pass  # Suppress HTTP logs


def start_http_server():
    """Serve the test page on port 8080."""
    server = HTTPServer(("0.0.0.0", 8080), TestPageHandler)
    print("[http] Test page at http://localhost:8080")
    server.serve_forever()


async def main():
    print("[pipecat] Loading system prompt...")
    system_prompt = await get_system_prompt()
    print(f"[pipecat] System prompt: {len(system_prompt)} chars")

    print("[pipecat] Building pipeline...")
    task, transport = await create_pipeline(system_prompt)

    runner = PipelineRunner(handle_sigint=True)

    print("[pipecat] Starting pipeline on ws://localhost:8765")
    print("[pipecat] Open http://localhost:8080 to test")
    print("[pipecat] Waiting for WebSocket connection...")

    await runner.run(task)


if __name__ == "__main__":
    # Start HTTP server in background thread for test page
    http_thread = threading.Thread(target=start_http_server, daemon=True)
    http_thread.start()

    asyncio.run(main())
