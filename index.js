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

app.get("/session/create", async (req, res) => {
  try {
    if (client) {
      return res.json({
        ok: true,
        message: "Sessão já iniciada",
        ready,
        qr: currentQR
      });
    }

    client = new Client({
      authStrategy: new LocalAuth()
    });

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

    client.initialize();

    setTimeout(() => {
      res.json({
        ok: true,
        ready,
        qr: currentQR
      });
    }, 5000);
  } catch (error) {
    console.error("Erro:", error);
    res.status(500).json({
      ok: false,
      error: String(error)
    });
  }
});

app.listen(port, () => {
  console.log("Servidor rodando na porta", port);
});
