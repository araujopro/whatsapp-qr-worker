const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");
const pino = require("pino");
const { Boom } = require("@hapi/boom");

const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const SESSIONS_DIR = path.join(process.cwd(), "sessions");

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const sessions = new Map();

function nowIso() {
  return new Date().toISOString();
}

function sanitizeSessionId(id) {
  return String(id || "").replace(/[^a-zA-Z0-9_-]/g, "");
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function getSessionPath(sessionId) {
  return path.join(SESSIONS_DIR, sessionId);
}

function setSessionState(sessionId, patch) {
  const current = sessions.get(sessionId);
  if (!current) return;

  sessions.set(sessionId, {
    ...current,
    ...patch,
    updatedAt: nowIso(),
  });
}

async function postWebhook(event, payload) {
  if (!WEBHOOK_URL) return;

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        event,
        secret: WEBHOOK_SECRET,
        payload,
        timestamp: nowIso(),
      }),
    });

    if (!res.ok) {
      logger.warn(
        { event, status: res.status },
        "Webhook retornou status não-2xx"
      );
    }
  } catch (error) {
    logger.warn({ error: String(error) }, "Falha ao enviar webhook");
  }
}

function getSessionSummary(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return null;

  return {
    id: s.id,
    state: s.state,
    phone: s.phone,
    hasQr: Boolean(s.qr),
    lastError: s.lastError,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

async function initSocket(sessionId) {
  const safeId = sanitizeSessionId(sessionId);
  if (!safeId) throw new Error("sessionId inválido");

  const sessionPath = getSessionPath(safeId);
  fs.mkdirSync(sessionPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    browser: ["ImpulsaoAI QR Worker", "Chrome", "1.0.0"],
  });

  const existing = sessions.get(safeId);

  sessions.set(safeId, {
    id: safeId,
    sock,
    state: existing?.state || "initializing",
    qr: existing?.qr || null,
    phone: existing?.phone || null,
    lastError: null,
    createdAt: existing?.createdAt || nowIso(),
    updatedAt: nowIso(),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr);
        setSessionState(safeId, {
          state: "awaiting_qr",
          qr: qrDataUrl,
          lastError: null,
        });
        logger.info({ sessionId: safeId }, "QR gerado");
      } catch (error) {
        setSessionState(safeId, {
          state: "error",
          lastError: `Erro ao gerar QR: ${String(error)}`,
        });
      }
    }

    if (connection === "open") {
      const userId = sock.user?.id || "";
      const phone = userId.split(":")[0] || null;

      setSessionState(safeId, {
        state: "connected",
        phone,
        qr: null,
        lastError: null,
      });

      logger.info({ sessionId: safeId, phone }, "WhatsApp conectado");

      await postWebhook("session.connected", {
        sessionId: safeId,
        phone,
        user: sock.user || null,
      });
    }

    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      logger.warn(
        { sessionId: safeId, statusCode, loggedOut },
        "Conexão encerrada"
      );

      if (loggedOut) {
        setSessionState(safeId, {
          state: "disconnected",
          qr: null,
          lastError: "Sessão deslogada",
        });

        await postWebhook("session.disconnected", {
          sessionId: safeId,
          reason: "logged_out",
        });
      } else {
        setSessionState(safeId, {
          state: "initializing",
          qr: null,
          lastError: `Conexão fechada (${statusCode || "desconhecido"})`,
        });

        setTimeout(() => {
          initSocket(safeId).catch((error) => {
            logger.error(
              { sessionId: safeId, error: String(error) },
              "Falha no reconnect"
            );

            setSessionState(safeId, {
              state: "error",
              lastError: String(error),
            });
          });
        }, 3000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid || "";
      const from = remoteJid
        .replace("@s.whatsapp.net", "")
        .replace("@g.us", "");
      const pushName = msg.pushName || "";
      const messageId = msg.key.id || "";

      let text = "";
      if (msg.message.conversation) {
        text = msg.message.conversation;
      } else if (msg.message.extendedTextMessage?.text) {
        text = msg.message.extendedTextMessage.text;
      } else if (msg.message.imageMessage?.caption) {
        text = msg.message.imageMessage.caption;
      } else if (msg.message.videoMessage?.caption) {
        text = msg.message.videoMessage.caption;
      }

      logger.info(
        { sessionId: safeId, from, messageId, text },
        "Mensagem recebida"
      );

      await postWebhook("message.received", {
        sessionId: safeId,
        from,
        pushName,
        messageId,
        text,
        raw: msg,
      });
    }
  });

  return sock;
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "whatsapp-qr-worker",
    sessions: Array.from(sessions.keys()).length,
    timestamp: nowIso(),
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "whatsapp-qr-worker",
    timestamp: nowIso(),
  });
});

app.get("/session/create", async (req, res) => {
  try {
    const sessionId = sanitizeSessionId(req.query.sessionId || "default");

    const existing = sessions.get(sessionId);
    if (
      existing?.state === "connected" ||
      existing?.state === "awaiting_qr" ||
      existing?.state === "initializing"
    ) {
      return res.json({
        ok: true,
        reused: true,
        session: getSessionSummary(sessionId),
        qr: existing?.qr || null,
      });
    }

    await initSocket(sessionId);

    setTimeout(() => {
      const current = sessions.get(sessionId);
      res.json({
        ok: true,
        reused: false,
        session: getSessionSummary(sessionId),
        qr: current?.qr || null,
      });
    }, 4000);
  } catch (error) {
    logger.error({ error: String(error) }, "Falha em /session/create");
    res.status(500).json({
      ok: false,
      error: String(error),
    });
  }
});

app.get("/session/:id/status", (req, res) => {
  try {
    const sessionId = sanitizeSessionId(req.params.id);
    const session = sessions.get(sessionId);

    if (!session) {
      return res.status(404).json({
        ok: false,
        error: "Sessão não encontrada",
      });
    }

    res.json({
      ok: true,
      session: getSessionSummary(sessionId),
      qr: session.qr || null,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error),
    });
  }
});

app.post("/session/:id/send", async (req, res) => {
  try {
    const sessionId = sanitizeSessionId(req.params.id);
    const to = normalizePhone(req.body?.to);
    const text = String(req.body?.text || "").trim();

    if (!to || !text) {
      return res.status(400).json({
        ok: false,
        error: "to e text são obrigatórios",
      });
    }

    const session = sessions.get(sessionId);
    if (!session || !session.sock) {
      return res.status(404).json({
        ok: false,
        error: "Sessão não encontrada",
      });
    }

    if (session.state !== "connected") {
      return res.status(409).json({
        ok: false,
        error: "Sessão não está conectada",
      });
    }

    const jid = `${to}@s.whatsapp.net`;
    const result = await session.sock.sendMessage(jid, { text });

    logger.info({ sessionId, to }, "Mensagem enviada");

    await postWebhook("message.sent", {
      sessionId,
      to,
      text,
      result,
    });

    res.json({
      ok: true,
      to,
      result,
    });
  } catch (error) {
    logger.error({ error: String(error) }, "Falha em /session/:id/send");
    res.status(500).json({
      ok: false,
      error: String(error),
    });
  }
});

app.delete("/session/:id", async (req, res) => {
  try {
    const sessionId = sanitizeSessionId(req.params.id);
    const session = sessions.get(sessionId);

    if (session?.sock) {
      try {
        await session.sock.logout();
      } catch (_) {}
    }

    sessions.delete(sessionId);
    fs.rmSync(getSessionPath(sessionId), { recursive: true, force: true });

    res.json({
      ok: true,
      deleted: true,
      sessionId,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error),
    });
  }
});

app.listen(PORT, () => {
  logger.info({ port: PORT }, "QR worker iniciado");
});
