const express = require("express");
const pkg = require("whatsapp-web.js");
const qrcode = require("qrcode");

const { Client, LocalAuth } = pkg;

const app = express();
const port = process.env.PORT || 3000;

let client = null;
let currentQR = null;
let ready = false;

app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "whatsapp-qr-worker",
    ready,
    hasClient: !!client
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "whatsapp-qr-worker",
    ready
  });
});

function createClient() {
  return new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--single-process"
      ]
    }
  });
}

async function startSession() {
  if (client) return;

  client = createClient();

  client.on("qr", async (qr) => {
    currentQR = await qrcode.toDataURL(qr);
    console.log("QR gerado");
  });

  client.on("ready", () => {
    ready = true;
    console.log("WhatsApp conectado");
  });

  client.on("disconnected", (reason) => {
    console.log("WhatsApp desconectado:", reason);
    client = null;
    currentQR = null;
    ready = false;
  });

  client.on("auth_failure", (msg) => {
    console.error("Falha de autenticação:", msg);
  });

  await client.initialize();
}

app.get("/session/create", async (req, res) => {
  try {
    if (!client) {
      await startSession();
    }

    setTimeout(() => {
      res.json({
        ok: true,
        ready,
        qr: currentQR
      });
    }, 5000);
  } catch (error) {
    console.error("Erro em /session/create:", error);
    res.status(500).json({
      ok: false,
      error: String(error),
      stack: error?.stack || null
    });
  }
});

app.get("/session/status", (req, res) => {
  res.json({
    ok: true,
    ready,
    hasClient: !!client,
    hasQr: !!currentQR
  });
});

app.listen(port, () => {
  console.log("Servidor rodando na porta", port);
});
