import express from "express";
import http from "http";
import { Server } from "socket.io";
import fs from "fs/promises";
import path from "path";

console.log("######## STU ATENDIMENTO WHATSAPP V6 - WAHA MODE ########");

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
const MEDIA_DIR = process.env.MEDIA_DIR || "/app/data/media";
const LID_MAP_FILE = path.join(DATA_DIR, "lid_phone_map.json");

const WAHA_URL =
  process.env.WAHA_URL || "https://devlikeaprowaha-production-8839.up.railway.app";
const WAHA_SESSION = process.env.WAHA_SESSION || "default";

let connectionStatus = "WAHA MODE ATIVO";
let lastQr = null;

let clientConversations = [];
let groupConversations = [];

let lidToPhone = {};
let phoneToLid = {};
let groupNameCache = {};

function getConversationList() {
  return [...clientConversations, ...groupConversations].sort((a, b) => {
    const dateA = new Date(a.lastMessageAt || a.createdAt || 0).getTime();
    const dateB = new Date(b.lastMessageAt || b.createdAt || 0).getTime();
    return dateB - dateA;
  });
}

function isGroupJid(jid = "") {
  return jid.endsWith("@g.us");
}

function isPhoneJid(jid = "") {
  return jid.endsWith("@s.whatsapp.net") || jid.endsWith("@c.us");
}

function isLidJid(jid = "") {
  return jid.endsWith("@lid");
}

function cleanJid(jid = "") {
  return String(jid)
    .replace("@s.whatsapp.net", "")
    .replace("@c.us", "")
    .replace("@g.us", "")
    .replace("@lid", "");
}

function normalizePhone(phone = "") {
  return String(phone).replace(/\D/g, "");
}

function toInternalPhoneJid(jid = "") {
  if (!jid) return jid;
  if (jid.endsWith("@c.us")) return `${normalizePhone(cleanJid(jid))}@s.whatsapp.net`;
  return jid;
}

function toWahaChatId(jid = "") {
  if (!jid) return jid;
  if (jid.endsWith("@s.whatsapp.net")) return `${normalizePhone(cleanJid(jid))}@c.us`;
  return jid;
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
    groupNameCache = data.groupNameCache || {};
    console.log("Mapa LID carregado:", Object.keys(lidToPhone).length);
  } catch {
    lidToPhone = {};
    phoneToLid = {};
    groupNameCache = {};
  }
}

async function saveLidMap() {
  try {
    await ensureDirs();
    await fs.writeFile(
      LID_MAP_FILE,
      JSON.stringify({ lidToPhone, phoneToLid, groupNameCache }, null, 2)
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
      c.clientPhone = phone;
      c.phoneUnavailableReason = null;
    }
  });

  groupConversations.forEach(c => {
    c.messages.forEach(m => {
      if (m.sender === lidJid) {
        m.senderRealPhone = phone;
      }
    });
  });
}

function findMappedPhone(jid = "") {
  if (isPhoneJid(jid)) return normalizePhone(cleanJid(jid));
  if (isLidJid(jid)) return lidToPhone[cleanJid(jid)] || null;
  return null;
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

async function downloadWahaMedia(payload) {
  try {
    if (!payload?.hasMedia && !payload?.media) {
      return { mediaUrl: null, mediaName: null, mimeType: null, fileSize: null };
    }

    if (payload.media?.data) {
      const buffer = Buffer.from(payload.media.data, "base64");
      return await saveBufferToMedia(
        buffer,
        payload.media.filename || payload.media.fileName || `${payload.id}.${getExtensionFromMime(payload.media.mimetype || "")}`,
        payload.media.mimetype || payload.media.mimeType || "application/octet-stream"
      );
    }

    if (payload.media?.url) {

      let mediaUrl = payload.media.url;

      mediaUrl = mediaUrl.replace(
        "http://devlikeaprowaha.railway.internal",
        WAHA_URL
      );

      console.log("⬇️ Baixando mídia WAHA:", mediaUrl);

      const response = await fetch(mediaUrl);
      if (!response.ok) throw new Error(`Erro ao baixar mídia: ${response.status}`);

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const mimeType =
        payload.media.mimetype ||
        payload.media.mimeType ||
        response.headers.get("content-type") ||
        "application/octet-stream";

      return await saveBufferToMedia(
        buffer,
        payload.media.filename || payload.media.fileName || `${payload.id}.${getExtensionFromMime(mimeType)}`,
        mimeType
      );
    }

    return { mediaUrl: null, mediaName: null, mimeType: null, fileSize: null };
  } catch (error) {
    console.error("Erro ao salvar mídia WAHA:", error);
    return { mediaUrl: null, mediaName: null, mimeType: null, fileSize: null };
  }
}

async function getProfilePicture(jid) {
  return null;
}

async function getGroupName(jid) {
  try {
    if (!jid || !jid.endsWith("@g.us")) return jid;

    if (groupNameCache[jid]) return groupNameCache[jid];

    const endpoints = [
      `${WAHA_URL}/api/${WAHA_SESSION}/groups/${encodeURIComponent(jid)}`,
      `${WAHA_URL}/api/groups/${encodeURIComponent(jid)}?session=${WAHA_SESSION}`,
      `${WAHA_URL}/api/groups/${encodeURIComponent(jid)}`
    ];

    for (const url of endpoints) {
      try {
        const response = await fetch(url);
        if (!response.ok) continue;

        const data = await response.json();

        const name =
          data.subject ||
          data.name ||
          data.groupName ||
          data?.groupMetadata?.subject ||
          data?.metadata?.subject ||
          null;

        if (name) {
          groupNameCache[jid] = name;
          await saveLidMap();
          return name;
        }
      } catch {}
    }

    return jid;
  } catch (error) {
    console.log("Erro ao buscar nome do grupo no WAHA:", error.message);
    return jid;
  }
}

async function getOrCreateConversation(jid, isGroup, displayName = null) {
  if (isGroup) {
    let groupChat = groupConversations.find(c => c.jid === jid);

    const groupName = displayName && displayName !== jid ? displayName : await getGroupName(jid);
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
      groupChat.name = groupName || groupChat.name || jid;
      groupChat.clientName = groupChat.name;
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
      phoneUnavailableReason: realPhone ? null : "Número real não disponível",
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
    clientChat.phoneUnavailableReason = realPhone ? null : "Número real não disponível";
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

async function markDeletedMessage(jid, deletedWaMessageId) {
  const internalJid = toInternalPhoneJid(jid);
  const list = isGroupJid(internalJid) ? groupConversations : clientConversations;
  const chat = list.find(c => c.jid === internalJid);

  if (!chat) return false;

  const message = chat.messages.find(m => m.waMessageId === deletedWaMessageId);

  if (message) {
    message.deletedInWhatsApp = true;
    message.preservedInSystem = true;
    message.deletedNotice = "Mensagem apagada no WhatsApp, preservada no sistema";
    message.updatedAt = new Date().toISOString();

    io.emit("mensagemApagada", { jid: internalJid, waMessageId: deletedWaMessageId, message, conversation: chat });
    io.emit("conversasAtualizadas", getConversationList());

    return true;
  }

  await saveMessage({
    jid: internalJid,
    sender: "sistema",
    senderName: "Sistema",
    text: "Uma mensagem foi apagada no WhatsApp, mas não foi encontrada no histórico local.",
    direction: "system",
    system: true
  });

  return false;
}

function detectarTipoMidia(payload = {}) {
  if (!payload?.hasMedia && !payload?.media) return "none";

  const mime =
    payload.media?.mimetype ||
    payload.media?.mimeType ||
    payload._data?.message?.imageMessage?.mimetype ||
    payload._data?.message?.audioMessage?.mimetype ||
    payload._data?.message?.videoMessage?.mimetype ||
    payload._data?.message?.documentMessage?.mimetype ||
    "";

  if (payload._data?.message?.imageMessage || mime.startsWith("image/")) return "image";
  if (payload._data?.message?.audioMessage || mime.startsWith("audio/")) return "audio";
  if (payload._data?.message?.videoMessage || mime.startsWith("video/")) return "video";
  if (payload._data?.message?.stickerMessage) return "sticker";
  if (payload._data?.message?.documentMessage || payload.media) return "document";

  return "document";
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
  if (payload._data?.broadcast === true) return;

  const isGroup = rawJid.endsWith("@g.us");

  let jid = toInternalPhoneJid(rawJid);
  let sender = jid;
  let senderName = payload._data?.pushName || payload.pushName || jid;
  let displayName = senderName;

  if (isGroup) {
    jid = rawJid;

    sender =
      payload.participant ||
      payload._data?.key?.participant ||
      rawJid;

    const participantAlt =
      payload._data?.key?.participantAlt ||
      null;

    if (participantAlt && isPhoneJid(participantAlt)) {
      await mapLidToPhone(sender, participantAlt);
      sender = toInternalPhoneJid(participantAlt);
    }

    senderName =
      payload._data?.pushName ||
      payload.pushName ||
      sender;

    displayName = await getGroupName(rawJid);
  } else if (altJid && isPhoneJid(altJid)) {
    await mapLidToPhone(rawJid, altJid);

    const telefone = normalizePhone(cleanJid(altJid));
    jid = `${telefone}@s.whatsapp.net`;
    sender = jid;
  }

  const text =
    payload.body ||
    payload._data?.message?.conversation ||
    payload._data?.message?.extendedTextMessage?.text ||
    payload._data?.message?.imageMessage?.caption ||
    payload._data?.message?.videoMessage?.caption ||
    payload._data?.message?.documentMessage?.caption ||
    "";

  const mediaType = detectarTipoMidia(payload);
  let mediaInfo = {
    mediaUrl: null,
    mediaName: null,
    mimeType: null,
    fileSize: null
  };

  if (mediaType !== "none") {
    mediaInfo = await downloadWahaMedia(payload);
  }

  await saveMessage({
    jid,
    sender,
    senderName,
    displayName,
    text,
    direction: "received",
    waMessageId: payload._data?.key?.id || payload.id,
    mediaType,
    mediaUrl: mediaInfo.mediaUrl,
    mediaName: mediaInfo.mediaName,
    mimeType: mediaInfo.mimeType,
    fileSize: mediaInfo.fileSize
  });

  console.log("✅ Mensagem WAHA salva:", {
    jid,
    sender,
    senderName,
    displayName,
    text,
    mediaType
  });
}

async function processarMensagemApagadaWaha(body) {
  try {
    const payload = body.payload || {};
    const rawJid = payload.from || payload.chatId || payload._data?.key?.remoteJid;
    const deletedId =
      payload.id ||
      payload.messageId ||
      payload._data?.protocolMessage?.key?.id ||
      payload._data?.key?.id;

    if (!rawJid || !deletedId) return;

    await markDeletedMessage(rawJid, deletedId);
  } catch (error) {
    console.error("Erro ao processar mensagem apagada WAHA:", error);
  }
}

app.use("/media", express.static(MEDIA_DIR));

app.get("/status", (req, res) => {
  res.json({
    status: connectionStatus,
    whatsappConectado: true,
    modo: "WAHA",
    wahaUrl: WAHA_URL,
    session: WAHA_SESSION,
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
  res.json({ lidToPhone, phoneToLid, groupNameCache });
});

app.post("/waha-webhook", async (req, res) => {
  try {
    console.log("📩 WAHA WEBHOOK RECEBIDO:");
    console.log(JSON.stringify(req.body, null, 2));

    if (req.body?.event === "message") {
      await processarMensagemWaha(req.body);
    }

    if (
      req.body?.event === "message.revoked" ||
      req.body?.event === "message.reaction" ||
      req.body?.event === "message.deleted"
    ) {
      await processarMensagemApagadaWaha(req.body);
    }

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

    const chatId = toWahaChatId(jid);

    const response = await fetch(`${WAHA_URL}/api/sendText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session: WAHA_SESSION,
        chatId,
        text: mensagem
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(500).json({
        erro: "Erro ao enviar mensagem pelo WAHA",
        detalhe: data
      });
    }

    await saveMessage({
      jid: toInternalPhoneJid(jid),
      sender: "sistema",
      senderName: "STU Atendimento",
      text: mensagem,
      direction: "sent",
      waMessageId: data?.id || data?.key?.id || null
    });

    res.json({ sucesso: true, jid: toInternalPhoneJid(jid), mensagem, waha: data });
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

    const buffer = Buffer.from(base64, "base64");

    const savedMedia = await saveBufferToMedia(
      buffer,
      fileName || `${Date.now()}.${getExtensionFromMime(mimeType || "")}`,
      mimeType || "application/octet-stream"
    );

    res.status(501).json({
      sucesso: false,
      erro: "Envio de mídia pelo WAHA ainda será ligado no próximo passo.",
      mediaLocalSalva: savedMedia,
      dica: "Recebimento de mídia já está preparado; envio será ajustado após confirmar endpoint correto do WAHA."
    });
  } catch (error) {
    console.error("Erro ao preparar mídia:", error);
    res.status(500).json({ erro: "Erro ao preparar mídia", detalhe: error.message });
  }
});

app.post("/desconectar", async (req, res) => {
  res.json({
    sucesso: false,
    mensagem: "Este serviço está em modo WAHA. A desconexão deve ser feita no serviço WAHA."
  });
});

app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>STU WhatsApp - WAHA</title>
        <style>
          body { font-family: Arial; background:#f4f7fb; padding:40px; }
          .card { background:white; padding:30px; border-radius:16px; max-width:620px; margin:auto; box-shadow:0 10px 30px #0001; text-align:center; }
          .status { font-size:18px; font-weight:bold; margin:20px; color:#166534; }
          a { display:block; margin:10px; color:#2563eb; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>STU Atendimento WhatsApp</h2>
          <div class="status">WAHA MODE ATIVO</div>
          <p>O WhatsApp agora é controlado pelo serviço WAHA.</p>
          <a href="/status">/status</a>
          <a href="/clientes">/clientes</a>
          <a href="/grupos">/grupos</a>
          <a href="/conversas">/conversas</a>
        </div>

        <script src="/socket.io/socket.io.js"></script>
        <script>
          const socket = io();

          socket.on("status", data => {
            console.log("status", data);
          });

          socket.on("novaMensagem", data => {
            console.log("novaMensagem", data);
          });

          socket.on("conversasAtualizadas", data => {
            console.log("conversasAtualizadas", data);
          });

          socket.emit("get-current");
        </script>
      </body>
    </html>
  `);
});

io.on("connection", (client) => {
  client.emit("status", { status: connectionStatus });
  client.emit("conversasAtualizadas", getConversationList());

  client.on("get-current", () => {
    client.emit("status", { status: connectionStatus });
    client.emit("conversasAtualizadas", getConversationList());
  });
});

server.listen(PORT, async () => {
  await ensureDirs();
  await loadLidMap();

  console.log("Servidor rodando na porta", PORT);
  console.log("WAHA MODE ATIVO - Baileys desativado");
  console.log("WAHA_URL:", WAHA_URL);
  console.log("WAHA_SESSION:", WAHA_SESSION);
});
