# WhatsApp QR Worker v2

Worker pronto para Railway com persistência real de sessão via volume em `/data`.

## Variáveis obrigatórias

- `WEBHOOK_URL`
- `SUPABASE_ANON_KEY`

## Variáveis opcionais

- `WEBHOOK_SECRET`
- `PORT` (padrão `3000`)
- `SESSION_STORAGE_DIR` (padrão `/data/baileys-auth`)
- `LOG_LEVEL` (padrão `info`)

## Railway

1. Faça deploy desta pasta.
2. Crie um volume e monte em `/data`.
3. Configure `WEBHOOK_URL` apontando para a function `whatsapp-qr-webhook`.
4. Configure `SUPABASE_ANON_KEY` e, se usar, `WEBHOOK_SECRET`.
5. Após escanear uma vez, a sessão será restaurada automaticamente nos restarts.

## Endpoints

- `GET /`
- `GET /health`
- `GET /qr?sessionId=...`
- `GET /session/create?sessionId=...`
- `GET /session/:sessionId/status`
- `GET /session/:sessionId/delete`
- `POST /session/:sessionId/send`
