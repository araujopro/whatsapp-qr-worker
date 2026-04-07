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
const SESSIONS_DIR = path.join(process.cwd(), "sessions");

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

const logger = pino({ level: "info" });
const sessions = new Map();

function nowIso() {
  return new Date().toISOString();
}

function sanitizeSessionId(id) {
  return String(id || "").replace(/[^a-zA-Z0-9_-]/g, "");
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

async function initSocket(sessionId) {
  const safeId = sanitizeSessionId(sessionId);
  if (!safeId) throw new Error("session_id inválido");

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
    lastError: null,
    phone: existing?.phone || null,
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
        qr: null,
        phone,
        lastError: null,
      });

      logger.info({ sessionId: safeId, phone }, "WhatsApp conectado");
    }

    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (statusCode === DisconnectReason.loggedOut) {
        setSessionState(safeId, {
          state: "disconnected",
          qr: null,
          lastError: "Sessão deslogada",
        });
      } else {
        setSessionState(safeId, {
          state: "initializing",
          qr: null,
          lastError: `Conexão fechada (${statusCode || "desconhecido"})`,
        });

        if (shouldReconnect) {
          setTimeout(() => {
            initSocket(safeId).catch((error) => {
              logger.error({ sessionId: safeId, error: String(error) }, "Reconnect falhou");
              setSessionState(safeId, {
                state: "error",
                lastError: String(error),
              });
            });
          }, 3000);
        }
      }
    }
  });

  return sock;
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
    logger.error({ error: String(error) }, "session/create falhou");
    return res.status(500).json({ ok: false, error: String(error) });
  }
});

app.get("/session/:id/status", (req, res) => {
  try {
    const sessionId = sanitizeSessionId(req.params.id);
    const session = sessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ ok: false, error: "Sessão não encontrada" });
    }

    return res.json({
      ok: true,
      session: getSessionSummary(sessionId),
      qr: session.qr || null,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error) });
  }
});

app.listen(PORT, () => {
  logger.info({ port: PORT }, "QR worker iniciado");
});
