import { createServer } from 'node:http';
import { chmod, unlink } from 'node:fs/promises';
import { WebSocketServer, WebSocket } from 'ws';

// WebSocket framing over a private Unix socket matches Codex --remote unix://.
// Browser origins and additional concurrent clients are deliberately rejected.
export async function listenNative(gateway, path) {
  let closing = false, detaching = false;
  const http = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  http.on('upgrade', (request, socket, head) => {
    if (request.headers.origin || gateway.connected || closing || detaching) { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, connection => sockets.emit('connection', connection));
  });
  sockets.on('connection', connection => {
    const send = value => { if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ jsonrpc: '2.0', ...value })); };
    try { gateway.attach(send); } catch { connection.close(1008); return; }
    connection.on('message', async (data, binary) => {
      let request;
      try {
        if (binary) throw new Error('Text JSON-RPC is required');
        request = JSON.parse(data.toString());
        if (!request || Array.isArray(request) || typeof request.method !== 'string' || request.params != null && (typeof request.params !== 'object' || Array.isArray(request.params))) throw new Error('Invalid RPC request');
        const result = await gateway.handle(request.method, request.params);
        if (request.id !== undefined) send({ id: request.id, result });
      } catch (error) {
        if (request?.id !== undefined) send({ id: request.id, error: { code: -32000, message: error.message } });
        else if (!request) connection.close(1008);
      }
    });
    connection.on('error', () => {});
    connection.on('close', () => { detaching = true; gateway.detach().catch(() => {}).finally(() => { detaching = false; }); });
  });
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(path, resolve); });
  await chmod(path, 0o600);
  return { path, async close() {
    closing = true;
    for (const connection of sockets.clients) connection.terminate();
    await gateway.detach();
    await new Promise(resolve => http.close(resolve)); sockets.close();
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  } };
}
