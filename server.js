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
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const BACKUP_SECRET = process.env.BACKUP_SECRET || "";
const CONFIRM_LIMPEZA_SENHA = process.env.CONFIRM_LIMPEZA_SENHA || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const BASE44_FUNCTION_URL = process.env.BASE44_FUNCTION_URL || "https://chat-stu.base44.app/functions/atendimentoIA";
// Depois de quantos dias local a mídia já confirmada no backup do Drive
// pode ser removida do volume do Railway, para poupar espaço em disco.
const RETENCAO_MIDIA_LOCAL_DIAS = 180; // ~6 meses

// Mesmo limite usado no upload para o Drive — verificado aqui no backend,
// antes de oferecer o arquivo, para nunca reoferecer um arquivo grande
// demais em tentativas futuras.
const TAMANHO_MAXIMO_MIDIA_BACKUP = 10 * 1024 * 1024; // 10 MB
// Controle de backups mensais
const BACKUP_STATE_FILE = path.join(DATA_DIR, "backup_state.json");
let backupState = {
  mesesSalvos: [],        // meses com o texto (JSON) já confirmado no Drive
  mesesMidiaCompleta: []  // meses cuja mídia foi 100% confirmada no Drive, sem falhas
};

async function loadBackupState() {
  try {
    await ensureDirs();
    const raw = await fs.readFile(BACKUP_STATE_FILE, "utf-8");
    const dadosSalvos = JSON.parse(raw);
    // Mescla com os valores padrão em vez de substituir tudo — arquivos
    // salvos por uma versão anterior do sistema podem não ter todos os
    // campos que a versão atual espera (ex: mesesMidiaCompleta não existia
    // antes do backup de mídia ser implementado).
   backupState = {
      mesesSalvos: dadosSalvos.mesesSalvos || [],
      mesesMidiaCompleta: dadosSalvos.mesesMidiaCompleta || [],
      ultimaVerificacao: dadosSalvos.ultimaVerificacao || null,
      ultimasExecucoes: dadosSalvos.ultimasExecucoes || []
    };
  } catch {
    backupState = { mesesSalvos: [], mesesMidiaCompleta: [], ultimaVerificacao: null, ultimasExecucoes: [] };
  }
}

async function saveBackupState() {
  try {
    await ensureDirs();
    await fs.writeFile(BACKUP_STATE_FILE, JSON.stringify(backupState, null, 2));
  } catch (error) {
    console.error("Erro ao salvar estado de backup:", error);
  }
}

// Gera a lista de meses (formato "AAAA-MM") desde o primeiro mês com dado
// registrado até o mês atual, que ainda não constam em backupState.mesesSalvos.
function calcularMesesPendentes() {
  const todasMensagens = [...clientConversations, ...groupConversations]
    .flatMap(c => c.messages || []);

  if (todasMensagens.length === 0) return [];

  const datas = todasMensagens
    .map(m => new Date(m.date || m.sentAt || 0))
    .filter(d => !isNaN(d.getTime()));

  if (datas.length === 0) return [];

  const primeira = new Date(Math.min(...datas.map(d => d.getTime())));
  const agora = new Date();

  const pendentes = [];
  const cursor = new Date(primeira.getFullYear(), primeira.getMonth(), 1);
  const limite = new Date(agora.getFullYear(), agora.getMonth(), 1);

  while (cursor <= limite) {
    const chave = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
    // Reprocessa o mês se o texto ainda não foi confirmado OU se a mídia
    // ainda não foi 100% confirmada (ex: alguma mídia falhou/foi ignorada
    // na tentativa anterior e precisa ser retentada).
    const textoOk = backupState.mesesSalvos.includes(chave);
    const midiaOk = backupState.mesesMidiaCompleta.includes(chave);
    if (!textoOk || !midiaOk) {
      pendentes.push(chave);
    }
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return pendentes;
}

// Monta o dump de mensagens de um mês específico ("AAAA-MM"), de todas as
// conversas (clientes e grupos), incluindo o nome de exibição da conversa.
function montarDumpDoMes(mesChave) {
  const [ano, mes] = mesChave.split("-").map(Number);
  const inicio = new Date(ano, mes - 1, 1).getTime();
  const fim = new Date(ano, mes, 1).getTime();

  const resultado = [];

  for (const conversa of [...clientConversations, ...groupConversations]) {
    const mensagensDoMes = (conversa.messages || []).filter(m => {
      const t = new Date(m.date || m.sentAt || 0).getTime();
      return t >= inicio && t < fim;
    });

    if (mensagensDoMes.length > 0) {
      resultado.push({
        jid: conversa.jid,
        nome: conversa.clientName || conversa.name || conversa.jid,
        telefone: conversa.realPhone || conversa.telefone || null,
        mensagens: mensagensDoMes
      });
    }
  }

  return {
    mes: mesChave,
    geradoEm: new Date().toISOString(),
    conversas: resultado
  };
}

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

    if (data?.me) {
      waSelfId = data.me.id ? cleanJid(data.me.id) : null;
      waSelfLid = data.me.lid ? cleanJid(data.me.lid) : null;
      waSelfPushName = data.me.pushName || null;
      setConnectionStatus("WORKING");
    }

    console.log("✅ WAHA STORE START:", {
      ok: response.ok,
      status: response.status,
      waSelf: { waSelfId, waSelfLid, waSelfPushName },
      data
    });
  } catch (error) {
    console.error("❌ Erro ao iniciar WAHA store:", error.message);
  }
}

let connectionStatus = "UNKNOWN";
let lastQr = null;
let connectedSince = null;
let reconnectionTimestamps = [];

// Centraliza a atualização do status: toda vez que a sessão TRANSICIONA para
// "WORKING" (vindo de qualquer outro estado), registra o horário da conexão
// e soma mais uma reconexão à janela das últimas 24h — usado pelos
// indicadores "Conectado desde" e "Reconexões (24h)" no Dashboard.
function setConnectionStatus(newStatus) {
  const wasWorking = connectionStatus === "WORKING";
  connectionStatus = newStatus;

  if (newStatus === "WORKING" && !wasWorking) {
    connectedSince = new Date().toISOString();
    reconnectionTimestamps.push(Date.now());
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    reconnectionTimestamps = reconnectionTimestamps.filter(t => t > cutoff);
  }

  if (newStatus !== "WORKING") {
    connectedSince = null;
  }
}

// Identidade da própria conta conectada ao WhatsApp (capturada no startup).
// Usada para detectar e ignorar "ecos" espúrios de mensagens enviadas, onde o
// WAHA dispara message.any referenciando a própria conta como se fosse uma
// conversa nova (bug observado nesta engine NOWEB).
let waSelfId = null;
let waSelfLid = null;
let waSelfPushName = null;

let clientConversations = [];
let groupConversations = [];

let tags = [];
let quickMessages = [];

let users = [];

let lidToPhone = {};
let phoneToLid = {};
let groupNameCache = {};
let canonicalChatIdCache = {};
let saveConversationsRunning = false;
let saveConversationsPending = false;

// Pesquisa de satisfação
const SATISFACTION_FILE = path.join(DATA_DIR, "satisfaction.json");
let satisfactionSettings = {
  enabled: false,
  cooldownDays: 7,
  messageText: "Como foi seu atendimento com a STU?"
};
let satisfactionSentMap = {};       // telefone -> ISO da última pesquisa enviada
let satisfactionAwaiting = {};      // telefone -> { conversationJid, agentName, clientName, sentAt }
let satisfactionResponses = [];     // respostas recebidas

async function loadSatisfaction() {
  try {
    await ensureDirs();
    const raw = await fs.readFile(SATISFACTION_FILE, "utf-8");
    const data = JSON.parse(raw);
    satisfactionSettings = { ...satisfactionSettings, ...(data.settings || {}) };
    satisfactionSentMap = data.sentMap || {};
    satisfactionAwaiting = data.awaiting || {};
    satisfactionResponses = data.responses || [];
    console.log("Pesquisa de satisfação carregada:", { respostas: satisfactionResponses.length });
  } catch {
    // primeira execução: mantém os valores padrão
  }
}

async function saveSatisfaction() {
  try {
    await ensureDirs();
    await fs.writeFile(
      SATISFACTION_FILE,
      JSON.stringify(
        {
          settings: satisfactionSettings,
          sentMap: satisfactionSentMap,
          awaiting: satisfactionAwaiting,
          responses: satisfactionResponses
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error("Erro ao salvar pesquisa de satisfação:", error);
  }
}

// Dispara a enquete de satisfação após uma conversa ser finalizada, respeitando
// o cooldown configurado por contato (evita reenviar se o mesmo cliente
// finalizar outro atendimento antes do prazo).
async function dispararPesquisaSatisfacao(conversa, attendantName) {
  try {
    if (!satisfactionSettings.enabled) return;
    if (isGroupJid(conversa.jid)) return;

    const telefone = conversa.realPhone || conversa.telefone || cleanJid(conversa.jid);
    if (!telefone) return;

    const ultimoEnvio = satisfactionSentMap[telefone];
    if (ultimoEnvio) {
      const diasDesde = (Date.now() - new Date(ultimoEnvio).getTime()) / (1000 * 60 * 60 * 24);
      if (diasDesde < satisfactionSettings.cooldownDays) {
        console.log("⭐ Pesquisa de satisfação pulada (dentro do cooldown):", { telefone, diasDesde: diasDesde.toFixed(1) });
        return;
      }
    }

    const chatId = await getCanonicalChatId(toWahaChatId(conversa.jid));

    // Enquetes (sendPoll) não funcionam de forma confiável nessa conta —
    // a engine falha silenciosamente ao decodificar votos em contatos com
    // endereçamento @lid (bug conhecido da biblioteca por trás da engine
    // NOWEB). Voltamos ao texto simples, com proteção por janela de tempo
    // e telefone específico contra falsos positivos.
    const response = await fetch(`${WAHA_URL}/api/sendText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session: WAHA_SESSION,
        chatId,
        text: `${satisfactionSettings.messageText}\n\nResponda com um número de 1 a 5 (1 = péssimo, 5 = ótimo).`,
        linkPreview: false
      })
    });

    if (!response.ok) {
      console.log("⚠️ Falha ao enviar pesquisa de satisfação:", { telefone, status: response.status });
      return;
    }

    const now = new Date().toISOString();
    satisfactionSentMap[telefone] = now;
    satisfactionAwaiting[telefone] = {
      conversationJid: conversa.jid,
      agentName: attendantName || conversa.attendant || "Sistema",
      clientName: conversa.clientName || conversa.name || telefone,
      sentAt: now
    };

    await saveSatisfaction();
    console.log("⭐ Pesquisa de satisfação enviada:", { telefone });

  } catch (error) {
    console.error("Erro ao disparar pesquisa de satisfação:", error);
  }
}

// Verifica se uma mensagem recebida é a resposta a uma pesquisa de satisfação
// pendente (aguardando resposta há no máximo 48h) e, se for, registra a nota.
// Só considera resposta se: (1) o telefone tem pesquisa pendente registrada,
// (2) está dentro da janela de 48h após o envio, (3) o texto começa com um
// dígito de 1 a 5. Fora dessas condições, qualquer número digitado pelo
// cliente é tratado como mensagem normal.
async function capturarRespostaSatisfacao(telefone, texto) {
  const pendente = satisfactionAwaiting[telefone];
  if (!pendente) return false;

  const horasDesde = (Date.now() - new Date(pendente.sentAt).getTime()) / (1000 * 60 * 60);
  if (horasDesde > 48) {
    delete satisfactionAwaiting[telefone];
    await saveSatisfaction();
    return false;
  }

  const match = String(texto || "").trim().match(/^([1-5])\b\s*(.*)$/s);
  if (!match) return false;

  satisfactionResponses.push({
    telefone,
    clientName: pendente.clientName,
    agentName: pendente.agentName,
    score: Number(match[1]),
    comment: match[2] || "",
    date: new Date().toISOString()
  });

  delete satisfactionAwaiting[telefone];
  await saveSatisfaction();
  console.log("⭐ Resposta de satisfação registrada:", { telefone, score: match[1] });
  return true;
}

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
  // Contatos importados sem nenhuma mensagem ainda não são "conversas" de
  // verdade — ficam de fora do Atendimento/Kanban/Dashboard até o cliente
  // mandar a primeira mensagem real.
  const conversas = getConversationList().filter(c => (c.messages || []).length > 0);

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

function buildWahaMessageId(chatId, data) {
  if (data?.id && typeof data.id === "string" && data.id.includes("_")) {
    return data.id;
  }

  if (data?.key?.id) {
    const fromMe = data.key.fromMe !== false;
    return `${fromMe ? "true" : "false"}_${chatId}_${data.key.id}`;
  }

  return data?.messageId || null;
}

// Extrai só a parte final do ID (depois do último "_"), pois o WAHA às vezes
// entrega o waMessageId completo ({fromMe}_{chatId}_{id}) e às vezes só o id cru,
// dependendo do evento (message vs message.revoked).
function extractRawMessageId(waMessageId) {
  if (!waMessageId || typeof waMessageId !== "string") return waMessageId;
  const parts = waMessageId.split("_");
  return parts[parts.length - 1];
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
      if (conversa.fotoEditadaManualmente) continue;

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

async function getContactName(jid) {
  try {
    const chatId = toWahaChatId(jid);

    const endpoints = [
      `${WAHA_URL}/api/${WAHA_SESSION}/contacts/${encodeURIComponent(chatId)}`,
      `${WAHA_URL}/api/contacts?contactId=${encodeURIComponent(chatId)}&session=${WAHA_SESSION}`
    ];

    for (const url of endpoints) {
      try {
        const response = await fetch(url);

        if (!response.ok) continue;

        const data = await response.json();

        const name =
          data.name ||
          data.pushname ||
          data.pushName ||
          data.formattedName ||
          data.shortName ||
          null;

        if (name) return name;
      } catch (e) {
        console.log("📇 getContactName - erro na tentativa:", { url, erro: e.message });
      }
    }

    return null;
  } catch (error) {
    console.log("Erro ao buscar nome do contato no WAHA:", error.message);
    return null;
  }
}

// Números brasileiros cadastrados antes de 2012 usam o formato antigo (sem o
// nono dígito). Se enviarmos no formato errado, a WAHA aceita o envio
// (retorna 201) mas o WhatsApp nunca entrega de verdade, sem erro nenhum.
// Consulta o chatId real reconhecido pelo WhatsApp antes de enviar.
async function getCanonicalChatId(chatId) {
  if (!chatId || !chatId.endsWith("@c.us")) return chatId;
  if (canonicalChatIdCache[chatId]) return canonicalChatIdCache[chatId];

  try {
    const phone = normalizePhone(cleanJid(chatId));
    const response = await fetch(
      `${WAHA_URL}/api/contacts/check-exists?phone=${phone}&session=${WAHA_SESSION}`
    );

    if (!response.ok) return chatId;

    const data = await response.json().catch(() => null);

    if (data?.numberExists && data?.chatId) {
      canonicalChatIdCache[chatId] = data.chatId;
      console.log("📞 chatId corrigido pelo check-exists:", { original: chatId, canonico: data.chatId });
      return data.chatId;
    }
  } catch (error) {
    console.log("Erro ao verificar chatId canônico:", error.message);
  }

  return chatId;
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
      notas: [],
      nomeEditadoManualmente: false,
      fotoEditadaManualmente: false,
      createdAt: new Date().toISOString()
    };

    clientConversations.push(clientChat);
  } else {
    if (displayName && !clientChat.nomeEditadoManualmente) {
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
  forwarded = false,
  sentOutsideApp = false,
  contextInfo = null
}) {
  const isGroup = isGroupJid(jid);
  const chat = await getOrCreateConversation(jid, isGroup, displayName);

  // Deduplicação: o WAHA às vezes entrega o mesmo evento "message" mais de uma vez
  // (webhook duplicado). Se já existe uma mensagem com esse waMessageId nesta
  // conversa, não salva de novo.
  if (waMessageId) {
   const existing = chat.messages.find(m => m.waMessageId === waMessageId);
    if (existing) {
   return { ...existing, _duplicate: true };
    }
  }

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
    sentOutsideApp,
    contextInfo,
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

// ============================================================================
// CONSULTA DE CEP (ViaCEP) — usada pelo agente de IA para confirmar endereço
// ============================================================================
function extrairCep(texto) {
  if (!texto || typeof texto !== 'string') return null;
  const match = texto.match(/\b(\d{5})-?(\d{3})\b/);
  return match ? `${match[1]}${match[2]}` : null;
}

const cepCache = new Map();
const CEP_TTL = 30 * 24 * 60 * 60 * 1000;

async function consultarCep(cep) {
  const digits = String(cep || '').replace(/\D/g, '');
  if (digits.length !== 8) return null;

  const cached = cepCache.get(digits);
  if (cached && Date.now() - cached.ts < CEP_TTL) {
    return cached.endereco;
  }

  try {
    const res = await fetch(`https://viacep.com.br/ws/${digits}/json/`);
    if (!res.ok) return null;

    const data = await res.json();
    if (!data || data.erro) return null;

    const partes = [
      data.logradouro,
      data.complemento ? `(${data.complemento})` : '',
      data.bairro,
      `${data.localidade}/${data.uf}`,
    ].filter(Boolean);
    const endereco = partes.join(', ') + ` — CEP ${data.cep || digits}`;

    cepCache.set(digits, { endereco, ts: Date.now() });
    return endereco;
  } catch {
    return null;
  }
}

// Envia texto pelo WAHA reaproveitando a resolução de chatId canônico —
// mesma lógica usada na rota /enviar.
async function sendTextViaWaha(jid, texto) {

  let chatId = toWahaChatId(jid);
  if (!isGroupJid(chatId)) {
    chatId = await getCanonicalChatId(chatId);
  }
  const response = await fetch(`${WAHA_URL}/api/sendText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session: WAHA_SESSION,
      chatId,
      text: texto,
      linkPreview: false
    })
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, chatId, data };
}

// Aciona o agente de IA (Sofia) para conversas ainda não assumidas por um
// atendente humano. Falha silenciosamente (loga e não interrompe o fluxo
// normal) se a chamada ao Base44 ou ao WAHA der errado — nesse caso a
// conversa segue disponível para atendimento humano normalmente.
async function acionarAgenteIA(conversa) {
  try {
    if (!WEBHOOK_SECRET) {
      console.log("⚠️ Agente IA não acionado: WEBHOOK_SECRET não configurado");
      return;
    }

    const historico = (conversa.messages || []).slice(-30).map(m => ({
      remetente: (m.direction === "sent" || m.from === "agent") ? "atendente" : "cliente",
      texto: m.text || (m.mediaType && m.mediaType !== "none" ? `[${m.mediaType}]` : "")
    }));

    const mensagemAtual = historico.length ? historico[historico.length - 1].texto : "";

    const cepDetectado = extrairCep(mensagemAtual);
    const enderecoCep = cepDetectado ? await consultarCep(cepDetectado) : null;

    const response = await fetch(BASE44_FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": WEBHOOK_SECRET
      },
      body: JSON.stringify({
        historico: historico.slice(0, -1),
        mensagemAtual,
        cliente: { nome: conversa.clientName || null, enderecoCep }
      })
    });

    if (!response.ok) {
      console.log("⚠️ Agente IA respondeu com erro:", response.status);
      return;
    }

    const { resposta, sugerirHumano } = await response.json().catch(() => ({}));
    if (!resposta) return;

    const textoFinal = `*Sofia* | STU Logística\n\n${resposta}`;
    const envio = await sendTextViaWaha(conversa.jid, textoFinal);

    if (!envio.ok) {
      console.log("⚠️ Falha ao enviar resposta da IA pelo WAHA:", envio.data);
      return;
    }

    await saveMessage({
      jid: conversa.jid,
      sender: "sistema",
      senderName: "Sofia (IA)",
      text: textoFinal,
      direction: "sent",
      waMessageId: buildWahaMessageId(envio.chatId, envio.data)
    });

    if (sugerirHumano) {
      conversa.iaSugeriuHumano = true;
      addConversationHistory(conversa, "ia_sugeriu_atendente", "Sofia (IA)", {});
      await saveConversations();
      emitConversationsToConnectedUsers();
    }

    console.log("🤖 Agente IA respondeu:", { jid: conversa.jid, sugerirHumano: !!sugerirHumano });
  } catch (error) {
    console.error("Erro ao acionar agente IA:", error.message);
  }
}

async function markDeletedMessage(jid, deletedWaMessageId) {
 
  const chat = findConversationByJid(jid);

  if (!chat) return false;

  const rawDeletedId = extractRawMessageId(deletedWaMessageId);
  const message = chat.messages.find(m => extractRawMessageId(m.waMessageId) === rawDeletedId);

  if (message) {
    // Idempotência: se a mensagem já foi marcada como apagada (ex: pelo atendente
    // via /apagar-mensagem), não sobrescreve o aviso mais específico que já existe.
    if (message.deletedInWhatsApp) {
      console.log("ℹ️ markDeletedMessage - mensagem já estava marcada como apagada, ignorando:", {
        waMessageId: message.waMessageId,
        deletedNoticeAtual: message.deletedNotice
      });
      return true;
    }

    message.deletedInWhatsApp = true;
    message.preservedInSystem = true;
    message.deletedNotice =
      message.direction === "received"
        ? "Mensagem apagada pelo cliente"
        : "Mensagem apagada no WhatsApp";
    message.updatedAt = new Date().toISOString();

    for (const [socketId, socket] of io.sockets.sockets) {
      const userName = socket.data?.userName;
      const role = socket.data?.role || "atendente";

      const conversasPermitidas = userName
        ? getConversationListByUser(userName, role)
        : getConversationList();

      const podeVerConversa = conversasPermitidas.some(c => c.jid === chat.jid);

      if (podeVerConversa) {
        socket.emit("mensagemApagada", {
          jid: chat.jid,
          waMessageId: deletedWaMessageId,
          message,
          conversation: chat
        });
      }
    }

    emitConversationsToConnectedUsers();
    await saveConversations();

    return true;
  }

  await saveMessage({
    jid: chat.jid,
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

  if (event !== "message.any") return;
  if (!payload) return;

  const rawJid = payload.from || payload._data?.key?.remoteJid;
  const altJid = payload._data?.key?.remoteJidAlt;

  if (!rawJid) return;
  if (rawJid === "status@broadcast") return;
  if (payload._data?.broadcast === true) return;

  // Chat consigo mesmo (recurso "Mensagens para você" do WhatsApp): só conta
  // se o próprio CHAT (não o remetente) for a nossa identidade. Removemos a
  // checagem por pushName — esse campo é sempre quem ENVIOU a mensagem, então
  // numa mensagem fromMe:true ele sempre é o nosso próprio nome, mesmo em
  // mensagens legítimas para outros contatos. Nunca foi um sinal válido.
  const rawJidLimpo = cleanJid(rawJid);
  const ehChatComigoMesmo =
    payload.fromMe === true &&
    ((waSelfId && rawJidLimpo === waSelfId) || (waSelfLid && rawJidLimpo === waSelfLid));

  if (ehChatComigoMesmo) {
    console.log("🔁 message.any ignorado - chat consigo mesmo:", {
      rawJid,
      rawJidLimpo,
      waSelfId,
      waSelfLid
    });
    return;
  }

  const isGroup = rawJid.endsWith("@g.us");
  const enviadaForaDoApp = payload.fromMe === true;

  let jid = toInternalPhoneJid(rawJid);
  let sender = jid;
  let senderName = payload._data?.pushName || payload.pushName || jid;
  let displayName = senderName;

  if (isGroup) {
    jid = rawJid;

    if (enviadaForaDoApp) {
      sender = "sistema";
      senderName = "STU Atendimento";
    } else {
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
    }

    displayName = await getGroupName(rawJid);
  } else {
    // Conversa individual: resolve LID -> telefone independente de quem
    // enviou. Isso é essencial para mensagens fora do app, que também chegam
    // endereçadas por LID e precisam cair na MESMA conversa já existente,
    // em vez de criar uma conversa nova (era a causa da "conversa fantasma").
    if (altJid && isPhoneJid(altJid)) {
      await mapLidToPhone(rawJid, altJid);
      const telefone = normalizePhone(cleanJid(altJid));
      jid = `${telefone}@s.whatsapp.net`;
    }

    if (enviadaForaDoApp) {
      sender = "sistema";
      senderName = "STU Atendimento";
      displayName = null;
    } else {
      sender = jid;
    }
  }

  const text =
    payload.body ||
    payload._data?.message?.conversation ||
    payload._data?.message?.extendedTextMessage?.text ||
    payload._data?.message?.imageMessage?.caption ||
    payload._data?.message?.videoMessage?.caption ||
    payload._data?.message?.documentMessage?.caption ||
    "";

  // Dado de citação ("resposta a"): a engine NOWEB (protocolo Baileys)
  // entrega isso dentro de extendedTextMessage.contextInfo. O
  // MessageBubble.jsx do frontend já espera esse formato em
  // message.contextInfo?.quotedMessage?.conversation.
  const contextInfo =
    payload._data?.message?.extendedTextMessage?.contextInfo || null;

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

  // Antes de decidir se reabre a conversa: verifica se essa mensagem é a
  // resposta do cliente a uma pesquisa de satisfação pendente. Se for, ela
  // é capturada e NÃO deve reabrir a conversa nem contar como "nova
  // mensagem" nos indicadores — é só feedback, não um novo atendimento.
  let foiRespostaSatisfacao = false;
  if (!isGroup && !enviadaForaDoApp) {
    const telefoneResposta = findMappedPhone(jid) || cleanJid(jid);
    foiRespostaSatisfacao = await capturarRespostaSatisfacao(telefoneResposta, text);
  }

  // Só reabre a conversa em sinais genuínos de novo contato: mensagem do
  // cliente, ou mensagem enviada pelo atendente DIRETO do celular pareado
  // (payload.source === "app"). O eco de mensagens que o nosso próprio
  // backend já enviou pela API (rotas /enviar, /enviar-midia,
  // /encaminhar-mensagem, mensagens automáticas de assumir/finalizar —
  // payload.source === "api") não deve reabrir nada: é só a confirmação do
  // envio que já processamos, não uma mensagem nova de verdade. Uma resposta
  // de pesquisa de satisfação também não reabre.
  const isEcoDaPropriaApi = payload.fromMe === true && payload.source === "api";

  if (!isGroup && !isEcoDaPropriaApi && !foiRespostaSatisfacao && conversaRecebida.status === "finalizada") {
    conversaRecebida.status = "nova";
    conversaRecebida.attendant = null;
    conversaRecebida.finishedAt = null;
    conversaRecebida.finishedBy = null;

    addConversationHistory(conversaRecebida, "reabriu", "Sistema", {
      motivo: enviadaForaDoApp
        ? "Mensagem enviada pelo atendente fora do app."
        : "Nova mensagem recebida."
    });
  }

  const mensagemSalva = await saveMessage({
    jid,
    sender,
    senderName,
    displayName,
    text,
    direction: enviadaForaDoApp ? "sent" : "received",
    waMessageId: payload.id || payload._data?.key?.id,
    mediaType,
    mediaUrl: mediaInfo.mediaUrl,
    mediaName: mediaInfo.mediaName,
    mimeType: mediaInfo.mimeType,
    fileSize: mediaInfo.fileSize,
    sentOutsideApp: enviadaForaDoApp,
    contextInfo
  });

  console.log(`✅ Mensagem salva: ${isGroup ? "grupo" : "cliente"} / ${enviadaForaDoApp ? "atendente_fora_do_app" : "cliente"}${mediaType !== "none" ? ` / ${mediaType}` : ""}`);

  // Aciona o agente de IA só para mensagens novas e reais de cliente,
  // em conversas individuais ainda não assumidas por um atendente.
  const conversaAtualizada = findConversationByJid(jid);
  if (
    !isGroup &&
    !enviadaForaDoApp &&
    !foiRespostaSatisfacao &&
    !mensagemSalva?._duplicate &&
    conversaAtualizada?.status === "nova"
  ) {
    acionarAgenteIA(conversaAtualizada);
  }
}
  
async function processarMensagemApagadaWaha(body) {
  try {
    const payload = body.payload || {};

    const rawJid =
      payload.from ||
      payload.chatId ||
      payload._data?.key?.remoteJid;

    const deletedId =
      payload.revokedMessageId ||
      payload.before?.id ||
      payload.after?.id ||
      payload.id ||
      payload.messageId ||
      payload._data?.protocolMessage?.key?.id ||
      payload._data?.key?.id;

    if (!rawJid || !deletedId) {
      console.log("⚠️ message.revoked ignorado - jid ou id ausente:", { rawJid, deletedId });
      return;
    }

    await markDeletedMessage(rawJid, deletedId);
  } catch (error) {
    console.error("Erro ao processar mensagem apagada WAHA:", error);
  }
}

async function processarReacaoWaha(body) {
  try {
    const payload = body.payload || {};

    const rawJid =
      payload.from ||
      payload.chatId ||
      payload._data?.key?.remoteJid;

    const reactionMessageId =
      payload.reaction?.messageId ||
      payload.reaction?.reactedMessageId ||
      payload.reactionMessageId ||
      null;

    const reactionText = payload.reaction?.text ?? null;

    if (!rawJid || !reactionMessageId) {
      console.log("⚠️ message.reaction ignorado - jid ou messageId ausente:", { rawJid, reactionMessageId });
      return;
    }

    const chat = findConversationByJid(rawJid);

    if (!chat) {
      console.log("⚠️ message.reaction - conversa não encontrada:", { rawJid });
      return;
    }

    const rawTargetId = extractRawMessageId(reactionMessageId);
    const message = chat.messages.find(m => extractRawMessageId(m.waMessageId) === rawTargetId);

    if (!message) {
      console.log("⚠️ message.reaction - mensagem reagida não encontrada:", {
        reactionMessageId,
        rawTargetId
      });
      return;
    }

    // Texto vazio ("") significa que a reação foi removida
    if (reactionText) {
      message.reaction = {
        emoji: reactionText,
        by: payload.fromMe ? "atendente" : "cliente",
        updatedAt: new Date().toISOString()
      };
    } else {
      message.reaction = null;
    }

    for (const [socketId, socket] of io.sockets.sockets) {
      const userName = socket.data?.userName;
      const role = socket.data?.role || "atendente";

      const conversasPermitidas = userName
        ? getConversationListByUser(userName, role)
        : getConversationList();

      const podeVerConversa = conversasPermitidas.some(c => c.jid === chat.jid);

      if (podeVerConversa) {
        socket.emit("mensagemReagida", {
          jid: chat.jid,
          waMessageId: message.waMessageId,
          message,
          conversation: chat
        });
      }
    }

    emitConversationsToConnectedUsers();
    await saveConversations();

  } catch (error) {
    console.error("Erro ao processar reação WAHA:", error);
  }
}

async function processarMensagemEditadaWaha(body) {
  try {
    const payload = body.payload || {};

    const rawJid =
      payload.from ||
      payload.chatId ||
      payload._data?.key?.remoteJid;

    const editedId =
      payload.editedMessageId ||
      payload.before?.id ||
      payload.after?.id ||
      payload.id ||
      payload.messageId ||
      payload._data?.key?.id;

    const newText =
      payload.after?.body ??
      payload.body ??
      payload._data?.message?.conversation ??
      payload._data?.message?.extendedTextMessage?.text ??
      null;

    if (!rawJid || !editedId) {
      console.log("⚠️ message.edited ignorado - jid ou id ausente:", { rawJid, editedId });
      return;
    }

    const chat = findConversationByJid(rawJid);

    if (!chat) {
      console.log("⚠️ message.edited - conversa não encontrada:", { rawJid });
      return;
    }

    const rawTargetId = extractRawMessageId(editedId);
    const message = chat.messages.find(m => extractRawMessageId(m.waMessageId) === rawTargetId);

    if (!message) {
      console.log("⚠️ message.edited - mensagem não encontrada:", { editedId, rawTargetId });
      return;
    }

    // Idempotência: se a edição já foi atribuída a um atendente (feita pelo
    // app via /editar-mensagem), não sobrescreve com um aviso genérico
    // vindo do eco desse mesmo evento pelo webhook.
    if (!message.editedByAttendant) {
      message.editedNotice =
        message.direction === "received"
          ? "editada pelo cliente"
          : "editada no WhatsApp";
    }

    // Preserva o texto anterior antes de sobrescrever. A comparação
    // newText !== message.text evita duplicar entrada no histórico quando
    // esse evento é só o eco de uma edição que já processamos via
    // /editar-mensagem (o texto já bate, não é uma mudança nova de verdade).
    if (newText !== null && newText !== message.text) {
      if (!message.editHistory) message.editHistory = [];
      message.editHistory.push({
        text: message.text,
        editedAt: new Date().toISOString()
      });
      message.text = newText;
    }
    message.edited = true;
    message.editedAt = new Date().toISOString();
    for (const [socketId, socket] of io.sockets.sockets) {
      const userName = socket.data?.userName;
      const role = socket.data?.role || "atendente";

      const conversasPermitidas = userName
        ? getConversationListByUser(userName, role)
        : getConversationList();

      const podeVerConversa = conversasPermitidas.some(c => c.jid === chat.jid);

      if (podeVerConversa) {
        socket.emit("mensagemEditada", {
          jid: chat.jid,
          waMessageId: message.waMessageId,
          message,
          conversation: chat
        });
      }
    }

    emitConversationsToConnectedUsers();
    await saveConversations();

  } catch (error) {
    console.error("Erro ao processar mensagem editada WAHA:", error);
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
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const reconnectCount24h = reconnectionTimestamps.filter(t => t > cutoff).length;

  res.json({
    status: connectionStatus,
    whatsappConectado: connectionStatus === "WORKING",
    connectedSince,
    reconnectCount24h,
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

app.get("/conversas-usuario", authenticateToken, (req, res) => {
  const userName = req.user.name;
  const role = req.user.role || "atendente";

  const conversas = getConversationListByUser(userName, role);

  res.json({
    sucesso: true,
    userName,
    role,
    total: conversas.length,
    conversas
  });
});

app.get("/buscar", authenticateToken, (req, res) => {
  try {
    const termo = String(req.query.q || "").trim().toLowerCase();

    if (!termo) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe o termo de busca"
      });
    }

    const userName = req.user.name;
    const role = req.user.role || "atendente";
    const conversas = getConversationListByUser(userName, role);

    const resultados = conversas
      .map(conversa => {
        const nome = (conversa.clientName || conversa.name || "").toLowerCase();
        const nomeCasa = nome.includes(termo);

        const mensagemEncontrada = [...conversa.messages]
          .reverse()
          .find(m => (m.text || "").toLowerCase().includes(termo));

        if (!nomeCasa && !mensagemEncontrada) return null;

        return {
          jid: conversa.jid,
          clientName: conversa.clientName || conversa.name || "",
          status: conversa.status,
          matchType: mensagemEncontrada ? "mensagem" : "nome",
          trecho: mensagemEncontrada ? mensagemEncontrada.text : null,
          data: mensagemEncontrada ? mensagemEncontrada.date : null
        };
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.data || 0).getTime() - new Date(a.data || 0).getTime());

    return res.json({
      sucesso: true,
      termo,
      total: resultados.length,
      resultados
    });

  } catch (error) {
    console.error("Erro em /buscar:", error);
    return res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
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

    // Espera alguns segundos antes de disparar a pesquisa — dá tempo da
    // mensagem automática de finalização (enviada pelo frontend logo após
    // esta resposta) chegar primeiro no WhatsApp, mantendo a ordem natural
    // da conversa: "finalizado" antes de "avalie seu atendimento".
    setTimeout(() => {
      dispararPesquisaSatisfacao(conversa, conversa.finishedBy);
    }, 5000);

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

// ============================================================================
// AGENDA DE CONTATOS
// ============================================================================

// Formata uma conversa de cliente como um "contato" para a agenda —
// reaproveita os dados que já existem na conversa em vez de duplicar estado.
function toContato(conversa) {
  return {
    jid: conversa.jid,
    nome: conversa.clientName || conversa.name || "",
    telefone: conversa.realPhone || conversa.telefone || conversa.clientPhone || "",
    empresa: conversa.empresa || "",
    email: conversa.email || "",
    fotoUrl: conversa.profilePictureUrl || conversa.avatarUrl || null,
    nomeEditadoManualmente: !!conversa.nomeEditadoManualmente,
    fotoEditadaManualmente: !!conversa.fotoEditadaManualmente,
    notas: conversa.notas || [],
    criadoEm: conversa.createdAt || null,
    ultimaAtividade: conversa.lastMessageTime || conversa.lastMessageAt || conversa.createdAt || null
  };
}

app.get("/contatos", authenticateToken, (req, res) => {
  const contatos = clientConversations
    .map(toContato)
    .sort((a, b) => new Date(b.ultimaAtividade || 0).getTime() - new Date(a.ultimaAtividade || 0).getTime());

  res.json({ sucesso: true, total: contatos.length, contatos });
});

app.get("/contato/:jid", authenticateToken, (req, res) => {
  const conversa = findConversationByJid(decodeURIComponent(req.params.jid));

  if (!conversa || conversa.conversationType !== "cliente") {
    return res.status(404).json({ sucesso: false, erro: "Contato não encontrado" });
  }

  res.json({
    sucesso: true,
    contato: toContato(conversa),
    historico: conversa.history || []
  });
});

app.post("/contato/:jid", authenticateToken, async (req, res) => {
  try {
    const conversa = findConversationByJid(decodeURIComponent(req.params.jid));

    if (!conversa || conversa.conversationType !== "cliente") {
      return res.status(404).json({ sucesso: false, erro: "Contato não encontrado" });
    }

    const { nome, telefone, empresa, email } = req.body || {};
    const atendenteResponsavel = req.user?.name || "Sistema";

    // Editar o nome manualmente marca o contato como protegido — a partir
    // daqui, mensagens novas do WhatsApp não sobrescrevem mais esse nome
    // (ver getOrCreateConversation).
    if (typeof nome === "string" && nome.trim() && nome.trim() !== conversa.clientName) {
      conversa.clientName = nome.trim();
      conversa.name = nome.trim();
      conversa.nomeEditadoManualmente = true;
      addConversationHistory(conversa, "editou_nome_contato", atendenteResponsavel, { novoNome: nome.trim() });
    }

    if (typeof telefone === "string" && telefone.trim()) {
      conversa.realPhone = normalizePhone(telefone);
      conversa.telefone = normalizePhone(telefone);
    }

    if (typeof empresa === "string") conversa.empresa = empresa.trim();
    if (typeof email === "string") conversa.email = email.trim();

    await saveConversations();
    emitConversationsToConnectedUsers();

    return res.json({ sucesso: true, contato: toContato(conversa) });
  } catch (error) {
    console.error("Erro ao editar contato:", error);
    return res.status(500).json({ sucesso: false, erro: error.message });
  }
});

app.post("/contato/:jid/nota", authenticateToken, async (req, res) => {
  try {
    const conversa = findConversationByJid(decodeURIComponent(req.params.jid));

    if (!conversa || conversa.conversationType !== "cliente") {
      return res.status(404).json({ sucesso: false, erro: "Contato não encontrado" });
    }

    const { texto } = req.body || {};
    if (!texto || !texto.trim()) {
      return res.status(400).json({ sucesso: false, erro: "Informe o texto da nota" });
    }

    if (!conversa.notas) conversa.notas = [];
    const nota = {
      texto: texto.trim(),
      autor: req.user?.name || "Sistema",
      data: new Date().toISOString()
    };
    conversa.notas.push(nota);

    addConversationHistory(conversa, "adicionou_nota", nota.autor, {});

    await saveConversations();

    return res.json({ sucesso: true, notas: conversa.notas });
  } catch (error) {
    console.error("Erro ao adicionar nota:", error);
    return res.status(500).json({ sucesso: false, erro: error.message });
  }
});

// Exporta a agenda de contatos em CSV (compatível com Excel/Planilhas).
app.get("/contatos/exportar", authenticateToken, (req, res) => {
  const linhas = [["Nome", "Telefone", "Empresa", "E-mail", "Criado em", "Última atividade"]];

  for (const conversa of clientConversations) {
    const c = toContato(conversa);
    linhas.push([c.nome, c.telefone, c.empresa, c.email, c.criadoEm || "", c.ultimaAtividade || ""]);
  }

  const csv = linhas
    .map(linha => linha.map(campo => `"${String(campo || "").replace(/"/g, '""')}"`).join(";"))
    .join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="contatos-talky-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send("\uFEFF" + csv);
});

// Encontra um contato existente pelo telefone, considerando as variações
// de formato brasileiro (com/sem o nono dígito) já usadas no resto do app.
function encontrarContatoPorTelefone(telefone) {
  const digits = normalizePhone(telefone);
  if (!digits) return null;
  const variantes = getBrazilPhoneVariants(digits);
  return clientConversations.find(c => {
    const candidatos = [c.realPhone, c.telefone, c.clientPhone].filter(Boolean).map(normalizePhone);
    return candidatos.some(cand => variantes.includes(cand) || getBrazilPhoneVariants(cand).some(v => variantes.includes(v)));
  }) || null;
}

// Recebe as linhas já parseadas do CSV e classifica cada uma como "novo"
// ou "duplicata" (telefone já existente), devolvendo os dois lados para a
// tela de revisão decidir o que fazer.
app.post("/contatos/importar/preview", authenticateToken, requireAdmin, (req, res) => {
  try {
    const { linhas } = req.body || {};
    if (!Array.isArray(linhas)) {
      return res.status(400).json({ sucesso: false, erro: "Informe linhas (array)" });
    }

    const resultados = linhas.map(linha => {
      const telefoneDigits = normalizePhone(linha.telefone || "");
      const existente = telefoneDigits ? encontrarContatoPorTelefone(telefoneDigits) : null;

      return {
        novo: {
          nome: (linha.nome || "").trim(),
          telefone: telefoneDigits,
          empresa: (linha.empresa || "").trim(),
          email: (linha.email || "").trim(),
        },
        tipo: existente ? "duplicata" : "novo",
        existente: existente ? toContato(existente) : null,
      };
    });

    res.json({ sucesso: true, resultados });
  } catch (error) {
    console.error("Erro no preview de importação:", error);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

// Aplica as decisões tomadas na tela de revisão: cria contatos novos como
// registros sem mensagens (serão reaproveitados quando o número mandar a
// primeira mensagem real pelo WhatsApp) e resolve duplicatas conforme a
// ação escolhida (manter_antigo / manter_novo / mesclar).
app.post("/contatos/importar/confirmar", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { decisoes } = req.body || {};
    if (!Array.isArray(decisoes)) {
      return res.status(400).json({ sucesso: false, erro: "Informe decisoes (array)" });
    }

    const atendenteResponsavel = req.user?.name || "Sistema";
    let criados = 0;
    let atualizados = 0;
    let ignorados = 0;

    for (const decisao of decisoes) {
      const { acao, dados } = decisao || {};
      const telefoneDigits = normalizePhone(dados?.telefone || "");
      if (!telefoneDigits) { ignorados++; continue; }

      if (acao === "manter_antigo") {
        ignorados++;
        continue;
      }

      const existente = encontrarContatoPorTelefone(telefoneDigits);

      if (!existente) {
        const jid = `${telefoneDigits}@s.whatsapp.net`;
        clientConversations.push({
          id: Date.now() + Math.floor(Math.random() * 1000),
          jid,
          whatsappId: jid,
          lid: null,
          name: dados.nome || telefoneDigits,
          clientName: dados.nome || telefoneDigits,
          clientPhone: telefoneDigits,
          realPhone: telefoneDigits,
          telefone: telefoneDigits,
          phoneUnavailableReason: null,
          profilePictureUrl: null,
          avatarUrl: null,
          conversationType: "cliente",
          type: "cliente",
          status: "nova",
          attendant: null,
          unreadCount: 0,
          messages: [],
          notas: [],
          nomeEditadoManualmente: true,
          fotoEditadaManualmente: false,
          empresa: dados.empresa || "",
          email: dados.email || "",
          history: [{ action: "importado_csv", user: atendenteResponsavel, date: new Date().toISOString(), details: {} }],
          createdAt: new Date().toISOString()
        });
        criados++;
        continue;
      }

      if (acao === "manter_novo") {
        existente.clientName = dados.nome || existente.clientName;
        existente.name = existente.clientName;
        existente.empresa = dados.empresa || existente.empresa;
        existente.email = dados.email || existente.email;
        existente.nomeEditadoManualmente = true;
        addConversationHistory(existente, "importado_csv_mesclado", atendenteResponsavel, { acao });
        atualizados++;
      } else if (acao === "mesclar") {
        if (dados.nome && !existente.clientName) {
          existente.clientName = dados.nome;
          existente.name = dados.nome;
        }
        if (dados.empresa && !existente.empresa) existente.empresa = dados.empresa;
        if (dados.email && !existente.email) existente.email = dados.email;
        existente.nomeEditadoManualmente = true;
        addConversationHistory(existente, "importado_csv_mesclado", atendenteResponsavel, { acao });
        atualizados++;
      } else {
        // Telefone repetido dentro do próprio arquivo importado (mais de
        // uma linha com o mesmo número) — a primeira ocorrência já criou
        // o contato; as ocorrências seguintes não fazem nada.
        ignorados++;
      }
    }

    await saveConversations();
    emitConversationsToConnectedUsers();

    res.json({ sucesso: true, criados, atualizados, ignorados });
  } catch (error) {
    console.error("Erro ao confirmar importação:", error);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

// Middleware simples: exige a chave secreta de backup no header, em vez do
// JWT de usuário normal — quem chama essas rotas é a função de backend do
// Base44, não um atendente logado.
function requireBackupSecret(req, res, next) {
  if (!BACKUP_SECRET) {
    return res.status(500).json({ sucesso: false, erro: "BACKUP_SECRET não configurado no servidor" });
  }
  const chave = req.headers["x-backup-secret"];
  if (chave !== BACKUP_SECRET) {
    return res.status(403).json({ sucesso: false, erro: "Chave de backup inválida" });
  }
  next();
}

app.get("/backup/pendentes", requireBackupSecret, (req, res) => {
  const pendentes = calcularMesesPendentes();
  res.json({ sucesso: true, pendentes });
});

app.get("/backup/dump/:mes", requireBackupSecret, (req, res) => {
  const mesChave = req.params.mes;
  if (!/^\d{4}-\d{2}$/.test(mesChave)) {
    return res.status(400).json({ sucesso: false, erro: "Formato de mês inválido, use AAAA-MM" });
  }
  const dump = montarDumpDoMes(mesChave);
  res.json({ sucesso: true, dump });
});

// Lista os arquivos de mídia (imagens, áudios, documentos, vídeos) referenciados
// por mensagens de um mês específico, para o backup incluir também a mídia,
// não só o texto. O download em si usa a rota pública /download/:fileName
// já existente — aqui só devolvemos quais arquivos pertencem a esse mês.
app.get("/backup/midias/:mes", requireBackupSecret, async (req, res) => {
  const mesChave = req.params.mes;
  if (!/^\d{4}-\d{2}$/.test(mesChave)) {
    return res.status(400).json({ sucesso: false, erro: "Formato de mês inválido, use AAAA-MM" });
  }

  const [ano, mes] = mesChave.split("-").map(Number);
  const inicio = new Date(ano, mes - 1, 1).getTime();
  const fim = new Date(ano, mes, 1).getTime();

  const arquivos = [];
  let precisaSalvar = false;

  for (const conversa of [...clientConversations, ...groupConversations]) {
    for (const m of (conversa.messages || [])) {
      if (!m.mediaUrl) continue;
      // Já processada numa rodada anterior (enviada com sucesso, ou
      // permanentemente ignorada) — nunca reoferece para nova tentativa.
      if (m.mediaBackupStatus) continue;

      const t = new Date(m.date || m.sentAt || 0).getTime();
      if (t < inicio || t >= fim) continue;

      const fileName = m.mediaUrl.replace("/media/", "");
      const filePath = path.join(MEDIA_DIR, fileName);

      let tamanho = 0;
      try {
        const stat = await fs.stat(filePath);
        tamanho = stat.size;
      } catch {
        // Arquivo não existe mais no disco — marca como ignorado permanente,
        // não há o que fazer backup aqui.
        m.mediaBackupStatus = "arquivo_nao_encontrado";
        precisaSalvar = true;
        continue;
      }

      // Verifica o tamanho AQUI, sem precisar baixar o arquivo inteiro só
      // para descobrir que é grande demais — e nunca mais oferece esse
      // arquivo específico de novo.
      if (tamanho > TAMANHO_MAXIMO_MIDIA_BACKUP) {
        m.mediaBackupStatus = "ignorado_tamanho";
        precisaSalvar = true;
        continue;
      }

      arquivos.push({
        fileName,
        mediaName: m.mediaName || fileName,
        mimeType: m.mimeType || "application/octet-stream"
      });
    }
  }

  if (precisaSalvar) await saveConversations();

  res.json({ sucesso: true, arquivos });
});

// Registro simples de cada execução do backup, para exibir status na tela
// de Administração — mantém só as últimas 30 entradas, suficiente para
// diagnóstico sem crescer indefinidamente.
app.post("/backup/log-execucao", requireBackupSecret, async (req, res) => {
  const { sucesso, mesProcessado, midiasIgnoradasCount, erro } = req.body || {};
  const agora = new Date().toISOString();

  // Sempre atualiza — usada para saber se o mecanismo automático ainda está
  // rodando periodicamente, mesmo em chamadas que não tinham nada pendente.
  backupState.ultimaVerificacao = { data: agora, sucesso: sucesso !== false };

  // Só entra no histórico visível quando há algo relevante: um mês
  // processado de verdade, ou um erro — evita poluir a tabela com
  // execuções de rotina que não encontraram nada pendente.
  const relevante = (mesProcessado !== null && mesProcessado !== undefined) || sucesso === false;
  if (relevante) {
    backupState.ultimasExecucoes = backupState.ultimasExecucoes || [];
    backupState.ultimasExecucoes.unshift({
      data: agora,
      sucesso: sucesso !== false,
      mesProcessado: mesProcessado || null,
      midiasIgnoradasCount: midiasIgnoradasCount || 0,
      erro: erro || null
    });
    backupState.ultimasExecucoes = backupState.ultimasExecucoes.slice(0, 30);
  }

  await saveBackupState();
  res.json({ sucesso: true });
});

app.get("/backup/status", authenticateToken, (req, res) => {
  const ultimasExecucoes = backupState.ultimasExecucoes || [];
  const ultimaVerificacao = backupState.ultimaVerificacao || null;

  const totalMidiasIgnoradas = [...clientConversations, ...groupConversations]
    .flatMap(c => c.messages || [])
    .filter(m => m.mediaBackupStatus === "ignorado_tamanho" || m.mediaBackupStatus === "arquivo_nao_encontrado")
    .length;

  res.json({
    sucesso: true,
    mesesSalvos: backupState.mesesSalvos || [],
    mesesMidiaCompleta: backupState.mesesMidiaCompleta || [],
    totalMidiasIgnoradas,
    ultimaVerificacao,
    ultimasExecucoes
  });
});

app.post("/backup/confirmar/:mes", requireBackupSecret, async (req, res) => {
  const mesChave = req.params.mes;
  if (!backupState.mesesSalvos.includes(mesChave)) {
    backupState.mesesSalvos.push(mesChave);
    backupState.mesesSalvos.sort();
    await saveBackupState();
  }
  res.json({ sucesso: true, mesesSalvos: backupState.mesesSalvos });
});

// Chamada pela função de backup do Base44 depois de processar a mídia de um
// mês inteiro. completo=true só quando NENHUM arquivo daquele mês falhou ou
// foi ignorado (por tamanho, erro de rede, etc) — só então esse mês fica
// elegível para a limpeza automática do disco local, mais adiante.
// Chamada pela função de backup depois de subir (ou confirmar que já
// existia) um arquivo de mídia individual no Drive — marca a mensagem
// correspondente como concluída, tanto para nunca mais reoferecer esse
// arquivo quanto para liberar ele especificamente para a limpeza local.
app.post("/backup/midia-confirmada", requireBackupSecret, async (req, res) => {
  const { fileName } = req.body || {};
  if (!fileName) {
    return res.status(400).json({ sucesso: false, erro: "Informe fileName" });
  }

  let encontrado = false;
  for (const conversa of [...clientConversations, ...groupConversations]) {
    for (const m of (conversa.messages || [])) {
      if (m.mediaUrl && m.mediaUrl.replace("/media/", "") === fileName) {
        m.mediaBackupStatus = "ok";
        encontrado = true;
      }
    }
  }

  if (encontrado) await saveConversations();

  res.json({ sucesso: true, encontrado });
});

app.post("/backup/confirmar-midia/:mes", requireBackupSecret, async (req, res) => {
  const mesChave = req.params.mes;
  const completo = req.body?.completo === true;

  if (completo && !backupState.mesesMidiaCompleta.includes(mesChave)) {
    backupState.mesesMidiaCompleta.push(mesChave);
    backupState.mesesMidiaCompleta.sort();
    await saveBackupState();
  }

  res.json({ sucesso: true, mesesMidiaCompleta: backupState.mesesMidiaCompleta });
});

// Apaga do disco local os arquivos de mídia com mais de
// RETENCAO_MIDIA_LOCAL_DIAS dias, cujo mês já está com backup de mídia
// 100% confirmado no Drive. A mensagem em si NUNCA é apagada — só o
// arquivo físico e a referência mediaUrl, marcando mediaArchived=true para
// o frontend explicar que o anexo está preservado no backup, não perdido.
async function limparMidiaLocalAntiga() {
  const limite = Date.now() - RETENCAO_MIDIA_LOCAL_DIAS * 24 * 60 * 60 * 1000;
  let alterouAlgo = false;
  let removidos = 0;

  for (const conversa of [...clientConversations, ...groupConversations]) {
    for (const m of (conversa.messages || [])) {
      if (!m.mediaUrl) continue;
      // Só remove do disco o que foi CONFIRMADO individualmente como
      // enviado com sucesso ao Drive — nunca apaga arquivos ignorados (por
      // tamanho, por erro) ou ainda não processados, mesmo que o mês em
      // geral já esteja marcado como "completo".
      if (m.mediaBackupStatus !== "ok") continue;

      const t = new Date(m.date || m.sentAt || 0).getTime();
      if (!t || t > limite) continue;

      try {
        const fileName = m.mediaUrl.replace("/media/", "");
        const filePath = path.join(MEDIA_DIR, fileName);
        await fs.unlink(filePath);
      } catch {
        // Arquivo já não existe no disco — segue normalmente, só limpa a referência.
      }

      m.mediaUrl = null;
      m.mediaArchived = true;
      alterouAlgo = true;
      removidos++;
    }
  }

  if (alterouAlgo) {
    await saveConversations();
    console.log(`🗄️ Limpeza de mídia local: ${removidos} arquivo(s) removido(s) (já confirmados no backup do Drive)`);
  }
}

app.get("/pesquisa-config", authenticateToken, (req, res) => {
  res.json({
    sucesso: true,
    config: satisfactionSettings
  });
});

app.post("/pesquisa-config", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { enabled, cooldownDays, messageText } = req.body;

    if (typeof enabled === "boolean") satisfactionSettings.enabled = enabled;
    if (Number.isFinite(Number(cooldownDays)) && Number(cooldownDays) > 0) {
      satisfactionSettings.cooldownDays = Number(cooldownDays);
    }
    if (typeof messageText === "string" && messageText.trim()) {
      satisfactionSettings.messageText = messageText.trim();
    }

    await saveSatisfaction();

    return res.json({
      sucesso: true,
      config: satisfactionSettings
    });
  } catch (error) {
    console.error("Erro ao salvar configuração de pesquisa:", error);
    return res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

app.get("/pesquisas", authenticateToken, (req, res) => {
  res.json(satisfactionResponses);
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

app.post("/adicionar-etiqueta", authenticateToken, async (req, res) => {
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

app.post("/remover-etiqueta", authenticateToken, async (req, res) => {
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

    console.log(`📩 WAHA: ${req.body?.event} de ${req.body?.payload?.from || "?"}`);

    if (req.body?.event === "message.any") {
  await processarMensagemWaha(req.body);
}

   if (req.body?.event === "message.revoked") {
      await processarMensagemApagadaWaha(req.body);
    }

    if (req.body?.event === "message.reaction") {
      await processarReacaoWaha(req.body);
    }

  if (req.body?.event === "message.edited") {
      await processarMensagemEditadaWaha(req.body);
    }

    if (req.body?.event === "session.status") {
      const novoStatus = req.body?.payload?.status || null;
      if (novoStatus) {
        setConnectionStatus(novoStatus);
        console.log("🔌 session.status atualizado:", novoStatus);
        for (const [socketId, socket] of io.sockets.sockets) {
          socket.emit("status", { status: connectionStatus });
        }
      }
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

app.post("/enviar-transcricao", authenticateToken, async (req, res) => {
  try {
    const { subject, body, jid } = req.body;

    // Destino fixo e não configurável pelo cliente: evita que um atendente
    // desvie transcrições de conversas para um e-mail externo não
    // autorizado. Mesmo que a chamada venha direto da API (fora do app),
    // o destino nunca muda.
    const to = "atendimento@samutransportes.com.br";

    if (!subject || !body) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe subject e body"
      });
    }

    if (!RESEND_API_KEY) {
      return res.status(500).json({
        sucesso: false,
        erro: "Envio de e-mail não configurado no servidor (RESEND_API_KEY ausente)"
      });
    }

    // Anexa as mídias da conversa (imagens, áudios, vídeos, documentos) que
    // ainda estão salvas localmente em MEDIA_DIR, respeitando um limite de
    // segurança de tamanho total (a API do Resend recusa e-mails grandes
    // demais). Mídias que não couberem ficam de fora, com aviso no corpo.
    const LIMITE_ANEXOS_BYTES = 35 * 1024 * 1024;
    const attachments = [];
    const omitidos = [];

    if (jid) {
      const conversa = findConversationByJid(jid);
      if (conversa) {
        let totalBytes = 0;
        for (const m of conversa.messages) {
          if (!m.mediaUrl) continue;
          try {
            const fileName = m.mediaUrl.replace("/media/", "");
            const filePath = path.join(MEDIA_DIR, fileName);
            const stat = await fs.stat(filePath);

            if (totalBytes + stat.size > LIMITE_ANEXOS_BYTES) {
              omitidos.push(m.mediaName || fileName);
              continue;
            }

            const buffer = await fs.readFile(filePath);
            attachments.push({
              filename: m.mediaName || fileName,
              content: buffer.toString("base64")
            });
            totalBytes += stat.size;
          } catch {
            // Arquivo não encontrado no disco (ex: mídia antiga já removida) — ignora.
          }
        }
      }
    }

    const bodyComNota = omitidos.length > 0
      ? `${body}\n\n[Aviso: ${omitidos.length} anexo(s) não incluído(s) por limite de tamanho: ${omitidos.join(", ")}]`
      : body;

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: "STU Atendimento <onboarding@resend.dev>",
        to: [to],
        subject,
        text: bodyComNota,
        ...(attachments.length > 0 ? { attachments } : {})
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(500).json({
        sucesso: false,
        erro: "Erro ao enviar e-mail pelo Resend",
        detalhe: data
      });
    }

    return res.json({
      sucesso: true,
      id: data.id || null
    });

  } catch (error) {
    console.error("Erro ao enviar transcrição:", error);
    return res.status(500).json({
      sucesso: false,
      erro: "Erro ao enviar transcrição",
      detalhe: error.message
    });
  }
});

app.post("/mapear-telefone", authenticateToken, async (req, res) => {
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
  return res.status(400).json({ sucesso: false, erro: "Informe jid e mensagem" });
}

const internalJid = toInternalPhoneJid(jid);

let conversa = findConversationByJid(internalJid);

if (!conversa) {
  // Busca o nome salvo do contato na agenda do WhatsApp antes de criar a
  // conversa, para não precisar esperar a primeira resposta dele. Só se
  // aplica a contatos individuais (grupos já resolvem o nome por getGroupName).
  const nomeContato = !isGroupJid(internalJid) ? await getContactName(internalJid) : null;

  conversa = await getOrCreateConversation(
    internalJid,
    isGroupJid(internalJid),
    nomeContato || cleanJid(internalJid)
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
  const isFinalizationMessage =
  String(mensagem || "").includes("seu atendimento foi finalizado") ||
  String(mensagem || "").includes("Obrigado pelo contato");

const isReopenMessage =
  String(mensagem || "").includes("Bem-vindo") ||
  String(mensagem || "").includes("Olá");

const isSystemMessage = isFinalizationMessage || isReopenMessage;

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
    return res.status(409).json({
      sucesso: false,
      erro: "Assuma a conversa antes de enviar mensagens."
    });
  }
}

let chatId = quotedMessage?.waMessageId?.includes("_")
  ? quotedMessage.waMessageId.split("_")[1]
  : toWahaChatId(conversa.jid);

if (!isGroupJid(chatId)) {
  chatId = await getCanonicalChatId(chatId);
}

console.log(`ENVIANDO PARA WAHA: chatId=${chatId}${quotedMessage ? " (com citação)" : ""}`);   
    
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
  console.log(`RESPOSTA WAHA SENDTEXT: status=${response.status}`);

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
      waMessageId: buildWahaMessageId(chatId, data),
      contextInfo: quotedMessage
        ? { quotedMessage: { conversation: quotedMessage.text || "" } }
        : null
    });

  res.json({
     sucesso: true,
     jid: conversa.jid,
     mensagem,
     waha: data
});
    
  } catch (error) {
    console.error("Erro ao enviar mensagem:", error);
    res.status(500).json({ sucesso: false, erro: "Erro ao enviar mensagem", detalhe: error.message });
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

    if (message.deletedInWhatsApp) {
      return res.status(400).json({
        sucesso: false,
        erro: "Não é possível encaminhar uma mensagem apagada no WhatsApp"
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

    for (const destino of destinations) {
      
      const jidDestino =
        typeof destino === "string"
          ? destino
          : destino?.jid || destino?.whatsappId || null;

      if (!jidDestino) {
        resultados.push({
          destino,
          sucesso: false,
          erro: "Destino sem JID"
        });

        continue;
      }

      const conversaDestino = findConversationByJid(jidDestino);

      if (!conversaDestino) {
        resultados.push({
          destino: jidDestino,
          sucesso: false,
          erro: "Conversa de destino não encontrada"
        });

        continue;
      }

      // Em vez de bloquear o encaminhamento exigindo que o atendente assuma
      // manualmente a conversa de destino primeiro, assume automaticamente
      // como parte da própria ação de encaminhar (grupos já podem receber
      // mensagens independente de status, então não passam por aqui).
      if (!canSendInConversation(conversaDestino)) {
        const atendenteForward = req.user?.name || "Sistema";
        const eraFinalizada = conversaDestino.status === "finalizada";

        conversaDestino.status = "em_atendimento";
        conversaDestino.attendant = atendenteForward;
        conversaDestino.openedAt = conversaDestino.openedAt || new Date().toISOString();
        conversaDestino.openedBy = atendenteForward;

        addConversationHistory(conversaDestino, eraFinalizada ? "reabriu" : "assumiu", atendenteForward, {
          motivo: "Assumida automaticamente ao encaminhar mensagem.",
          status: "em_atendimento"
        });
      }
      let chatId = toWahaChatId(conversaDestino.jid);

      if (!isGroupJid(chatId)) {
        chatId = await getCanonicalChatId(chatId);
      }

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

      const data = await response.json().catch(() => ({}));

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
        senderName: req.user?.name || "STU Atendimento",
        text: texto,
        direction: "sent",
        waMessageId: buildWahaMessageId(chatId, data),
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

    if (!conversa) {
      return res.status(404).json({
        sucesso: false,
        erro: "Conversa não encontrada"
      });
    }

    if (!canSendInConversation(conversa)) {
      return res.status(409).json({
        sucesso: false,
        erro: "Assuma a conversa antes de enviar anexos."
      });
    }

    let chatId = toWahaChatId(conversa.jid);

    if (!isGroupJid(chatId)) {
      chatId = await getCanonicalChatId(chatId);
    }

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
      waMessageId: buildWahaMessageId(chatId, data),
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

app.post("/editar-mensagem", authenticateToken, async (req, res) => {
  try {
    const { jid, waMessageId, novoTexto } = req.body;

    if (!jid || !waMessageId || !novoTexto) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe jid, waMessageId e novoTexto"
      });
    }

    const conversa = findConversationByJid(jid);

    if (!conversa) {
      return res.status(404).json({
        sucesso: false,
        erro: "Conversa não encontrada"
      });
    }

    const chatId = toWahaChatId(conversa.jid);
    const encodedChatId = encodeURIComponent(chatId);
    const encodedMessageId = encodeURIComponent(waMessageId);

    const response = await fetch(
      `${WAHA_URL}/api/${WAHA_SESSION}/chats/${encodedChatId}/messages/${encodedMessageId}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: novoTexto,
          linkPreview: false,
          linkPreviewHighQuality: false
        })
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(500).json({
        sucesso: false,
        erro: "Erro ao editar mensagem pelo WAHA",
        detalhe: data
      });
    }

    const message = conversa.messages.find(
      m => extractRawMessageId(m.waMessageId) === extractRawMessageId(waMessageId)
    );

    const atendenteResponsavel = req.user?.name || "Sistema";

    if (message) {
      // Preserva o texto anterior antes de sobrescrever — nunca descarta o
      // conteúdo original de uma mensagem editada, para fins de auditoria.
      if (message.text !== novoTexto) {
        if (!message.editHistory) message.editHistory = [];
        message.editHistory.push({
          text: message.text,
          editedAt: new Date().toISOString()
        });
      }

      message.text = novoTexto;
      message.edited = true;
      message.editedAt = new Date().toISOString();
      message.editedByAttendant = atendenteResponsavel;
      message.editedNotice = `editada pelo atendente ${atendenteResponsavel}`;
    }

    addConversationHistory(conversa, "editou_mensagem", atendenteResponsavel, {
      waMessageId
    });

    await saveConversations();
    emitConversationsToConnectedUsers();

    return res.json({
      sucesso: true,
      jid: conversa.jid,
      waMessageId,
      novoTexto
    });

  } catch (error) {
    console.error("Erro ao editar mensagem:", error);
    return res.status(500).json({
      sucesso: false,
      erro: "Erro ao editar mensagem",
      detalhe: error.message
    });
  }
});

app.post("/apagar-mensagem", authenticateToken, async (req, res) => {
  try {
    const { jid, waMessageId } = req.body;

    if (!jid || !waMessageId) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe jid e waMessageId"
      });
    }

    const conversa = findConversationByJid(jid);

    if (!conversa) {
      return res.status(404).json({
        sucesso: false,
        erro: "Conversa não encontrada"
      });
    }

    const chatId = toWahaChatId(conversa.jid);
    const encodedChatId = encodeURIComponent(chatId);
    const encodedMessageId = encodeURIComponent(waMessageId);

    const response = await fetch(
      `${WAHA_URL}/api/${WAHA_SESSION}/chats/${encodedChatId}/messages/${encodedMessageId}`,
      { method: "DELETE" }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(500).json({
        sucesso: false,
        erro: "Erro ao apagar mensagem pelo WAHA",
        detalhe: data
      });
    }

    const message = conversa.messages.find(m => m.waMessageId === waMessageId);

    const atendenteResponsavel =
      req.user?.name || conversa.attendant || "Sistema";

    if (message) {
      message.deletedInWhatsApp = true;
      message.preservedInSystem = true;
      message.deletedByAttendant = atendenteResponsavel;
      message.deletedNotice = `Mensagem apagada pelo atendente ${atendenteResponsavel}`;
      message.updatedAt = new Date().toISOString();
    }

    addConversationHistory(conversa, "apagou_mensagem", req.user?.name || "Sistema", {
      waMessageId,
      atendenteResponsavel
    });

    await saveConversations();
    emitConversationsToConnectedUsers();

   return res.json({
      sucesso: true,
      jid: conversa.jid,
      waMessageId,
      deletedNotice: message?.deletedNotice || null
    });

  } catch (error) {
    console.error("Erro ao apagar mensagem:", error);
    return res.status(500).json({
      sucesso: false,
      erro: "Erro ao apagar mensagem",
      detalhe: error.message
    });
  }
});

app.post("/reagir-mensagem", authenticateToken, async (req, res) => {
  try {
    const { jid, waMessageId, emoji } = req.body;

    if (!jid || !waMessageId) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe jid e waMessageId"
      });
    }

    const conversa = findConversationByJid(jid);

    if (!conversa) {
      return res.status(404).json({
        sucesso: false,
        erro: "Conversa não encontrada"
      });
    }

    const response = await fetch(`${WAHA_URL}/api/reaction`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session: WAHA_SESSION,
        messageId: waMessageId,
        reaction: emoji || ""
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(500).json({
        sucesso: false,
        erro: "Erro ao reagir pelo WAHA",
        detalhe: data
      });
    }

    const message = conversa.messages.find(
      m => extractRawMessageId(m.waMessageId) === extractRawMessageId(waMessageId)
    );

    if (message) {
      message.reaction = emoji
        ? { emoji, by: "atendente", updatedAt: new Date().toISOString() }
        : null;
    }

    addConversationHistory(conversa, "reagiu_mensagem", req.user?.name || "Sistema", {
      waMessageId,
      emoji: emoji || null
    });

    await saveConversations();

    for (const [socketId, socket] of io.sockets.sockets) {
      const userName = socket.data?.userName;
      const role = socket.data?.role || "atendente";

      const conversasPermitidas = userName
        ? getConversationListByUser(userName, role)
        : getConversationList();

      const podeVerConversa = conversasPermitidas.some(c => c.jid === conversa.jid);

      if (podeVerConversa) {
        socket.emit("mensagemReagida", {
          jid: conversa.jid,
          waMessageId,
          message,
          conversation: conversa
        });
      }
    }

    emitConversationsToConnectedUsers();

    return res.json({
      sucesso: true,
      jid: conversa.jid,
      waMessageId,
      emoji: emoji || null
    });

  } catch (error) {
    console.error("Erro ao reagir mensagem:", error);
    return res.status(500).json({
      sucesso: false,
      erro: "Erro ao reagir mensagem",
      detalhe: error.message
    });
  }
});

app.post("/admin/limpar-conversas", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { senha } = req.body || {};

    if (!CONFIRM_LIMPEZA_SENHA) {
      return res.status(500).json({ sucesso: false, erro: "CONFIRM_LIMPEZA_SENHA não configurada no servidor" });
    }

    if (senha !== CONFIRM_LIMPEZA_SENHA) {
      return res.status(400).json({ sucesso: false, erro: "Senha de confirmação incorreta" });
    }

    const arquivosMedia = await fs.readdir(MEDIA_DIR).catch(() => []);
    for (const arquivo of arquivosMedia) {
      await fs.unlink(path.join(MEDIA_DIR, arquivo)).catch(() => {});
    }

    clientConversations = [];
    groupConversations = [];
    lidToPhone = {};
    phoneToLid = {};
    groupNameCache = {};
    satisfactionSentMap = {};
    satisfactionAwaiting = {};
    satisfactionResponses = [];
    backupState = { mesesSalvos: [], mesesMidiaCompleta: [], ultimaVerificacao: null, ultimasExecucoes: [] };

    await saveConversations();
    await saveLidMap();
    await saveSatisfaction();
    await saveBackupState();

    emitConversationsToConnectedUsers();

    return res.json({
      sucesso: true,
      mensagem: "Conversas, mídia, mapeamento de contatos, pesquisas de satisfação e histórico de backup foram limpos. Usuários, etiquetas e mensagens rápidas foram preservados."
    });
  } catch (error) {
    console.error("Erro ao limpar conversas:", error);
    return res.status(500).json({ sucesso: false, erro: error.message });
  }
});

app.post("/desconectar", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const response = await fetch(`${WAHA_URL}/api/sessions/${WAHA_SESSION}/logout`, {
      method: "POST"
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(500).json({
        sucesso: false,
        erro: "Erro ao desconectar pelo WAHA",
        detalhe: data
      });
    }

    setConnectionStatus("WAHA DESCONECTADO");
    lastQr = null;
    
    for (const [socketId, socket] of io.sockets.sockets) {
      socket.emit("status", { status: connectionStatus });
    }

    return res.json({
      sucesso: true,
      mensagem: "Sessão desconectada. Use /reconectar para gerar um novo QR code."
    });

  } catch (error) {
    console.error("Erro ao desconectar sessão:", error);
    return res.status(500).json({
      sucesso: false,
      erro: "Erro ao desconectar sessão",
      detalhe: error.message
    });
  }
});

app.post("/reconectar", authenticateToken, requireAdmin, async (req, res) => {
  try {
    await startWahaSessionWithStore();

    return res.json({
      sucesso: true,
      mensagem: "Sessão reiniciada. Consulte /qr-atual para obter o QR code."
    });

  } catch (error) {
    console.error("Erro ao reconectar sessão:", error);
    return res.status(500).json({
      sucesso: false,
      erro: "Erro ao reconectar sessão",
      detalhe: error.message
    });
  }
});

app.get("/qr-atual", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const response = await fetch(`${WAHA_URL}/api/${WAHA_SESSION}/auth/qr`);

    if (!response.ok) {
      return res.status(response.status).json({
        sucesso: false,
        erro: "QR code não disponível no momento (sessão pode já estar conectada ou não ter sido iniciada)"
      });
    }

    const contentType = response.headers.get("content-type") || "image/png";
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.set("Content-Type", contentType);
    return res.send(buffer);

  } catch (error) {
    console.error("Erro ao buscar QR code:", error);
    return res.status(500).json({
      sucesso: false,
      erro: "Erro ao buscar QR code",
      detalhe: error.message
    });
  }
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
  await loadSatisfaction();
  await loadBackupState();
  await startWahaSessionWithStore();
  await sincronizarFotosChatsOverview();

setInterval(() => {
  sincronizarFotosChatsOverview();
}, 30 * 60 * 1000);

// Roda a limpeza de mídia local uma vez por dia (com um atraso inicial de
// 1 minuto após o boot, para não competir com a inicialização da sessão WAHA).
setTimeout(() => {
  limparMidiaLocalAntiga();
  setInterval(() => {
    limparMidiaLocalAntiga();
  }, 24 * 60 * 60 * 1000);
}, 60 * 1000);
  
  console.log("Servidor rodando na porta", PORT);
  console.log("WAHA MODE ATIVO - Baileys desativado");
  console.log("WAHA_URL:", WAHA_URL);
  console.log("WAHA_SESSION:", WAHA_SESSION);
});
