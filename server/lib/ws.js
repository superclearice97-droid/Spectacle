'use strict';
// Minimal RFC 6455 WebSocket server (text + binary, ping/pong, close). No dependencies.
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MSG = 8 * 1024 * 1024;

class Socket extends EventEmitter {
  constructor(sock) {
    super();
    this.sock = sock; this.buf = Buffer.alloc(0); this.frags = []; this.open = true; this.alive = true;
    sock.setNoDelay(true);
    sock.on('data', d => this._data(d));
    sock.on('close', () => this._closed());
    sock.on('error', () => this._closed());
  }
  _closed() { if (!this.open) return; this.open = false; this.emit('close'); }
  _data(d) {
    this.alive = true;
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = b0 & 0x80, op = b0 & 0x0f, masked = b1 & 0x80;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (!masked || len > MAX_MSG) return this.close(1009);
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4); off += 4;
      const payload = Buffer.from(this.buf.subarray(off, off + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + len);
      if (op === 0x8) return this.close();
      if (op === 0x9) { this._send(0xA, payload); continue; }
      if (op === 0xA) { this.alive = true; continue; }
      if (op === 0x1 || op === 0x2) { this.frags = [payload]; this.fragOp = op; }
      else if (op === 0x0) this.frags.push(payload);
      if (fin && this.frags.length) {
        const msg = Buffer.concat(this.frags); this.frags = [];
        this.emit('message', this.fragOp === 0x1 ? msg.toString('utf8') : msg, this.fragOp === 0x2);
      }
    }
  }
  _send(op, data) {
    if (!this.open) return;
    const len = data.length; let h;
    if (len < 126) { h = Buffer.alloc(2); h[1] = len; }
    else if (len < 65536) { h = Buffer.alloc(4); h[1] = 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.alloc(10); h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
    h[0] = 0x80 | op;
    this.sock.write(Buffer.concat([h, data]));
  }
  send(data) { if (typeof data === 'object' && !Buffer.isBuffer(data)) data = JSON.stringify(data); Buffer.isBuffer(data) ? this._send(0x2, data) : this._send(0x1, Buffer.from(data)); }
  get bufferedAmount() { return this.sock.writableLength; }
  close(code = 1000) { if (this.open) { const b = Buffer.alloc(2); b.writeUInt16BE(code); this._send(0x8, b); this.sock.end(); } this._closed(); }
}

function upgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return null; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const ws = new Socket(socket);
  if (head && head.length) ws._data(head);
  return ws;
}

function heartbeat(sockets) {
  return setInterval(() => {
    for (const ws of sockets()) {
      if (!ws.alive) { ws.close(1001); continue; }
      ws.alive = false; ws._send(0x9, Buffer.alloc(0));
    }
  }, 30000);
}

module.exports = { upgrade, heartbeat };
