import express from "express";
import QRCode from "qrcode";
import fs from "node:fs/promises";
import path from "node:path";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";

const app = express();
app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const PORT = Number(process.env.PORT || 8080);
const WEBHOOK_URL = (process.env.WEBHOOK_URL || "").trim();
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET || "").trim();
const SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY || "").trim();
const SESSION_STORAGE_DIR = path.resolve(
  process.env.SESSION_STORAGE_DIR || "/data/baileys-auth"
);
const META_FILE = path.join(SESSION_STORAGE_DIR, "_metadata.json");

const sessions = new Map();
let metadata = {};

function log(level, message, extra = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      message,
      ...extra,
    })
  );
}

function normalizePhone(value = "") {
  return String(value).replace(/\D/g, "");
}

function jidToPhone(jid = "") {
  return normalizePhone(String(jid).split("@")[0] || "");
}

function getAuthDir(sessionId) {
  return path.join(SESSION_STORAGE_DIR, sessionId);
}

async function ensureStorage() {
  await fs.mkdir(SESSION_STORAGE_DIR, { recursive: true });
}

async function loadMetadata() {
  try {
    const raw = await fs.readFile(META_FILE, "utf8");
    metadata = JSON.parse(raw);
  } catch {
    metadata = {};
  }
}

async function persistMetadata() {
  await ensureStorage();
  const temp = `${META_FILE}.tmp`;
  await fs.writeFile(temp, JSON.stringify(metadata, null, 2), "utf8");
  await fs.rename(temp, META_FILE);
}

function getSessionState(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      sessionId,
      socket: null,
      status: metadata[sessionId]?.status || "disconnected",
      qr: metadata[sessionId]?.qr || null,
      phone: metadata[sessionId]?.phone || null,
      lastError: metadata[sessionId]?.lastError || null,
      lastDisconnectReason: metadata[sessionId]?.lastDisconnectReason || null,
      reconnectTimer: null,
      reconnectAttempts: metadata[sessionId]?.reconnectAttempts || 0,
      starting: false,
    });
  }
  return sessions.get(sessionId);
}

async function updateSessionState(sessionId, patch = {}) {
  const current = getSessionState(sessionId);
  Object.assign(current, patch);
  metadata[sessionId] = {
    sessionId,
    status: current.status,
    qr: current.qr,
    phone: current.phone,
    lastError: current.lastError,
    lastDisconnectReason: current.lastDisconnectReason,
    reconnectAttempts: current.reconnectAttempts || 0,
    updatedAt: new Date().toISOString(),
  };
  await persistMetadata();
  return current;
}

function publicSession(current) {
  return {
    id: current.sessionId,
    sessionId: current.sessionId,
    state: current.status,
    status: current.status,
    connected: current.status === "connected",
    phone: current.phone || null,
    qr: current.qr || null,
    whatsapp_connected: current.status === "connected",
    lastError: current.lastError || null,
    lastDisconnectReason: current.lastDisconnectReason || null,
  };
}

function aggregateStatus() {
  const list = Array.from(sessions.values()).map(publicSession);
  const priority = ["connected", "qr_ready", "connecting", "logged_out", "disconnected"];
  const selected =
    priority.map((status) => list.find((item) => item.status === status)).find(Boolean) ||
    list[0] || {
      id: null,
      status: "disconnected",
      whatsapp_connected: false,
      phone: null,
    };

  return {
    ok: true,
    service: "whatsapp-qr-worker",
    online: true,
    whatsapp_connected: selected.status === "connected",
    status: selected.status,
    sessionId: selected.id,
    sessions: list,
  };
}

async function sendWebhook(sessionId, event, data = {}) {
  if (!WEBHOOK_URL) {
    log("warn", "WEBHOOK_URL ausente; evento não enviado", { sessionId, event });
    return;
  }

  const headers = {
    "Content-Type": "application/json",
  };

  if (WEBHOOK_SECRET) headers["x-webhook-secret"] = WEBHOOK_SECRET;
  if (SUPABASE_ANON_KEY) {
    headers.apikey = SUPABASE_ANON_KEY;
    headers.Authorization = `Bearer ${SUPABASE_ANON_KEY}`;
  }

  const payload = {
    sessionId,
    event,
    channel: "whatsapp",
    timestamp: new Date().toISOString(),
    data,
  };

  try {
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    const text = await response.text();

    log(response.ok ? "info" : "error", "webhook enviado", {
      sessionId,
      event,
      status: response.status,
      response: text.slice(0, 500),
    });
  } catch (error) {
    log("error", "falha ao enviar webhook", {
      sessionId,
      event,
      error: String(error),
    });
  }
}

function extractText(message) {
  if (!message) return "";
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.documentMessage?.caption) return message.documentMessage.caption;
  if (message.ephemeralMessage?.message) return extractText(message.ephemeralMessage.message);
  if (message.viewOnceMessageV2?.message) return extractText(message.viewOnceMessageV2.message);
  return "";
}

function detectType(message) {
  if (!message) return "text";
  if (message.conversation || message.extendedTextMessage) return "text";
  const key = Object.keys(message)[0];
  return key || "text";
}

function clearReconnectTimer(current) {
  if (current.reconnectTimer) {
    clearTimeout(current.reconnectTimer);
    current.reconnectTimer = null;
  }
}

async function removeSessionFiles(sessionId) {
  await fs.rm(getAuthDir(sessionId), { recursive: true, force: true });
}

async function connectSession(sessionId, { forceFresh = false } = {}) {
  const current = getSessionState(sessionId);
  if (current.starting) return current;

  current.starting = true;
  clearReconnectTimer(current);

  try {
    await ensureStorage();
    const authDir = getAuthDir(sessionId);

    if (forceFresh) {
      await removeSessionFiles(sessionId);
      await updateSessionState(sessionId, {
        status: "disconnected",
        qr: null,
        phone: null,
        lastError: null,
        lastDisconnectReason: null,
        reconnectAttempts: 0,
      });
      log("info", "sessão limpa para novo pareamento", { sessionId });
    }

    await fs.mkdir(authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const socket = makeWASocket({
      auth: state,
      version,
      browser: Browsers.ubuntu("Impulsao AI"),
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      defaultQueryTimeoutMs: 15000,
      connectTimeoutMs: 30000,
      keepAliveIntervalMs: 15000,
      qrTimeout: 60000,
      retryRequestDelayMs: 250,
      maxMsgRetryCount: 2,
    });

    current.socket = socket;

    await updateSessionState(sessionId, {
      status: "connecting",
      qr: null,
      lastError: null,
    });

    log("info", "iniciando conexão da sessão", { sessionId });

    socket.ev.on("creds.update", async () => {
      await saveCreds();
      log("info", "sessão persistida com sucesso", { sessionId });
    });

    socket.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 512 });
        await updateSessionState(sessionId, {
          status: "qr_ready",
          qr: qrDataUrl,
          lastError: null,
        });
        log("info", "QR gerado", { sessionId });
      }

      if (connection === "connecting") {
        await updateSessionState(sessionId, {
          status: "connecting",
          lastError: null,
        });
        log("info", "sessão conectando", { sessionId });
      }

      if (connection === "open") {
        const phone = jidToPhone(socket.user?.id || "");
        await updateSessionState(sessionId, {
          status: "connected",
          qr: null,
          phone: phone || null,
          reconnectAttempts: 0,
          lastDisconnectReason: null,
          lastError: null,
        });

        log("info", "conexão aberta", { sessionId, phone });

        await sendWebhook(sessionId, "session.connected", {
          phone,
          me: { id: socket.user?.id || null },
          name: socket.user?.name || "WhatsApp QR",
        });
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        const reason = loggedOut ? "logged_out" : String(statusCode || "connection_closed");

        current.socket = null;

        if (loggedOut) {
          clearReconnectTimer(current);
          await removeSessionFiles(sessionId);
          await updateSessionState(sessionId, {
            status: "logged_out",
            qr: null,
            phone: null,
            lastDisconnectReason: reason,
            lastError: reason,
            reconnectAttempts: 0,
          });

          log("warn", "sessão perdida / logged out", { sessionId, reason });
          await sendWebhook(sessionId, "session.disconnected", { reason: "logged_out" });
          return;
        }

        await updateSessionState(sessionId, {
          status: "disconnected",
          lastDisconnectReason: reason,
          lastError: reason,
        });

        log("error", "conexão fechada", { sessionId, reason });
        await sendWebhook(sessionId, "session.disconnected", { reason });

        const attempts = (current.reconnectAttempts || 0) + 1;
        const delay = Math.min(30000, Math.max(2000, attempts * 3000));

        await updateSessionState(sessionId, { reconnectAttempts: attempts });

        clearReconnectTimer(current);
        current.reconnectTimer = setTimeout(() => {
          connectSession(sessionId).catch((error) => {
            log("error", "erro ao reconectar sessão", {
              sessionId,
              error: String(error),
            });
          });
        }, delay);
      }
    });

    socket.ev.on("messages.upsert", async ({ messages = [], type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        if (!msg?.message) continue;
        if (msg.key?.fromMe) continue;

        const remoteJid = msg.key?.remoteJid || "";
        if (!remoteJid || remoteJid.endsWith("@status")) continue;

        const body = extractText(msg.message);
        const from = jidToPhone(remoteJid);
        if (!from || !body) continue;

        const payload = {
          from,
          sender: from,
          remoteJid,
          sender_name: msg.pushName || `+${from}`,
          notifyName: msg.pushName || `+${from}`,
          pushName: msg.pushName || `+${from}`,
          body,
          text: body,
          message: body,
          type: detectType(msg.message),
          id: msg.key?.id || null,
          key: msg.key || null,
          timestamp: msg.messageTimestamp || null,
        };

        log("info", "mensagem recebida", {
          sessionId,
          from,
          messageId: payload.id,
        });

        await sendWebhook(sessionId, "message.received", payload);
      }
    });

    return current;
  } finally {
    current.starting = false;
  }
}

async function ensureSession(sessionId) {
  const current = getSessionState(sessionId);
  const authDir = getAuthDir(sessionId);

  try {
    await fs.access(authDir);
    if (!current.socket && !current.starting) {
      await connectSession(sessionId);
    }
  } catch {
    if (!current.socket && !current.starting && current.status === "logged_out") {
      return current;
    }
  }

  return getSessionState(sessionId);
}

app.get("/", (req, res) => {
  return res.status(200).json({
    ok: true,
    service: "whatsapp-qr-worker",
    online: true,
    status: "ready",
  });
});

app.get("/health", (req, res) => {
  return res.status(200).json({
    ok: true,
    service: "whatsapp-qr-worker",
    online: true,
    status: "ready",
  });
});

app.get("/status", async (req, res) => {
  const sessionId = String(req.query.sessionId || req.query.session_id || "").trim();
  if (sessionId) await ensureSession(sessionId);
  return res.json(aggregateStatus());
});

app.get("/qr", async (req, res) => {
  const sessionId = String(req.query.sessionId || req.query.session_id || "").trim();
  if (!sessionId) {
    return res.status(400).json({ ok: false, error: "sessionId required" });
  }

  let current = await ensureSession(sessionId);
  if (!current.socket && current.status !== "connected") {
    current = await connectSession(sessionId, {
      forceFresh: current.status === "logged_out",
    });
  }

  current = getSessionState(sessionId);

  return res.json({
    ok: true,
    service: "whatsapp-qr-worker",
    online: true,
    whatsapp_connected: current.status === "connected",
    status: current.status,
    sessionId,
    qr: current.status === "qr_ready" ? current.qr : null,
    session: publicSession(current),
  });
});

app.get("/session/create", async (req, res) => {
  const sessionId = String(req.query.sessionId || req.query.session_id || "").trim();
  if (!sessionId) {
    return res.status(400).json({ ok: false, error: "sessionId required" });
  }

  let current = await ensureSession(sessionId);
  if (!current.socket || ["disconnected", "logged_out"].includes(current.status)) {
    current = await connectSession(sessionId, {
      forceFresh: current.status === "logged_out",
    });
  }

  current = getSessionState(sessionId);
  return res.json({
    ok: true,
    session: publicSession(current),
    qr: current.qr,
  });
});

app.get("/session/:sessionId/status", async (req, res) => {
  const sessionId = String(req.params.sessionId || "").trim();
  if (!sessionId) {
    return res.status(400).json({ ok: false, error: "sessionId required" });
  }

  const current = await ensureSession(sessionId);
  return res.json({
    ok: true,
    session: publicSession(current),
    qr: current.qr,
  });
});

app.get("/session/:sessionId/delete", async (req, res) => {
  const sessionId = String(req.params.sessionId || "").trim();
  if (!sessionId) {
    return res.status(400).json({ ok: false, error: "sessionId required" });
  }

  const current = getSessionState(sessionId);
  clearReconnectTimer(current);

  try {
    await current.socket?.logout();
  } catch {}

  try {
    current.socket?.end?.();
  } catch {}

  current.socket = null;

  await removeSessionFiles(sessionId);
  await updateSessionState(sessionId, {
    status: "disconnected",
    qr: null,
    phone: null,
    lastError: null,
    lastDisconnectReason: null,
    reconnectAttempts: 0,
  });

  log("info", "sessão removida", { sessionId });

  return res.json({
    ok: true,
    session: publicSession(getSessionState(sessionId)),
  });
});

app.post("/session/:sessionId/send", async (req, res) => {
  const sessionId = String(req.params.sessionId || "").trim();
  const to = normalizePhone(req.body?.to || "");
  const message = String(req.body?.message || req.body?.text || "").trim();

  if (!sessionId) {
    return res.status(400).json({ ok: false, error: "sessionId required" });
  }

  if (!to || to.length < 10 || to.length > 15) {
    return res.status(400).json({ ok: false, error: "invalid destination" });
  }

  if (!message) {
    return res.status(400).json({ ok: false, error: "message required" });
  }

  const current = await ensureSession(sessionId);
  if (!current.socket || current.status !== "connected") {
    return res.status(409).json({
      ok: false,
      error: "session not connected",
      status: current.status,
    });
  }

  const jid = `${to}@s.whatsapp.net`;
  const result = await current.socket.sendMessage(jid, { text: message });
  const messageId = result?.key?.id || null;

  log("info", "mensagem enviada", { sessionId, to, messageId });

  await sendWebhook(sessionId, "message.sent", {
    to,
    remoteJid: jid,
    body: message,
    text: message,
    content: message,
    id: messageId,
    key: result?.key || null,
  });

  return res.json({
    ok: true,
    messageId,
    session: publicSession(current),
  });
});

async function bootstrap() {
  await ensureStorage();
  await loadMetadata();

  const entries = await fs.readdir(SESSION_STORAGE_DIR, { withFileTypes: true }).catch(() => []);
  const sessionDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

  for (const sessionId of sessionDirs) {
    log("info", "restaurando sessão persistida", { sessionId });
    connectSession(sessionId).catch((error) => {
      log("error", "falha ao restaurar sessão", {
        sessionId,
        error: String(error),
      });
    });
  }
}

app.listen(PORT, "0.0.0.0", () => {
  log("info", "worker iniciado", { port: PORT, storage: SESSION_STORAGE_DIR });

  bootstrap().catch((error) => {
    log("error", "falha no bootstrap em background", {
      error: String(error),
    });
  });
});
