import express from "express";
import http from "http";
import { Server } from "socket.io";
import QRCode from "qrcode";
import pino from "pino";
import baileys from "@whiskeysockets/baileys";

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = baileys;

console.log("######## STU ATENDIMENTO WHATSAPP ########");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.json());

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 3000;
const AUTH_DIR = process.env.AUTH_DIR || "/app/data/auth_info_baileys";

let sock;
let lastQr = null;
let connectionStatus = "iniciando";

let clientConversations = [];
let groupConversations = [];

function getOrCreateConversation(jid, isGroup) {
  if (isGroup) {
    let groupChat = groupConversations.find(c => c.jid === jid);

    if (!groupChat) {
      groupChat = {
        id: Date.now(),
        jid,
        name: jid,
        type: "grupo_operacional",
        status: "monitorando",
        messages: [],
        createdAt: new Date().toISOString()
      };

      groupConversations.push(groupChat);
    }

    return groupChat;
  }

  let clientChat = clientConversations.find(c => c.jid === jid);

  if (!clientChat) {
    clientChat = {
      id: Date.now(),
      jid,
      name: jid.replace("@s.whatsapp.net", "").replace("@lid", ""),
      type: "cliente",
      status: "nova",
      attendant: null,
      messages: [],
      createdAt: new Date().toISOString()
    };

    clientConversations.push(clientChat);
  }

  return clientChat;
}

function saveMessage({ jid, sender, text, direction }) {
  const isGroup = jid.endsWith("@g.us");
  const chat = getOrCreateConversation(jid, isGroup);

  const newMessage = {
    id: Date.now(),
    jid,
    sender,
    text,
    direction,
    date: new Date().toISOString(),
    read: direction === "sent"
  };

  chat.messages.push(newMessage);
  chat.lastMessage = text;
  chat.lastMessageAt = newMessage.date;

  return newMessage;
}

app.get("/status", (req, res) => {
  res.json({
    status: connectionStatus,
    whatsappConectado: !!sock,
    clientes: clientConversations.length,
    grupos: groupConversations.length
  });
});

app.get("/clientes", (req, res) => {
  res.json(clientConversations);
});

app.get("/grupos", (req, res) => {
  res.json(groupConversations);
});

app.post("/enviar", async (req, res) => {
  try {
    const { jid, mensagem } = req.body;

    if (!jid || !mensagem) {
      return res.status(400).json({
        erro: "Informe jid e mensagem"
      });
    }

    if (!sock) {
      return res.status(503).json({
        erro: "WhatsApp ainda não iniciado"
      });
    }

    await sock.sendMessage(jid, {
      text: mensagem
    });

    saveMessage({
      jid,
      sender: "sistema",
      text: mensagem,
      direction: "sent"
    });

    res.json({
      sucesso: true,
      jid,
      mensagem
    });

  } catch (error) {
    console.error("Erro ao enviar mensagem:", error);

    res.status(500).json({
      erro: "Erro ao enviar mensagem",
      detalhe: error.message
    });
  }
});

app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>STU WhatsApp</title>
        <style>
          body { font-family: Arial; background:#f4f7fb; padding:40px; }
          .card { background:white; padding:30px; border-radius:16px; max-width:520px; margin:auto; box-shadow:0 10px 30px #0001; text-align:center; }
          img { max-width:280px; margin:20px auto; display:block; }
          .status { font-size:18px; font-weight:bold; margin:20px; }
          button { padding:12px 18px; border:0; border-radius:10px; background:#1f8f5f; color:white; cursor:pointer; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>STU Atendimento WhatsApp</h2>
          <div class="status" id="status">Carregando...</div>
          <div id="qr"></div>
          <button onclick="location.reload()">Atualizar</button>
        </div>

        <script src="/socket.io/socket.io.js"></script>
        <script>
          const socket = io();

          socket.on("status", data => {
            document.getElementById("status").innerText = data.status;
          });

          socket.on("qr", data => {
            document.getElementById("qr").innerHTML = data.qrImage ? '<img src="' + data.qrImage + '" />' : '';
          });

          socket.emit("get-current");
        </script>
      </body>
    </html>
  `);
});

io.on("connection", (client) => {
  client.emit("status", { status: connectionStatus });

  if (lastQr) {
    client.emit("qr", { qrImage: lastQr });
  }

  client.on("get-current", () => {
    client.emit("status", { status: connectionStatus });

    if (lastQr) {
      client.emit("qr", { qrImage: lastQr });
    }
  });
});

async function startWhatsApp() {
  try {
    connectionStatus = "Conectando ao WhatsApp...";
    io.emit("status", { status: connectionStatus });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: "warn" }),
      browser: ["STU Atendimento", "Chrome", "1.0.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      printQRInTerminal: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("QR gerado.");
        connectionStatus = "QR Code gerado. Escaneie no WhatsApp.";
        lastQr = await QRCode.toDataURL(qr);
        io.emit("status", { status: connectionStatus });
        io.emit("qr", { qrImage: lastQr });
      }

      if (connection === "open") {
        console.log("WhatsApp conectado com sucesso.");
        connectionStatus = "🟢 WhatsApp conectado";
        lastQr = null;
        io.emit("status", { status: connectionStatus });
        io.emit("qr", { qrImage: "" });
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log("Conexão fechada. Código:", statusCode);

        if (statusCode === DisconnectReason.loggedOut) {
          connectionStatus = "🔴 Sessão encerrada. Apague o volume/auth e gere novo QR.";
          io.emit("status", { status: connectionStatus });
          return;
        }

        connectionStatus = "Reconectando...";
        io.emit("status", { status: connectionStatus });

        setTimeout(() => {
          startWhatsApp();
        }, 5000);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      const msg = messages?.[0];
      if (!msg?.message) return;
      if (msg.key.fromMe) return;

      const jid = msg.key.remoteJid;

      if (jid === "status@broadcast") return;
      if (msg.message.protocolMessage) return;
      if (msg.message.senderKeyDistributionMessage) return;

      const isGroup = jid.endsWith("@g.us");
      const sender = isGroup ? msg.key.participant : jid;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        msg.message.documentMessage?.caption ||
        "";

      if (!text) return;

      saveMessage({
        jid,
        sender,
        text,
        direction: "received"
      });

      console.log(isGroup ? "Mensagem de GRUPO salva:" : "Mensagem de CLIENTE salva:");
      console.log("JID:", jid);
      console.log("Mensagem:", text);
    });

  } catch (error) {
    console.error("Erro ao iniciar WhatsApp:", error);
    connectionStatus = "Erro ao iniciar WhatsApp. Veja os logs.";
    io.emit("status", { status: connectionStatus });

    setTimeout(() => {
      startWhatsApp();
    }, 10000);
  }
}

server.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT);
  startWhatsApp();
});
