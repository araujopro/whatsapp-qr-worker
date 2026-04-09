import express from "express";

const app = express();

// 🔥 CORS LIBERADO TOTAL (ESSENCIAL)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "*");
  next();
});

// 🔥 HEALTH PADRÃO (OBRIGATÓRIO)
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "whatsapp-qr-worker",
    online: true,
    whatsapp_connected: false,
    status: "ready"
  });
});
