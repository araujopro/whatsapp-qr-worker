const express = require('express')
const app = express()

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'whatsapp-qr-worker'
  })
})

const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
  console.log(`🚀 Servidor HTTP rodando na porta ${PORT}`)
})const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState
} = require('@whiskeysockets/baileys')

const qrcode = require('qrcode-terminal')
const pino = require('pino')

const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

function validateEnv() {
  const required = ['WEBHOOK_URL', 'WEBHOOK_SECRET', 'SUPABASE_ANON_KEY']
  const missing = required.filter((key) => !process.env[key])

  if (missing.length > 0) {
    console.error('❌ Variáveis ausentes:', missing.join(', '))
    process.exit(1)
  }
}

function extractMessageText(msg) {
  return (
    msg?.message?.conversation ||
    msg?.message?.extendedTextMessage?.text ||
    msg?.message?.imageMessage?.caption ||
    msg?.message?.videoMessage?.caption ||
    msg?.message?.documentMessage?.caption ||
    msg?.message?.buttonsResponseMessage?.selectedButtonId ||
    msg?.message?.listResponseMessage?.title ||
    ''
  )
}

async function sendToWebhook(data) {
  try {
    const response = await fetch(process.env.WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: process.env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        'x-webhook-secret': process.env.WEBHOOK_SECRET
      },
      body: JSON.stringify(data)
    })

    const text = await response.text()

    console.log('📡 Webhook status:', response.status)
    console.log('📡 Webhook response:', text)

    if (!response.ok) {
      throw new Error(`Webhook falhou: ${response.status} - ${text}`)
    }

    return true
  } catch (error) {
    console.error('❌ Erro ao enviar webhook:', error.message)
    return false
  }
}

async function startWhatsApp() {
  validateEnv()

  const { state, saveCreds } = await useMultiFileAuthState('auth')

  const sock = makeWASocket({
    auth: state,
    logger
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.log('📱 Escaneie o QR Code abaixo:')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut

      console.log('❌ Conexão fechada. Status:', statusCode)

      if (shouldReconnect) {
        startWhatsApp()
      }
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp conectado!')
    }
  })

  sock.ev.on('messages.upsert', async (event) => {
    try {
      if (!event?.messages?.length) return

      const msg = event.messages[0]
      if (!msg?.message) return
      if (msg.key?.fromMe) return

      const messageText = extractMessageText(msg).trim()
      const from = msg.key?.remoteJid || ''

      console.log('📩 Nova mensagem:', messageText)

      const data = {
        from,
        message: messageText,
        timestamp: new Date().toISOString()
      }

      await sendToWebhook(data)
    } catch (error) {
      console.error('❌ Erro ao processar mensagem:', error.message)
    }
  })
}

startWhatsApp()
