import express from "express";
import http from "http";
import { Server } from "socket.io";
import QRCode from "qrcode";
import pino from "pino";
import fs from "fs/promises";
const WAHA_URL = process.env.WAHA_URL || "https://devlikeaprowaha-production-8839.up.railway.app";
import path from "path";
import baileys from "@whiskeysockets/baileys";

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage
} = baileys;

console.log("######## STU ATENDIMENTO WHATSAPP V5 ########");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json({ limit: "80mb" }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || "/app/data";
const AUTH_DIR = process.env.AUTH_DIR || "/app/data/auth_info_baileys";
const MEDIA_DIR = process.env.MEDIA_DIR || "/app/data/media";
const LID_MAP_FILE = path.join(DATA_DIR, "lid_phone_map.json");

let sock;
let lastQr = null;
let connectionStatus = "iniciando";
let manualDisconnect = false;

let clientConversations = [];
let groupConversations = [];

let lidToPhone = {};
let phoneToLid = {};

function isGroupJid(jid = "") {
  return jid.endsWith("@g.us");
}

function isPhoneJid(jid = "") {
  return jid.endsWith("@s.whatsapp.net");
}

function isLidJid(jid = "") {
  return jid.endsWith("@lid");
}

function cleanJid(jid = "") {
  return jid
    .replace("@s.whatsapp.net", "")
    .replace("@g.us", "")
    .replace("@lid", "");
}

function normalizePhone(phone = "") {
  return String(phone).replace(/\D/g, "");
}

function getMessageType(message = {}) {
  if (message.conversation || message.extendedTextMessage) return "text";
  if (message.imageMessage) return "image";
  if (message.audioMessage) return "audio";
  if (message.videoMessage) return "video";
  if (message.documentMessage) return "document";
  if (message.stickerMessage) return "sticker";
  return "unknown";
}

function getTextFromMessage(message = {}) {
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    ""
  );
}

async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(MEDIA_DIR, { recursive: true });
}

async function loadLidMap() {
  try {
    await ensureDirs();
    const raw = await fs.readFile(LID_MAP_FILE, "utf-8");
    const data = JSON.parse(raw);
    lidToPhone = data.lidToPhone || {};
    phoneToLid = data.phoneToLid || {};
    console.log("Mapa LID carregado:", Object.keys(lidToPhone).length);
  } catch {
    lidToPhone = {};
    phoneToLid = {};
  }
}

async function saveLidMap() {
  try {
    await ensureDirs();
    await fs.writeFile(
      LID_MAP_FILE,
      JSON.stringify({ lidToPhone, phoneToLid }, null, 2)
    );
  } catch (error) {
    console.error("Erro ao salvar mapa LID:", error);
  }
}

async function mapLidToPhone(lidJid, phoneJid) {
  if (!isLidJid(lidJid) || !isPhoneJid(phoneJid)) return;

  const lid = cleanJid(lidJid);
  const phone = normalizePhone(cleanJid(phoneJid));

  if (!lid || !phone) return;

  lidToPhone[lid] = phone;
  phoneToLid[phone] = lid;

  await saveLidMap();

  clientConversations.forEach(c => {
    if (c.lid === lid || c.jid === lidJid) {
      c.realPhone = phone;
      c.telefone = phone;
      c.phoneUnavailableReason = null;
    }
  });
}

function findMappedPhone(jid = "") {
  if (isPhoneJid(jid)) return normalizePhone(cleanJid(jid));
  if (isLidJid(jid)) return lidToPhone[cleanJid(jid)] || null;
  return null;
}

function collectJidsFromObject(obj, found = new Set()) {
  if (!obj || typeof obj !== "object") return found;

  for (const value of Object.values(obj)) {
    if (typeof value === "string") {
      if (
        value.endsWith("@s.whatsapp.net") ||
        value.endsWith("@lid") ||
        value.endsWith("@g.us")
      ) {
        found.add(value);
      }
    } else if (value && typeof value === "object") {
      collectJidsFromObject(value, found);
    }
  }

  return found;
}

async function learnPhonesFromMessage(msg) {
  try {
    const jids = [...collectJidsFromObject(msg)];
    const lidJids = jids.filter(isLidJid);
    const phoneJids = jids.filter(isPhoneJid);

    for (const lid of lidJids) {
      for (const phone of phoneJids) {
        await mapLidToPhone(lid, phone);
      }
    }

    const key = msg?.key || {};
    if (key.participant && key.participantPn) {
      await mapLidToPhone(key.participant, key.participantPn);
    }

    if (key.remoteJid && key.remoteJidPn) {
      await mapLidToPhone(key.remoteJid, key.remoteJidPn);
    }

    if (key.senderLid && key.senderPn) {
      await mapLidToPhone(key.senderLid, key.senderPn);
    }
  } catch (error) {
    console.log("Não foi possível aprender telefone da mensagem:", error.message);
  }
}

async function getProfilePicture(jid) {
  try {
    if (!sock) return null;
    return await sock.profilePictureUrl(jid, "image");
  } catch {
    return null;
  }
}

async function getGroupName(jid) {
  try {
    if (!jid || !jid.endsWith("@g.us")) return jid;

    const response = await fetch(`${WAHA_URL}/api/default/groups/${encodeURIComponent(jid)}`);

    if (!response.ok) {
      console.log("Não foi possível buscar nome do grupo no WAHA:", response.status);
      return jid;
    }

function getConversationList() {
  return [...clientConversations, ...groupConversations].sort((a, b) => {
    const dateA = new Date(a.lastMessageAt || a.createdAt || 0).getTime();
    const dateB = new Date(b.lastMessageAt || b.createdAt || 0).getTime();
    return dateB - dateA;
  });
}
    
    const data = await response.json();

    return (
      data.subject ||
      data.name ||
      data.groupMetadata?.subject ||
      jid
    );
  } catch (error) {
    console.log("Erro ao buscar nome do grupo no WAHA:", error.message);
    return jid;
  }
}

async function getOrCreateConversation(jid, isGroup, displayName = null) {
  if (isGroup) {
    let groupChat = groupConversations.find(c => c.jid === jid);

    const groupName = await getGroupName(jid);
    const profilePictureUrl = await getProfilePicture(jid);

    if (!groupChat) {
      groupChat = {
        id: Date.now(),
        jid,
        whatsappId: jid,
        lid: null,
        name: groupName,
        clientName: groupName,
        clientPhone: cleanJid(jid),
        realPhone: null,
        telefone: null,
        phoneUnavailableReason: "Grupo não possui telefone único",
        profilePictureUrl,
        avatarUrl: profilePictureUrl,
        conversationType: "grupo_operacional",
        type: "grupo_operacional",
        status: "monitorando",
        attendant: null,
        unreadCount: 0,
        messages: [],
        createdAt: new Date().toISOString()
      };

      groupConversations.push(groupChat);
    } else {
      groupChat.name = groupName;
      groupChat.clientName = groupName;
      groupChat.profilePictureUrl = profilePictureUrl || groupChat.profilePictureUrl || null;
      groupChat.avatarUrl = groupChat.profilePictureUrl;
    }

    return groupChat;
  }

  let clientChat = clientConversations.find(c => c.jid === jid);

  const lid = isLidJid(jid) ? cleanJid(jid) : null;
  const realPhone = findMappedPhone(jid);
  const clientPhone = realPhone || cleanJid(jid);
  const clientName = displayName || clientPhone;
  const profilePictureUrl = await getProfilePicture(jid);

  if (!clientChat) {
    clientChat = {
      id: Date.now(),
      jid,
      whatsappId: jid,
      lid,
      name: clientName,
      clientName,
      clientPhone,
      realPhone,
      telefone: realPhone,
      phoneUnavailableReason: realPhone ? null : "Número real não disponível pelo WhatsApp/Baileys",
      profilePictureUrl,
      avatarUrl: profilePictureUrl,
      conversationType: "cliente",
      type: "cliente",
      status: "nova",
      attendant: null,
      unreadCount: 0,
      messages: [],
      createdAt: new Date().toISOString()
    };

    clientConversations.push(clientChat);
  } else {
    if (displayName) {
      clientChat.name = displayName;
      clientChat.clientName = displayName;
    }

    clientChat.clientPhone = clientPhone;
    clientChat.realPhone = realPhone;
    clientChat.telefone = realPhone;
    clientChat.lid = lid;
    clientChat.phoneUnavailableReason = realPhone ? null : "Número real não disponível pelo WhatsApp/Baileys";
    clientChat.profilePictureUrl = profilePictureUrl || clientChat.profilePictureUrl || null;
    clientChat.avatarUrl = clientChat.profilePictureUrl;
  }

  return clientChat;
}

async function saveMessage({
  jid,
  sender,
  senderName,
  text,
  direction,
  displayName,
  waMessageId,
  mediaType = "none",
  mediaUrl = null,
  mediaName = null,
  mimeType = null,
  fileSize = null,
  system = false
}) {
  const isGroup = isGroupJid(jid);
  const chat = await getOrCreateConversation(jid, isGroup, displayName);

  const senderRealPhone = findMappedPhone(sender);
  const now = new Date().toISOString();

  const newMessage = {
    id: Date.now(),
    waMessageId: waMessageId || null,
    jid,
    sender,
    senderName: senderName || sender,
    senderRealPhone,
    text,
    direction,
    date: now,
    sentAt: now,
    read: direction === "sent",
    mediaType,
    mediaUrl,
    mediaName,
    mimeType,
    fileSize,
    system,
    deletedInWhatsApp: false,
    preservedInSystem: true
  };

  chat.messages.push(newMessage);

  if (mediaType === "audio") chat.lastMessage = "🎧 Áudio";
  else if (mediaType === "image") chat.lastMessage = "🖼️ Imagem";
  else if (mediaType === "video") chat.lastMessage = "🎥 Vídeo";
  else if (mediaType === "document") chat.lastMessage = "📎 Documento";
  else if (mediaType === "sticker") chat.lastMessage = "Figurinha";
  else chat.lastMessage = text || "";

  chat.lastMessageText = chat.lastMessage;
  chat.lastMessageAt = newMessage.date;
  chat.lastMessageTime = newMessage.date;

  if (direction === "received") {
    chat.unreadCount = (chat.unreadCount || 0) + 1;
  }

  io.emit("novaMensagem", {
    conversation: chat,
    message: newMessage,
    conversas: getConversationList()
  });

  io.emit("conversasAtualizadas", getConversationList());

  return newMessage;
}

async function processarMensagemWaha(body) {
  const event = body.event;
  const payload = body.payload || {};

  if (event !== "message") return;
  if (!payload) return;
  if (payload.fromMe) return;

  const rawJid = payload.from || payload._data?.key?.remoteJid;
  const altJid = payload._data?.key?.remoteJidAlt;

  if (!rawJid) return;
  if (rawJid === "status@broadcast") return;

  const isGroup = rawJid.endsWith("@g.us");

  let jid = rawJid;
let sender = rawJid;
let displayName = payload._data?.pushName || payload.pushName || rawJid;

if (isGroup) {
  sender =
    payload.participant ||
    payload._data?.key?.participant ||
    rawJid;

  const participantAlt =
    payload._data?.key?.participantAlt ||
    null;

  if (participantAlt && participantAlt.endsWith("@s.whatsapp.net")) {
    await mapLidToPhone(sender, participantAlt);
    sender = participantAlt;
  }

  displayName = rawJid;
}

  if (!isGroup && altJid && altJid.endsWith("@s.whatsapp.net")) {
    await mapLidToPhone(rawJid, altJid);

    const telefone = normalizePhone(cleanJid(altJid));
    jid = `${telefone}@s.whatsapp.net`;
    sender = jid;
  }

  const text =
    payload.body ||
    payload._data?.message?.conversation ||
    payload._data?.message?.extendedTextMessage?.text ||
    "";

  await saveMessage({
    jid,
    sender,
    senderName: displayName,
    displayName,
    text,
    direction: "received",
    waMessageId: payload._data?.key?.id || payload.id,
    mediaType: "none",
    mediaUrl: null,
    mediaName: null,
    mimeType: null,
    fileSize: null
  });

  console.log("✅ Mensagem WAHA salva:", {
    jid,
    sender,
    displayName,
    text
  });
}

async function markDeletedMessage(jid, deletedWaMessageId) {
  const list = isGroupJid(jid) ? groupConversations : clientConversations;
  const chat = list.find(c => c.jid === jid);

  if (!chat) return false;

  const message = chat.messages.find(m => m.waMessageId === deletedWaMessageId);

  if (message) {
    message.deletedInWhatsApp = true;
    message.preservedInSystem = true;
    message.deletedNotice = "Mensagem apagada no WhatsApp, preservada no sistema";
    message.updatedAt = new Date().toISOString();

    io.emit("mensagemApagada", { jid, waMessageId: deletedWaMessageId, message, conversation: chat });
    io.emit("conversasAtualizadas", getConversationList());

    return true;
  }

  await saveMessage({
    jid,
    sender: "sistema",
    senderName: "Sistema",
    text: "Uma mensagem foi apagada no WhatsApp, mas não foi encontrada no histórico local.",
    direction: "system",
    system: true
  });

  return false;
}

function getExtensionFromMime(mimeType = "") {
  if (mimeType.includes("jpeg")) return "jpg";
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("pdf")) return "pdf";
  if (mimeType.includes("word")) return "docx";
  if (mimeType.includes("excel") || mimeType.includes("spreadsheet")) return "xlsx";
  return "bin";
}

async function saveBufferToMedia(buffer, originalName, mimeType) {
  await ensureDirs();

  const extension = getExtensionFromMime(mimeType);
  const fallbackName = `${Date.now()}.${extension}`;
  const safeOriginalName = (originalName || fallbackName).replace(/[^\w.\-]/g, "_");
  const fileName = `${Date.now()}-${safeOriginalName}`;
  const filePath = path.join(MEDIA_DIR, fileName);

  await fs.writeFile(filePath, buffer);

  return {
    mediaUrl: `/media/${fileName}`,
    mediaName: originalName || fileName,
    mimeType,
    fileSize: buffer.length
  };
}

async function saveIncomingMedia(msg) {
  try {
    const buffer = await downloadMediaMessage(
      msg,
      "buffer",
      {},
      {
        logger: pino({ level: "silent" }),
        reuploadRequest: sock?.updateMediaMessage
      }
    );

    const message = msg.message || {};
    const mediaMessage =
      message.imageMessage ||
      message.audioMessage ||
      message.videoMessage ||
      message.documentMessage ||
      message.stickerMessage;

    const mimeType = mediaMessage?.mimetype || "application/octet-stream";
    const originalName =
      mediaMessage?.fileName ||
      `${msg.key.id}.${getExtensionFromMime(mimeType)}`;

    return await saveBufferToMedia(buffer, originalName, mimeType);
  } catch (error) {
    console.error("Erro ao salvar mídia recebida:", error);
    return { mediaUrl: null, mediaName: null, mimeType: null, fileSize: null };
  }
}

app.use("/media", express.static(MEDIA_DIR));

app.get("/status", (req, res) => {
  res.json({
    status: connectionStatus,
    whatsappConectado: !!sock && connectionStatus.includes("conectado"),
    qrDisponivel: !!lastQr,
    clientes: clientConversations.length,
    grupos: groupConversations.length,
    lidMapeados: Object.keys(lidToPhone).length
  });
});

app.get("/qr", (req, res) => {
  res.json({ status: connectionStatus, qr: lastQr });
});

app.get("/clientes", (req, res) => {
  res.json(clientConversations);
});

app.get("/grupos", (req, res) => {
  res.json(groupConversations);
});

app.get("/conversas", (req, res) => {
  res.json(getConversationList());
});

app.get("/lid-map", (req, res) => {
  res.json({ lidToPhone, phoneToLid });
});

app.post("/waha-webhook", async (req, res) => {
  try {
    console.log("📩 WAHA WEBHOOK RECEBIDO:");
    console.log(JSON.stringify(req.body, null, 2));

    await processarMensagemWaha(req.body);

    return res.json({
      sucesso: true,
      recebido: true
    });
  } catch (error) {
    console.error("Erro no /waha-webhook:", error);
    return res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

app.post("/mapear-telefone", async (req, res) => {
  const { lid, telefone } = req.body;

  if (!lid || !telefone) {
    return res.status(400).json({ erro: "Informe lid e telefone" });
  }

  const lidJid = lid.endsWith("@lid") ? lid : `${lid}@lid`;
  const phoneJid = `${normalizePhone(telefone)}@s.whatsapp.net`;

  await mapLidToPhone(lidJid, phoneJid);

  res.json({
    sucesso: true,
    lid: cleanJid(lidJid),
    telefone: normalizePhone(telefone)
  });
});

app.post("/enviar", async (req, res) => {
  try {
    const { jid, mensagem } = req.body;

    if (!jid || !mensagem) {
      return res.status(400).json({ erro: "Informe jid e mensagem" });
    }

    if (!sock) {
      return res.status(503).json({ erro: "WhatsApp ainda não iniciado" });
    }

    const sent = await sock.sendMessage(jid, { text: mensagem });

    await saveMessage({
      jid,
      sender: "sistema",
      senderName: "STU Atendimento",
      text: mensagem,
      direction: "sent",
      waMessageId: sent?.key?.id || null
    });

    res.json({ sucesso: true, jid, mensagem });
  } catch (error) {
    console.error("Erro ao enviar mensagem:", error);
    res.status(500).json({ erro: "Erro ao enviar mensagem", detalhe: error.message });
  }
});

app.post("/enviar-midia", async (req, res) => {
  try {
    const { jid, mediaType, base64, mimeType, fileName, caption } = req.body;

    if (!jid || !mediaType || !base64) {
      return res.status(400).json({ erro: "Informe jid, mediaType e base64" });
    }

    if (!sock) {
      return res.status(503).json({ erro: "WhatsApp ainda não iniciado" });
    }

    const buffer = Buffer.from(base64, "base64");

    const savedMedia = await saveBufferToMedia(
      buffer,
      fileName || `${Date.now()}.${getExtensionFromMime(mimeType || "")}`,
      mimeType || "application/octet-stream"
    );

    let payload;

    if (mediaType === "image") {
      payload = { image: buffer, caption: caption || "" };
    } else if (mediaType === "audio") {
      payload = { audio: buffer, mimetype: mimeType || "audio/ogg", ptt: true };
    } else if (mediaType === "video") {
      payload = { video: buffer, caption: caption || "" };
    } else if (mediaType === "document") {
      payload = {
        document: buffer,
        mimetype: mimeType || "application/octet-stream",
        fileName: fileName || "arquivo"
      };
    } else {
      return res.status(400).json({
        erro: "mediaType inválido. Use image, audio, video ou document"
      });
    }

    const sent = await sock.sendMessage(jid, payload);

    const message = await saveMessage({
      jid,
      sender: "sistema",
      senderName: "STU Atendimento",
      text: caption || "",
      direction: "sent",
      waMessageId: sent?.key?.id || null,
      mediaType,
      mediaUrl: savedMedia.mediaUrl,
      mediaName: savedMedia.mediaName,
      mimeType: savedMedia.mimeType,
      fileSize: savedMedia.fileSize
    });

    res.json({
      sucesso: true,
      jid,
      mediaType,
      mediaUrl: savedMedia.mediaUrl,
      mediaName: savedMedia.mediaName,
      mimeType: savedMedia.mimeType,
      fileSize: savedMedia.fileSize,
      message
    });
  } catch (error) {
    console.error("Erro ao enviar mídia:", error);
    res.status(500).json({ erro: "Erro ao enviar mídia", detalhe: error.message });
  }
});

app.post("/desconectar", async (req, res) => {
  try {
    manualDisconnect = true;

    try {
      if (sock) await sock.logout();
    } catch (error) {
      console.log("Logout retornou erro, continuando limpeza:", error.message);
    }

    sock = null;
    lastQr = null;
    connectionStatus = "🔴 WhatsApp desconectado. Gerando novo QR Code...";
    io.emit("status", { status: connectionStatus });

    await fs.rm(AUTH_DIR, { recursive: true, force: true });

    setTimeout(() => {
      manualDisconnect = false;
      startWhatsApp();
    }, 2000);

    res.json({ sucesso: true, mensagem: "Sessão desconectada. Um novo QR Code será gerado." });
  } catch (error) {
    console.error("Erro ao desconectar:", error);
    res.status(500).json({ erro: "Erro ao desconectar", detalhe: error.message });
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
          button { padding:12px 18px; border:0; border-radius:10px; background:#1f8f5f; color:white; cursor:pointer; margin:4px; }
          .danger { background:#b91c1c; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>STU Atendimento WhatsApp</h2>
          <div class="status" id="status">Carregando...</div>
          <div id="qr"></div>
          <button onclick="location.reload()">Atualizar</button>
          <button class="danger" onclick="desconectar()">Desconectar conta</button>
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

          async function desconectar() {
            if (!confirm("Deseja desconectar esta conta e gerar um novo QR Code?")) return;
            await fetch("/desconectar", { method: "POST" });
            setTimeout(() => location.reload(), 3000);
          }
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

  client.emit("conversasAtualizadas", getConversationList());

  client.on("get-current", () => {
    client.emit("status", { status: connectionStatus });

    if (lastQr) {
      client.emit("qr", { qrImage: lastQr });
    }

    client.emit("conversasAtualizadas", getConversationList());
  });
});

async function startWhatsApp() {
  try {
    connectionStatus = "Conectando ao WhatsApp...";
    io.emit("status", { status: connectionStatus });

    await ensureDirs();
    await loadLidMap();

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

    sock.ev.on("contacts.update", async (contacts) => {
      try {
        for (const contact of contacts || []) {
          const jids = [...collectJidsFromObject(contact)];
          const lids = jids.filter(isLidJid);
          const phones = jids.filter(isPhoneJid);

          for (const lid of lids) {
            for (const phone of phones) {
              await mapLidToPhone(lid, phone);
            }
          }
        }
      } catch (error) {
        console.log("Erro em contacts.update:", error.message);
      }
    });

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

        if (manualDisconnect) {
          connectionStatus = "🔴 WhatsApp desconectado manualmente";
          io.emit("status", { status: connectionStatus });
          return;
        }

        if (statusCode === DisconnectReason.loggedOut) {
          connectionStatus = "🔴 Sessão encerrada. Gere novo QR Code.";
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

    sock.ev.on("call", async (calls) => {
      try {
        for (const call of calls || []) {
          const jid = call.from;

          await saveMessage({
            jid,
            sender: jid,
            senderName: "Chamada WhatsApp",
            text: "Chamada recebida e não atendida pelo sistema.",
            direction: "system",
            system: true
          });

          if (typeof sock.rejectCall === "function" && call.id && call.from) {
            try {
              await sock.rejectCall(call.id, call.from);
            } catch {
              console.log("Não foi possível rejeitar chamada automaticamente.");
            }
          }
        }
      } catch (error) {
        console.error("Erro ao tratar chamada:", error);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages || []) {
        if (!msg?.message) continue;
        if (msg.key.fromMe) continue;

        await learnPhonesFromMessage(msg);

        const jid = msg.key.remoteJid;

        if (jid === "status@broadcast") continue;
        if (msg.message.senderKeyDistributionMessage) continue;

        if (msg.message.protocolMessage) {
          const protocol = msg.message.protocolMessage;
          const deletedId = protocol?.key?.id;

          if (deletedId) await markDeletedMessage(jid, deletedId);
          continue;
        }

        const isGroup = isGroupJid(jid);
        const sender = isGroup ? msg.key.participant : jid;
        const senderName = msg.pushName || sender;

        const messageType = getMessageType(msg.message);
        const text = getTextFromMessage(msg.message);

        let mediaInfo = {
          mediaUrl: null,
          mediaName: null,
          mimeType: null,
          fileSize: null
        };

        if (["image", "audio", "video", "document", "sticker"].includes(messageType)) {
          mediaInfo = await saveIncomingMedia(msg);
        }

        if (!text && messageType === "text") continue;

        await saveMessage({
          jid,
          sender,
          senderName,
          displayName: isGroup ? null : senderName,
          text: text || "",
          direction: "received",
          waMessageId: msg.key.id,
          mediaType: messageType === "text" ? "none" : messageType,
          mediaUrl: mediaInfo.mediaUrl,
          mediaName: mediaInfo.mediaName,
          mimeType: mediaInfo.mimeType,
          fileSize: mediaInfo.fileSize
        });

        console.log(isGroup ? "Mensagem de GRUPO salva:" : "Mensagem de CLIENTE salva:");
        console.log("JID:", jid);
        console.log("Remetente:", senderName);
        console.log("Tipo:", messageType);
        console.log("Telefone real mapeado:", findMappedPhone(sender || jid) || "não disponível");
        console.log("Mensagem:", text || `[${messageType}]`);
      }
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
  console.log("WAHA MODE ATIVO - Baileys desativado");
});
