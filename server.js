// server.js — Instale: npm install @whiskeysockets/baileys express ws qrcode cors
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const express = require('express');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const cors = require('cors');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let sock = null, qrBase64 = null, connStatus = 'disconnected';
const clients = new Set();

wss.on('connection', ws => { clients.add(ws); ws.on('close', () => clients.delete(ws)); });
function broadcast(data) { clients.forEach(c => c.readyState === 1 && c.send(JSON.stringify(data))); }

async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  sock = makeWASocket({ auth: state, printQRInTerminal: false });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) { qrBase64 = await QRCode.toDataURL(qr); connStatus = 'connecting'; broadcast({ type: 'qr', qr: qrBase64 }); }
    if (connection === 'open') { connStatus = 'connected'; qrBase64 = null; broadcast({ type: 'status', status: 'connected' }); }
    if (connection === 'close') {
      connStatus = 'disconnected';
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) setTimeout(startWA, 3000);
      broadcast({ type: 'status', status: 'disconnected' });
    }
  });
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const phone = msg.key.remoteJid.replace('@s.whatsapp.net','').replace('@g.us','');
      const name = msg.pushName || phone;
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      broadcast({ type: 'message', phone, name, text, time: new Date().toISOString() });
    }
  });
}

app.get('/status', (req, res) => res.json({ status: connStatus, qr: qrBase64 }));
app.get('/qr', (req, res) => res.json({ qr: qrBase64 }));
app.post('/send-message', async (req, res) => {
  const { phone, message } = req.body;
  if (!sock || connStatus !== 'connected') return res.status(503).json({ error: 'Not connected' });
  await sock.sendMessage(phone + '@s.whatsapp.net', { text: message });
  res.json({ ok: true });
});
app.post('/disconnect', async (req, res) => {
  await sock?.logout();
  connStatus = 'disconnected';
  res.json({ ok: true });
});

startWA();
server.listen(process.env.PORT || 3001, () => console.log('Server running'));
