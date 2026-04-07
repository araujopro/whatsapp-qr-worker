import express from "express";
import pkg from "whatsapp-web.js";
import qrcode from "qrcode";

const { Client, LocalAuth } = pkg;

const app = express();
const port = process.env.PORT || 3000;

let client;
let currentQR = null;

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "whatsapp-qr-worker",
    sessions: client ? 1 : 0
  });
});

app.get("/session/create", async (req, res) => {
  if (client) {
    return res.json({ ok: true, message: "Sessão já iniciada" });
  }

  client = new Client({
    authStrategy: new LocalAuth()
  });

  client.on("qr", async (qr) => {
    currentQR = await qrcode.toDataURL(qr);
  });

  client.on("ready", () => {
    console.log("WhatsApp conectado!");
  });

  await client.initialize();

  setTimeout(() => {
    res.json({
      ok: true,
      qr: currentQR
    });
  }, 5000);
});

app.listen(port, () => {
  console.log("Servidor rodando na porta", port);
});
