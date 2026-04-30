import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Worker ONLINE");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "whatsapp-worker"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server rodando na porta", PORT);
});
