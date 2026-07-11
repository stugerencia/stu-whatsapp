import express from "express";
import http from "http";
import { Server } from "socket.io";
import fs from "fs/promises";
import path from "path";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

console.log("######## STU ATENDIMENTO WHATSAPP V7 - WAHA MODE ########");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json({ limit: "80mb" }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");

  const requestedHeaders = req.headers["access-control-request-headers"];

  res.header(
    "Access-Control-Allow-Headers",
    requestedHeaders || "Content-Type, Authorization, authorization"
  );

  res.header("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || "/app/data";
const MEDIA_DIR = process.env.MEDIA_DIR || "/app/data/media";
const LID_MAP_FILE = path.join(DATA_DIR, "lid_phone_map.json");
const CONVERSATIONS_FILE = path.join(DATA_DIR, "conversations.json");
const TAGS_FILE = path.join(DATA_DIR, "tags.json");
const QUICK_MESSAGES_FILE = path.join(DATA_DIR, "quick_messages.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const JWT_SECRET = process.env.JWT_SECRET || "stu_atendimento_whatsapp_secret_dev";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "12h";

const WAHA_URL =
  process.env.WAHA_URL || "https://devlikeaprowaha-production-8839.up.railway.app";
const WAHA_SESSION = process.env.WAHA_SESSION || "default";

async function startWahaSessionWithStore() {
  try {
    console.log("🔄 Iniciando sessão WAHA com NOWEB store...");

    const response = await fetch(`${WAHA_URL}/api/sessions/${WAHA_SESSION}/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        config: {
          noweb: {
            store: {
              enabled: true,
              fullSync: true
            }
          }
        }
      })
    });

    const data = await response.json().catch(() => ({}));

    console.log("✅ WAHA STORE START:", {
      ok: response.ok,
      status: response.status,
      data
    });
  } catch (error) {
    console.error("❌ Erro ao iniciar WAHA store:", error.message);
  }
}

let connectionStatus = "WAHA MODE ATIVO";
let lastQr = null;

let clientConversations = [];
let groupConversations = [];

let tags = [];
let quickMessages = [];

let users = [];

let lidToPhone = {};
let phoneToLid = {};
let groupNameCache = {};
let saveConversationsRunning = false;
let saveConversationsPending = false;

function getConversationList() {
  return [...clientConversations, ...groupConversations].sort((a, b) => {
    const dateA = new Date(a.lastMessageAt || a.createdAt || 0).getTime();
    const dateB = new Date(b.lastMessageAt || b.createdAt || 0).getTime();
    return dateB - dateA;
  });
}

function getBrazilPhoneVariants(phone = "") {
  const normalized = normalizePhone(phone);
  const variants = new Set();

  if (!normalized) return [];

  variants.add(normalized);

  // Brasil: 55 + DDD + número com nono dígito
  if (
    normalized.startsWith("55") &&
    normalized.length === 13 &&
    normalized[4] === "9"
  ) {
    variants.add(normalized.slice(0, 4) + normalized.slice(5));
  }

  // Brasil: 55 + DDD + número antigo sem o nono dígito
  if (
    normalized.startsWith("55") &&
    normalized.length === 12
  ) {
    variants.add(normalized.slice(0, 4) + "9" + normalized.slice(4));
  }

  return [...variants];
}

function getEquivalentJidCandidates(jid = "") {
  const candidates = new Set();

  if (!jid) return [];

  const internalJid = toInternalPhoneJid(jid);

  candidates.add(jid);
  candidates.add(internalJid);

  if (isGroupJid(internalJid)) {
    return [...candidates];
  }

  if (isLidJid(internalJid)) {
    const lid = cleanJid(internalJid);
    const mappedPhone = lidToPhone[lid];

    if (mappedPhone) {
      for (const phone of getBrazilPhoneVariants(mappedPhone)) {
        candidates.add(`${phone}@s.whatsapp.net`);
        candidates.add(`${phone}@c.us`);

        const mappedLid = phoneToLid[phone];
        if (mappedLid) {
          candidates.add(`${mappedLid}@lid`);
        }
      }
    }

    return [...candidates];
  }

  if (isPhoneJid(internalJid)) {
    const phone = cleanJid(internalJid);

    for (const variant of getBrazilPhoneVariants(phone)) {
      candidates.add(`${variant}@s.whatsapp.net`);
      candidates.add(`${variant}@c.us`);

      const mappedLid = phoneToLid[variant];
      if (mappedLid) {
        candidates.add(`${mappedLid}@lid`);
      }
    }
  }

  return [...candidates];
}

function findConversationByJid(jid = "") {
  const candidates = getEquivalentJidCandidates(jid);

  return getConversationList().find(conversa => {
    const conversationValues = new Set([
      conversa.jid,
      conversa.whatsappId,
      conversa.lid ? `${conversa.lid}@lid` : null,
      conversa.clientPhone
        ? `${normalizePhone(conversa.clientPhone)}@s.whatsapp.net`
        : null,
      conversa.realPhone
        ? `${normalizePhone(conversa.realPhone)}@s.whatsapp.net`
        : null,
      conversa.telefone
        ? `${normalizePhone(conversa.telefone)}@s.whatsapp.net`
        : null
    ].filter(Boolean));

    for (const value of conversationValues) {
      for (const equivalent of getEquivalentJidCandidates(value)) {
        conversationValues.add(equivalent);
      }
    }

    return candidates.some(candidate => conversationValues.has(candidate));
  });
}

function canSendInConversation(conversa) {
  if (!conversa) return false;

  if (isGroupJid(conversa.jid)) {
    return true;
  }

  if (conversa.conversationType === "grupo_operacional") {
    return true;
  }

  if (conversa.type === "grupo_operacional") {
    return true;
  }

  return conversa.status === "em_atendimento";
}

function getConversationListByUser(userName, role = "atendente") {
  const conversas = getConversationList();

  if (role === "admin") {
    return conversas;
  }

  return conversas.filter(conversa => {
    return (
      conversa.status === "nova" ||
      conversa.attendant === userName ||
      conversa.openedBy === userName ||
      conversa.finishedBy === userName
    );
  });
}

function emitConversationsToConnectedUsers() {
  for (const [socketId, socket] of io.sockets.sockets) {
    const userName = socket.data?.userName;
    const role = socket.data?.role || "atendente";

    if (userName) {
      socket.emit("conversasAtualizadas", getConversationListByUser(userName, role));
    } else {
      socket.emit("conversasAtualizadas", getConversationList());
    }
  }
}

function addConversationHistory(conversa, action, user, details = {}) {
  if (!conversa.history) {
    conversa.history = [];
  }

  conversa.history.push({
    action,
    user: user || "Sistema",
    date: new Date().toISOString(),
    details
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

async function loadConversations() {
  try {
    await ensureDirs();

    const raw = await fs.readFile(CONVERSATIONS_FILE, "utf-8");
    const data = JSON.parse(raw);

    clientConversations = data.clientConversations || [];
    groupConversations = data.groupConversations || [];

    console.log("Conversas carregadas:", {
      clientes: clientConversations.length,
      grupos: groupConversations.length
    });
  } catch {
    clientConversations = [];
    groupConversations = [];
  }
}

async function saveConversations() {
  if (saveConversationsRunning) {
    saveConversationsPending = true;
    return;
  }

  saveConversationsRunning = true;

  try {
    await ensureDirs();

    await fs.writeFile(
      CONVERSATIONS_FILE,
      JSON.stringify(
        {
          clientConversations,
          groupConversations
        },
        null,
        2
      )
    );

    console.log("💾 Conversas salvas");

  } catch (error) {
    console.error("Erro ao salvar conversas:", error);
  } finally {
    saveConversationsRunning = false;

    if (saveConversationsPending) {
      saveConversationsPending = false;
      await saveConversations();
    }
  }
}

async function loadTags() {
  try {
    await ensureDirs();

    const raw = await fs.readFile(TAGS_FILE, "utf-8");

    tags = JSON.parse(raw);

    console.log("Etiquetas carregadas:", tags.length);

  } catch {
    tags = [];
  }
}


async function saveTags() {
  try {
    await ensureDirs();

    await fs.writeFile(
      TAGS_FILE,
      JSON.stringify(tags, null, 2)
    );

    console.log("Etiquetas salvas");

  } catch (error) {
    console.error("Erro ao salvar etiquetas:", error);
  }
}

async function loadQuickMessages() {
  try {
    await ensureDirs();

    const raw = await fs.readFile(QUICK_MESSAGES_FILE, "utf-8");

    quickMessages = JSON.parse(raw);

    console.log("Mensagens rápidas carregadas:", quickMessages.length);

  } catch {
    quickMessages = [];
  }
}


async function saveQuickMessages() {
  try {
    await ensureDirs();

    await fs.writeFile(
      QUICK_MESSAGES_FILE,
      JSON.stringify(quickMessages, null, 2)
    );

    console.log("Mensagens rápidas salvas");

  } catch (error) {
    console.error("Erro ao salvar mensagens rápidas:", error);
  }
}

async function loadUsers() {
  try {
    await ensureDirs();

    const raw = await fs.readFile(USERS_FILE, "utf-8");

    users = JSON.parse(raw);

    console.log("Usuários carregados:", users.length);

  } catch {
    users = [];
  }
}


async function saveUsers() {
  try {
    await ensureDirs();

    await fs.writeFile(
      USERS_FILE,
      JSON.stringify(users, null, 2)
    );

    console.log("Usuários salvos");

  } catch (error) {
    console.error("Erro ao salvar usuários:", error);
  }
}

async function ensureDefaultUsers() {
  if (users.length > 0) return;

  const defaultPassword = "123456";

  users = [
    {
      id: 1,
      name: "Samuel",
      email: "samuel@samutransportes.com.br",
      role: "admin",
      active: true,
      passwordHash: await bcrypt.hash(defaultPassword, 10),
      createdAt: new Date().toISOString()
    },
    {
      id: 2,
      name: "Renata",
      email: "renata.pereira@samutransportes.com.br",
      role: "admin",
      active: true,
      passwordHash: await bcrypt.hash(defaultPassword, 10),
      createdAt: new Date().toISOString()
    },
    {
      id: 3,
      name: "Allice",
      email: "allice.mayra@samutransportes.com.br",
      role: "admin",
      active: true,
      passwordHash: await bcrypt.hash(defaultPassword, 10),
      createdAt: new Date().toISOString()
    },
    {
      id: 4,
      name: "Maria Eduarda",
      email: "atendimento02@samutransportes.com.br",
      role: "atendente",
      active: true,
      passwordHash: await bcrypt.hash(defaultPassword, 10),
      createdAt: new Date().toISOString()
    },
    {
      id: 5,
      name: "Bruna",
      email: "atendimento03@samutransportes.com.br",
      role: "atendente",
      active: true,
      passwordHash: await bcrypt.hash(defaultPassword, 10),
      createdAt: new Date().toISOString()
    },
    {
      id: 6,
      name: "Carolinne",
      email: "atendimento04@samutransportes.com.br",
      role: "atendente",
      active: true,
      passwordHash: await bcrypt.hash(defaultPassword, 10),
      createdAt: new Date().toISOString()
    }
  ];

  await saveUsers();

  console.log("Usuários padrão criados com senha inicial 123456");
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    active: user.active,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role
    },
    JWT_SECRET,
    {
      expiresIn: JWT_EXPIRES_IN
    }
  );
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({
      sucesso: false,
      erro: "Token não informado"
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    req.user = decoded;

    next();

  } catch (error) {
    return res.status(403).json({
      sucesso: false,
      erro: "Token inválido ou expirado"
    });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({
      sucesso: false,
      erro: "Acesso permitido apenas para administradores"
    });
  }

  next();
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

async function sincronizarFotosChatsOverview() {
  try {
    console.log("🔄 Sincronizando fotos pelo WAHA chats/overview...");

    const response = await fetch(
      `${WAHA_URL}/api/${WAHA_SESSION}/chats/overview?merge=true&limit=200&offset=0`
    );

    const chats = await response.json().catch(() => []);

    if (!response.ok || !Array.isArray(chats)) {
      console.log("⚠️ WAHA chats/overview não retornou lista válida");
      return;
    }

    let atualizadas = 0;

    for (const item of chats) {
      const chatId = item.id;
      const picture = item.picture || null;

      if (!chatId || !picture) continue;

      const internalJid = toInternalPhoneJid(chatId);

      const conversa = getConversationList().find(c =>
        c.jid === internalJid ||
        c.jid === chatId ||
        c.whatsappId === chatId ||
        c.whatsappId === internalJid
      );

      if (!conversa) continue;

      if (conversa.profilePictureUrl !== picture) {
        conversa.profilePictureUrl = picture;
        conversa.avatarUrl = picture;
        conversa.picture = picture;
        conversa.photo = picture;
        conversa.contactPhoto = picture;
        conversa.updatedAt = new Date().toISOString();
        atualizadas++;
      }
    }

    if (atualizadas > 0) {
      await saveConversations();
      emitConversationsToConnectedUsers();
    }

    console.log("✅ Fotos sincronizadas pelo chats/overview:", atualizadas);

  } catch (error) {
    console.error("❌ Erro ao sincronizar fotos pelo chats/overview:", error.message);
  }
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
        profilePictureUrl: null,
        avatarUrl: null,
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
    }

    return groupChat;
  }

  let clientChat = findConversationByJid(jid);

  const lid = isLidJid(jid) ? cleanJid(jid) : null;
  const realPhone = findMappedPhone(jid);
  const clientPhone = realPhone || cleanJid(jid);
  const clientName = displayName || clientPhone;
  

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
      profilePictureUrl: null,
      avatarUrl: null,
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

    if (!clientChat.clientPhone) {
  clientChat.clientPhone = clientPhone;
}

if (realPhone) {
  clientChat.realPhone = realPhone;
  clientChat.telefone = realPhone;
  clientChat.phoneUnavailableReason = null;
}

if (lid) {
  clientChat.lid = lid;
}

if (!clientChat.realPhone && !clientChat.telefone) {
  clientChat.phoneUnavailableReason =
    clientChat.phoneUnavailableReason || "Número real não disponível";
}

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
  system = false,
  forwarded = false
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
    forwarded,
    deletedInWhatsApp: false,
    preservedInSystem: true
  };

  chat.messages.push(newMessage);
  await saveConversations();

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

  for (const [socketId, socket] of io.sockets.sockets) {
  const userName = socket.data?.userName;
  const role = socket.data?.role || "atendente";

  let conversasPermitidas;

  if (userName) {
    conversasPermitidas = getConversationListByUser(userName, role);
  } else {
    conversasPermitidas = getConversationList();
  }

  const podeVerConversa = conversasPermitidas.some(c => c.jid === chat.jid);

  if (podeVerConversa) {
    socket.emit("novaMensagem", {
      conversation: chat,
      message: newMessage,
      conversas: conversasPermitidas
    });

    socket.emit("conversasAtualizadas", conversasPermitidas);
  }
}
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
   emitConversationsToConnectedUsers();

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

const conversaRecebida = await getOrCreateConversation(jid, isGroup, displayName);

if (!isGroup && conversaRecebida.status === "finalizada") {
  conversaRecebida.status = "nova";
  conversaRecebida.attendant = null;
  conversaRecebida.finishedAt = null;
  conversaRecebida.finishedBy = null;

  addConversationHistory(conversaRecebida, "reabriu", "Sistema", {
    motivo: "Nova mensagem recebida."
  });
}

await saveMessage({
    jid,
    sender,
    senderName,
    displayName,
    text,
    direction: "received",
    waMessageId: payload.id || payload._data?.key?.id,
    mediaType,
    mediaUrl: mediaInfo.mediaUrl,
    mediaName: mediaInfo.mediaName,
    mimeType: mediaInfo.mimeType,
    fileSize: mediaInfo.fileSize
  });

  console.log("✅ Mensagem salva:", {
  tipo: isGroup ? "grupo" : "cliente",
  nome: displayName,
  midia: mediaType
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

app.use(
  "/media",
  express.static(MEDIA_DIR, {
    maxAge: "30d",
    immutable: true
  })
);

app.get("/download/:fileName", async (req, res) => {
  try {
    const fileName = req.params.fileName;

    if (!fileName || fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
      return res.status(400).send("Arquivo inválido");
    }

    const filePath = path.join(MEDIA_DIR, fileName);

    await fs.access(filePath);

    return res.download(filePath, fileName);
  } catch (error) {
    console.error("Erro ao baixar arquivo:", error);
    return res.status(404).send("Arquivo não encontrado");
  }
});

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

app.get("/usuarios", authenticateToken, (req, res) => {
  res.json(users.map(publicUser));
});

app.post("/criar-usuario", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, email, role, password } = req.body;

    if (!name || !email || !role || !password) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe nome, e-mail, perfil e senha"
      });
    }

    const exists = users.find(
      user => user.email.toLowerCase() === String(email).toLowerCase()
    );

    if (exists) {
      return res.status(400).json({
        sucesso: false,
        erro: "Já existe usuário com esse e-mail"
      });
    }

    const user = {
      id: Date.now(),
      name,
      email,
      role,
      active: true,
      passwordHash: await bcrypt.hash(password, 10),
      createdAt: new Date().toISOString(),
      createdBy: req.user.name
    };

    users.push(user);
    await saveUsers();

    return res.json({
      sucesso: true,
      user: publicUser(user)
    });

  } catch (error) {
    console.error("Erro ao criar usuário:", error);

    return res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

app.post("/editar-usuario", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id, name, email, role } = req.body;

    if (!id) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe o id do usuário"
      });
    }

    const user = users.find(u => String(u.id) === String(id));

    if (!user) {
      return res.status(404).json({
        sucesso: false,
        erro: "Usuário não encontrado"
      });
    }

    if (name) user.name = name;
    if (email) user.email = email;
    if (role) user.role = role;

    user.updatedAt = new Date().toISOString();
    user.updatedBy = req.user.name;

    await saveUsers();

    return res.json({
      sucesso: true,
      user: publicUser(user)
    });

  } catch (error) {
    console.error("Erro ao editar usuário:", error);
    return res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

app.post("/alterar-senha", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id, password } = req.body;

    if (!id || !password) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe id e nova senha"
      });
    }

    const user = users.find(u => String(u.id) === String(id));

    if (!user) {
      return res.status(404).json({
        sucesso: false,
        erro: "Usuário não encontrado"
      });
    }

    user.passwordHash = await bcrypt.hash(password, 10);
    user.passwordChangedAt = new Date().toISOString();
    user.passwordChangedBy = req.user.name;

    await saveUsers();

    return res.json({
      sucesso: true,
      user: publicUser(user)
    });

  } catch (error) {
    console.error("Erro ao alterar senha:", error);
    return res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

app.post("/desativar-usuario", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.body;

    const user = users.find(u => String(u.id) === String(id));

    if (!user) {
      return res.status(404).json({
        sucesso: false,
        erro: "Usuário não encontrado"
      });
    }

    user.active = false;
    user.updatedAt = new Date().toISOString();
    user.updatedBy = req.user.name;

    await saveUsers();

    return res.json({
      sucesso: true,
      user: publicUser(user)
    });

  } catch (error) {
    return res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

app.post("/ativar-usuario", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.body;

    const user = users.find(u => String(u.id) === String(id));

    if (!user) {
      return res.status(404).json({
        sucesso: false,
        erro: "Usuário não encontrado"
      });
    }

    user.active = true;
    user.updatedAt = new Date().toISOString();
    user.updatedBy = req.user.name;

    await saveUsers();

    return res.json({
      sucesso: true,
      user: publicUser(user)
    });

  } catch (error) {
    return res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe e-mail e senha"
      });
    }
    
    const user = users.find(u =>
      u.email.toLowerCase() === String(email).toLowerCase()
    );

    if (!user) {
      return res.status(401).json({
        sucesso: false,
        erro: "Usuário ou senha inválidos"
      });
    }

    if (user.active === false) {
      return res.status(403).json({
        sucesso: false,
        erro: "Usuário inativo"
      });
    }

    const senhaConfere = await bcrypt.compare(password, user.passwordHash);

    if (!senhaConfere) {
      return res.status(401).json({
        sucesso: false,
        erro: "Usuário ou senha inválidos"
      });
    }

    user.lastLoginAt = new Date().toISOString();
    await saveUsers();

    const token = generateToken(user);

    return res.json({
      sucesso: true,
      token,
      user: publicUser(user)
    });

  } catch (error) {
    console.error("Erro no login:", error);
    return res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

app.get("/conversas-usuario", (req, res) => {
  const userName = req.query.userName;
  const role = req.query.role || "atendente";

  if (!userName) {
    return res.status(400).json({
      sucesso: false,
      erro: "Informe userName"
    });
  }

  const conversas = getConversationListByUser(userName, role);

  res.json({
    sucesso: true,
    userName,
    role,
    total: conversas.length,
    conversas
  });
});
app.post("/marcar-lida", authenticateToken, async (req, res) => {
  try {
    const { jid } = req.body;

    if (!jid) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe o jid da conversa"
      });
    }

    const conversa = getConversationList().find(c => c.jid === jid);

    if (!conversa) {
      return res.status(404).json({
        sucesso: false,
        erro: "Conversa não encontrada"
      });
    }

    conversa.unreadCount = 0;

    conversa.messages.forEach(msg => {
      msg.read = true;
    });

    await saveConversations();

    emitConversationsToConnectedUsers();

    return res.json({
      sucesso: true,
      jid,
      unreadCount: 0
    });

  } catch (error) {
    console.error("Erro ao marcar conversa como lida:", error);
    return res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

app.post("/assumir-conversa", authenticateToken, async (req, res) => {
  try {
    const { jid, attendant } = req.body;

    if (!jid) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe o jid da conversa"
      });
    }

    if (!attendant) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe o nome do atendente"
      });
    }

    const conversa = getConversationList().find(c => c.jid === jid);

    if (!conversa) {
      return res.status(404).json({
        sucesso: false,
        erro: "Conversa não encontrada"
      });
    }

    conversa.status = "em_atendimento";
    conversa.attendant = attendant;
    conversa.openedAt = conversa.openedAt || new Date().toISOString();
    conversa.openedBy = attendant;
    conversa.unreadCount = 0;
    
addConversationHistory(conversa, "assumiu", attendant, {
  status: "em_atendimento"
});

    conversa.messages.forEach(msg => {
      msg.read = true;
    });

    await saveConversations();

    emitConversationsToConnectedUsers();

    return res.json({
      sucesso: true,
      jid,
      status: conversa.status,
      attendant: conversa.attendant,
      openedAt: conversa.openedAt
    });

  } catch (error) {
    console.error("Erro ao assumir conversa:", error);
    return res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

app.post("/finalizar-conversa", authenticateToken, async (req, res) => {
  try {
    const { jid, attendant } = req.body;

    if (!jid) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe o jid da conversa"
      });
    }

    const conversa = getConversationList().find(c => c.jid === jid);

    if (!conversa) {
      return res.status(404).json({
        sucesso: false,
        erro: "Conversa não encontrada"
      });
    }

    conversa.status = "finalizada";
    conversa.finishedAt = new Date().toISOString();
    conversa.finishedBy = attendant || conversa.attendant || "Sistema";
    conversa.unreadCount = 0;

    addConversationHistory(conversa, "finalizou", conversa.finishedBy, {
      status: "finalizada"
    });

    conversa.messages.forEach(msg => {
      msg.read = true;
    });

    await saveConversations();

   emitConversationsToConnectedUsers();

    return res.json({
      sucesso: true,
      jid,
      status: conversa.status,
      finishedBy: conversa.finishedBy,
      finishedAt: conversa.finishedAt
    });

  } catch (error) {
    console.error("Erro ao finalizar conversa:", error);
    return res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

app.post("/transferir-conversa", authenticateToken, async (req, res) => {
  try {
    const { jid, fromAttendant, toAttendant } = req.body;

    if (!jid) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe o jid da conversa"
      });
    }

    if (!toAttendant) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe o atendente de destino"
      });
    }

    const conversa = getConversationList().find(c => c.jid === jid);

    if (!conversa) {
      return res.status(404).json({
        sucesso: false,
        erro: "Conversa não encontrada"
      });
    }

    const atendenteOrigem = fromAttendant || conversa.attendant || "Sistema";

    conversa.status = "em_atendimento";
    conversa.attendant = toAttendant;
    conversa.transferredAt = new Date().toISOString();
    conversa.transferredBy = atendenteOrigem;
    conversa.transferredTo = toAttendant;

    if (!conversa.transfers) {
      conversa.transfers = [];
    }

    conversa.transfers.push({
      from: atendenteOrigem,
      to: toAttendant,
      date: conversa.transferredAt
    });

    addConversationHistory(conversa, "transferiu", atendenteOrigem, {
      from: atendenteOrigem,
      to: toAttendant,
      status: "em_atendimento"
    });

    await saveConversations();

    emitConversationsToConnectedUsers();

    return res.json({
      sucesso: true,
      jid,
      status: conversa.status,
      attendant: conversa.attendant,
      transferredBy: conversa.transferredBy,
      transferredTo: conversa.transferredTo,
      transferredAt: conversa.transferredAt
    });

  } catch (error) {
    console.error("Erro ao transferir conversa:", error);
    return res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

app.get("/lid-map", (req, res) => {
  res.json({ lidToPhone, phoneToLid, groupNameCache });
});

app.get("/mensagens-rapidas", (req, res) => {
  res.json(quickMessages);
});

app.post("/criar-mensagem-rapida", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { title, shortcut, text } = req.body;

    if (!title || !text) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe título e texto da mensagem rápida"
      });
    }

    const exists = quickMessages.find(m =>
      m.title.toLowerCase() === title.toLowerCase() ||
      (shortcut && m.shortcut?.toLowerCase() === shortcut.toLowerCase())
    );

    if (exists) {
      return res.status(400).json({
        sucesso: false,
        erro: "Já existe uma mensagem rápida com esse título ou atalho"
      });
    }

    const quickMessage = {
      id: Date.now(),
      title,
      shortcut: shortcut || "",
      text,
      createdAt: new Date().toISOString()
    };

    quickMessages.push(quickMessage);
    await saveQuickMessages();

    return res.json({
      sucesso: true,
      quickMessage
    });

  } catch (error) {
    console.error("Erro ao criar mensagem rápida:", error);
    return res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

app.post("/editar-mensagem-rapida", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id, title, shortcut, text } = req.body;

    if (!id) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe o id da mensagem rápida"
      });
    }

    const quickMessage = quickMessages.find(m => String(m.id) === String(id));

    if (!quickMessage) {
      return res.status(404).json({
        sucesso: false,
        erro: "Mensagem rápida não encontrada"
      });
    }

    if (title) quickMessage.title = title;
    if (shortcut !== undefined) quickMessage.shortcut = shortcut;
    if (text) quickMessage.text = text;

    quickMessage.updatedAt = new Date().toISOString();

    await saveQuickMessages();

    return res.json({
      sucesso: true,
      quickMessage
    });

  } catch (error) {
    console.error("Erro ao editar mensagem rápida:", error);
    return res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

app.post("/excluir-mensagem-rapida", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.body;

    if (!id) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe o id da mensagem rápida"
      });
    }

    quickMessages = quickMessages.filter(m => String(m.id) !== String(id));

    await saveQuickMessages();

    return res.json({
      sucesso: true,
      id
    });

  } catch (error) {
    console.error("Erro ao excluir mensagem rápida:", error);
    return res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

app.get("/etiquetas", (req, res) => {
  res.json(tags);
});

app.post("/criar-etiqueta", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, color } = req.body;

    if (!name) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe o nome da etiqueta"
      });
    }

    const exists = tags.find(t =>
      t.name.toLowerCase() === name.toLowerCase()
    );

    if (exists) {
      return res.status(400).json({
        sucesso: false,
        erro: "Já existe uma etiqueta com esse nome"
      });
    }

    const tag = {
      id: Date.now(),
      name,
      color: color || "#2563eb",
      createdAt: new Date().toISOString()
    };

    tags.push(tag);
    await saveTags();

    return res.json({
      sucesso: true,
      tag
    });

  } catch (error) {
    console.error("Erro ao criar etiqueta:", error);
    return res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

app.post("/editar-etiqueta", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id, name, color } = req.body;

    if (!id) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe o id da etiqueta"
      });
    }

    const tag = tags.find(t => String(t.id) === String(id));

    if (!tag) {
      return res.status(404).json({
        sucesso: false,
        erro: "Etiqueta não encontrada"
      });
    }

    if (name) tag.name = name;
    if (color) tag.color = color;
    tag.updatedAt = new Date().toISOString();

    await saveTags();

    return res.json({
      sucesso: true,
      tag
    });

  } catch (error) {
    console.error("Erro ao editar etiqueta:", error);
    return res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

app.post("/excluir-etiqueta", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.body;

    if (!id) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe o id da etiqueta"
      });
    }

    tags = tags.filter(t => String(t.id) !== String(id));

    getConversationList().forEach(conversa => {
      conversa.tagIds = (conversa.tagIds || []).filter(
        tagId => String(tagId) !== String(id)
      );
    });

    await saveTags();
    await saveConversations();

    emitConversationsToConnectedUsers();

    return res.json({
      sucesso: true,
      id
    });

  } catch (error) {
    console.error("Erro ao excluir etiqueta:", error);
    return res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

app.post("/adicionar-etiqueta", async (req, res) => {
  try {
    const { jid, tagId } = req.body;

    if (!jid || !tagId) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe jid e tagId"
      });
    }

    const conversa = getConversationList().find(c => c.jid === jid);
    const tag = tags.find(t => String(t.id) === String(tagId));

    if (!conversa) {
      return res.status(404).json({
        sucesso: false,
        erro: "Conversa não encontrada"
      });
    }

    if (!tag) {
      return res.status(404).json({
        sucesso: false,
        erro: "Etiqueta não encontrada"
      });
    }

    if (!conversa.tagIds) conversa.tagIds = [];

    if (!conversa.tagIds.some(id => String(id) === String(tagId))) {
      conversa.tagIds.push(tag.id);
    }

    addConversationHistory(conversa, "adicionou_etiqueta", "Sistema", {
      tagId: tag.id,
      tagName: tag.name
    });

    await saveConversations();

    emitConversationsToConnectedUsers();

    return res.json({
      sucesso: true,
      jid,
      tagIds: conversa.tagIds
    });

  } catch (error) {
    console.error("Erro ao adicionar etiqueta:", error);
    return res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

app.post("/remover-etiqueta", async (req, res) => {
  try {
    const { jid, tagId } = req.body;

    if (!jid || !tagId) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe jid e tagId"
      });
    }

    const conversa = getConversationList().find(c => c.jid === jid);

    if (!conversa) {
      return res.status(404).json({
        sucesso: false,
        erro: "Conversa não encontrada"
      });
    }

    conversa.tagIds = (conversa.tagIds || []).filter(
      id => String(id) !== String(tagId)
    );

    addConversationHistory(conversa, "removeu_etiqueta", "Sistema", {
      tagId
    });

    await saveConversations();

    emitConversationsToConnectedUsers();

    return res.json({
      sucesso: true,
      jid,
      tagIds: conversa.tagIds
    });

  } catch (error) {
    console.error("Erro ao remover etiqueta:", error);
    return res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

app.post("/waha-webhook", async (req, res) => {
  try {
        const payload = req.body?.payload || {};
    const from = payload.from || payload._data?.key?.remoteJid;
   
    if (from === "status@broadcast" || payload._data?.broadcast === true) {
      console.log("ℹ️ Status do WhatsApp ignorado");
      return res.json({
        sucesso: true,
        ignorado: "status_broadcast"
      });
    }
    console.log("📩 WAHA:", {
  event: req.body?.event,
  from: req.body?.payload?.from,
  name: req.body?.payload?._data?.pushName,
  hasMedia: req.body?.payload?.hasMedia,
  type: req.body?.payload?.media?.mimetype || "text"
});

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

app.post("/enviar", authenticateToken, async (req, res) => {
  try {
    const { jid, mensagem, quotedMessage } = req.body;

    if (!jid || !mensagem) {
  return res.status(400).json({ erro: "Informe jid e mensagem" });
}

const internalJid = toInternalPhoneJid(jid);

let conversa = findConversationByJid(internalJid);

if (!conversa) {
  conversa = await getOrCreateConversation(
    internalJid,
    isGroupJid(internalJid),
    cleanJid(internalJid)
  );

  conversa.status = "em_atendimento";
  conversa.attendant = req.user?.name || "Sistema";
  conversa.openedAt = new Date().toISOString();
  conversa.openedBy = conversa.attendant;
  conversa.unreadCount = 0;

  addConversationHistory(conversa, "criou_conversa", conversa.attendant, {
    motivo: "Nova conversa iniciada manualmente."
  });

  await saveConversations();
}

if (!canSendInConversation(conversa)) {
  const isSystemMessage =
    String(mensagem || "").includes("seu atendimento foi finalizado") ||
    String(mensagem || "").includes("Obrigado pelo contato") ||
    String(mensagem || "").includes("Bem-vindo") ||
    String(mensagem || "").includes("Olá");

  const isFinalizationMessage =
  String(mensagem || "").includes("seu atendimento foi finalizado") ||
  String(mensagem || "").includes("Obrigado pelo contato");

const isReopenMessage =
  String(mensagem || "").includes("Bem-vindo") ||
  String(mensagem || "").includes("Olá");

if (conversa.status === "finalizada" && isReopenMessage && !isFinalizationMessage) {
  conversa.status = "em_atendimento";
  conversa.attendant = req.user?.name || conversa.attendant || "Sistema";
  conversa.openedAt = new Date().toISOString();
  conversa.openedBy = conversa.attendant;

  addConversationHistory(conversa, "reabriu", conversa.attendant, {
    motivo: "Reabertura manual com envio de mensagem."
  });

  await saveConversations();
} else if (!isSystemMessage) {
    return res.status(403).json({
      sucesso: false,
      erro: "Assuma a conversa antes de enviar mensagens."
    });
  }
}

const chatId = quotedMessage?.waMessageId?.includes("_")
  ? quotedMessage.waMessageId.split("_")[1]
  : toWahaChatId(conversa.jid);

console.log("ENVIANDO PARA WAHA:", {
  session: WAHA_SESSION,
  chatId,
  mensagem,
  quotedMessage,
reply_to: quotedMessage?.waMessageId || undefined
});    
    
    const response = await fetch(`${WAHA_URL}/api/sendText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
  session: WAHA_SESSION,
  chatId,
  id: null,
  reply_to: quotedMessage?.waMessageId || null,
  text: mensagem,
  linkPreview: false,
  linkPreviewHighQuality: false
  })
});

    const data = await response.json().catch(() => ({}));
  console.log("RESPOSTA WAHA SENDTEXT:", {
  ok: response.ok,
  status: response.status,
  data
});

    if (!response.ok) {
      return res.status(500).json({
        erro: "Erro ao enviar mensagem pelo WAHA",
        detalhe: data
      });
    }

    await saveMessage({
      jid: conversa.jid,
      sender: "sistema",
      senderName: "STU Atendimento",
      text: mensagem,
      direction: "sent",
      waMessageId: data?.id || data?.key?.id || null
    });

  res.json({
     sucesso: true,
     jid: conversa.jid,
     mensagem,
     waha: data
});
    
  } catch (error) {
    console.error("Erro ao enviar mensagem:", error);
    res.status(500).json({ erro: "Erro ao enviar mensagem", detalhe: error.message });
  }
});

app.post("/encaminhar-mensagem", authenticateToken, async (req, res) => {
  try {
    const { message, destinations } = req.body;

    if (!message) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe a mensagem para encaminhar"
      });
    }

    if (!Array.isArray(destinations) || destinations.length === 0) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe ao menos um destino"
      });
    }

    const messageId =
      message.waMessageId ||
      message.messageId ||
      null;

    if (!messageId) {
      return res.status(400).json({
        sucesso: false,
        erro: "A mensagem original não possui waMessageId para encaminhamento"
      });
    }

    const texto =
      message.text ||
      message.body ||
      "";

    const mediaType =
      message.mediaType && message.mediaType !== "none"
        ? message.mediaType
        : "none";

    const resultados = [];

console.log("========== INÍCIO ENCAMINHAMENTO ==========");
console.log("Destinos:", destinations);
console.log("Mensagem:", {
    id: message.id,
    waMessageId: message.waMessageId,
    mediaType: message.mediaType,
    text: message.text
});

    for (const destino of destinations) {

      if (!jidDestino) {
        resultados.push({
          destino,
          sucesso: false,
          erro: "Destino sem JID"
        });

        continue;
      }

      const conversaDestino = findConversationByJid(jidDestino);
      console.log("Conversa encontrada:", !!conversaDestino);

if (conversaDestino) {
    console.log({
        jid: conversaDestino.jid,
        status: conversaDestino.status,
        attendant: conversaDestino.attendant,
        isGroup: isGroupJid(conversaDestino.jid)
    });
}

      if (!conversaDestino) {
        resultados.push({
          destino: jidDestino,
          sucesso: false,
          erro: "Conversa de destino não encontrada"
        });

        continue;
      }

      console.log(
    "Pode enviar:",
    conversaDestino
        ? canSendInConversation(conversaDestino)
        : false
);
      if (!canSendInConversation(conversaDestino)) {
        resultados.push({
          destino: conversaDestino.jid,
          sucesso: false,
          erro: "Conversa de destino precisa estar assumida antes do encaminhamento"
        });

        continue;
      }

      const chatId = toWahaChatId(conversaDestino.jid);

      const response = await fetch(`${WAHA_URL}/api/forwardMessage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          session: WAHA_SESSION,
          chatId,
          messageId
        })
      });

      console.log("HTTP WAHA:", response.status);
      
      const data = await response.json().catch(() => ({}));

      console.log("Resposta WAHA:");
      console.dir(data, { depth: null });
      
      if (!response.ok) {
        resultados.push({
          destino: conversaDestino.jid,
          sucesso: false,
          erro: "Erro ao encaminhar pelo WAHA",
          status: response.status,
          detalhe: data
        });

        continue;
      }

      await saveMessage({
        jid: conversaDestino.jid,
        sender: "sistema",
        senderName: "STU Atendimento",
        text: texto,
        direction: "sent",
        waMessageId:
          data?.id ||
          data?.key?.id ||
          data?.messageId ||
          null,
        mediaType,
        mediaUrl: message.mediaUrl || null,
        mediaName: message.mediaName || null,
        mimeType: message.mimeType || null,
        fileSize: message.fileSize || null,
        forwarded: true
      });

      addConversationHistory(
        conversaDestino,
        "encaminhou_mensagem",
        req.user?.name || "Sistema",
        {
          origemJid:
            message.jid ||
            message.sourceJid ||
            null,
          mensagemOriginalId:
            message.id ||
            message.waMessageId ||
            null,
          tipo:
            mediaType !== "none"
              ? mediaType
              : "texto"
        }
      );

      resultados.push({
        destino: conversaDestino.jid,
        sucesso: true,
        tipo:
          mediaType !== "none"
            ? mediaType
            : "texto",
        waha: data
      });
    }

    const enviados = resultados.filter(
      item => item.sucesso === true
    );

    const falhas = resultados.filter(
      item => item.sucesso !== true
    );

    if (enviados.length === 0) {
      return res.status(502).json({
        sucesso: false,
        erro: "Não foi possível encaminhar a mensagem",
        total: destinations.length,
        enviados: 0,
        falhas: falhas.length,
        resultados
      });
    }

    await saveConversations();
emitConversationsToConnectedUsers();

console.log("========== RESULTADO FINAL ==========");
console.dir(resultados, { depth: null });

return res.json({
    sucesso: falhas.length === 0,
    parcial: falhas.length > 0,
    total: destinations.length,
    enviados: enviados.length,
    falhas: falhas.length,
    resultados
});

  } catch (error) {
    console.error("Erro em /encaminhar-mensagem:", error);

    return res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

app.post("/enviar-midia", authenticateToken, async (req, res) => {
  try {
    const { jid, mediaType, base64, mimeType, fileName, caption } = req.body;

    if (!jid || !mediaType || !base64) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe jid, mediaType e base64"
      });
    }

    const conversa = findConversationByJid(jid);

    if (!canSendInConversation(conversa)) {
      return res.status(403).json({
        sucesso: false,
        erro: "Assuma a conversa antes de enviar anexos."
      });
    }

    const chatId = toWahaChatId(conversa.jid);
    const finalMimeType = mimeType || "application/octet-stream";
    const finalFileName =
      fileName || `${Date.now()}.${getExtensionFromMime(finalMimeType)}`;

    const buffer = Buffer.from(base64, "base64");

    const savedMedia = await saveBufferToMedia(
      buffer,
      finalFileName,
      finalMimeType
    );

    let endpoint = "/api/sendFile";

    if (mediaType === "image" || finalMimeType.startsWith("image/")) {
      endpoint = "/api/sendImage";
    } else if (mediaType === "video" || finalMimeType.startsWith("video/")) {
      endpoint = "/api/sendVideo";
    }

    const payload = {
      session: WAHA_SESSION,
      chatId,
      file: {
        mimetype: finalMimeType,
        filename: finalFileName,
        data: base64
      },
      caption: caption || ""
    };

    let response = await fetch(`${WAHA_URL}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    let data = await response.json().catch(() => ({}));

    if (!response.ok && endpoint !== "/api/sendFile") {
      response = await fetch(`${WAHA_URL}/api/sendFile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      data = await response.json().catch(() => ({}));
    }

    if (!response.ok) {
      return res.status(500).json({
        sucesso: false,
        erro: "Erro ao enviar mídia pelo WAHA",
        detalhe: data
      });
    }

    await saveMessage({
      jid: conversa.jid,
      sender: "sistema",
      senderName: "STU Atendimento",
      text: caption || "",
      direction: "sent",
      waMessageId: data?.id || data?.key?.id || data?.messageId || null,
      mediaType,
      mediaUrl: savedMedia.mediaUrl,
      mediaName: savedMedia.mediaName,
      mimeType: savedMedia.mimeType,
      fileSize: savedMedia.fileSize
    });

    return res.json({
      sucesso: true,
      jid: conversa.jid,
      mediaType,
      media: savedMedia,
      waha: data
    });

  } catch (error) {
    console.error("Erro ao enviar mídia:", error);
    return res.status(500).json({
      sucesso: false,
      erro: "Erro ao enviar mídia",
      detalhe: error.message
    });
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

  client.on("authenticate", ({ token }) => {
    try {
      if (!token) {
        client.emit("auth_error", {
          sucesso: false,
          erro: "Token não informado"
        });
        return;
      }

      const decoded = jwt.verify(token, JWT_SECRET);

      client.data.userName = decoded.name;
      client.data.role = decoded.role;
      client.data.userId = decoded.id;
      client.data.email = decoded.email;

      client.emit("auth_success", {
        sucesso: true,
        user: decoded
      });

      client.emit(
        "conversasAtualizadas",
        getConversationListByUser(decoded.name, decoded.role)
      );

    } catch (error) {
      client.emit("auth_error", {
        sucesso: false,
        erro: "Token inválido ou expirado"
      });
    }
  });

  client.on("get-current", () => {
    client.emit("status", { status: connectionStatus });

    if (client.data?.userName) {
      client.emit(
        "conversasAtualizadas",
        getConversationListByUser(client.data.userName, client.data.role)
      );
    } else {
      client.emit("auth_error", {
        sucesso: false,
        erro: "Socket não autenticado"
      });
    }
  });
});

server.listen(PORT, async () => {
  
  await ensureDirs();
  await loadConversations();
  await loadLidMap();
  await loadTags();
  await loadQuickMessages();
  await loadUsers();
  await ensureDefaultUsers();
  await startWahaSessionWithStore();
  await sincronizarFotosChatsOverview();

setInterval(() => {
  sincronizarFotosChatsOverview();
}, 30 * 60 * 1000);
  
  console.log("Servidor rodando na porta", PORT);
  console.log("WAHA MODE ATIVO - Baileys desativado");
  console.log("WAHA_URL:", WAHA_URL);
  console.log("WAHA_SESSION:", WAHA_SESSION);
});
