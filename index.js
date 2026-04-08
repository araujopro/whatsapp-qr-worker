const express = require('express')
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState
} = require('@whiskeysockets/baileys')
const qrcode = require('qrcode-terminal')
const pino = require('pino')

const app = express()
app.use(express.json())

const logger = pino({ level: process.env.LOG_LEVEL || 'info' })
const PORT = process.env.PORT || 3000

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

let latestQr = null
let connectionStatus = 'starting'
let sockInstance = null

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'whatsapp-qr-worker',
    status: connectionStatus
  })
})

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'whatsapp-qr-worker',
    status: connectionStatus
  })
})

app.get('/qr', (req, res) => {
  res.json({
    ok: true,
    qr: latestQr,
    status: connectionStatus
  })
})

async function startWhatsApp() {
  validateEnv()

  const { state, saveCreds } = await useMultiFileAuthState('auth')

  const sock = makeWASocket({
    auth: state,
    logger
  })

  sockInstance = sock

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      latestQr = qr
      connectionStatus = 'qr_ready'
      console.log('📱 Escaneie o QR Code abaixo:')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'open') {
      connectionStatus = 'connected'
      latestQr = null
      console.log('✅ WhatsApp conectado com sucesso!')
    }

    if (connection === 'close') {
      connectionStatus = 'disconnected'

      const statusCode = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut

      console.log('❌ Conexão fechada. Status:', statusCode)
      console.log('🔁 Reconectar:', shouldReconnect)

      if (shouldReconnect) {
        setTimeout(() => {
          startWhatsApp().catch((err) => {
            console.error('❌ Erro ao reconectar:', err.message)
          })
        }, 3000)
      } else {
        console.log('🚪 Sessão desconectada. Será necessário conectar novamente.')
      }
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
      const pushName = msg.pushName || ''
      const messageId = msg.key?.id || ''

      console.log('📩 Nova mensagem recebida de:', from)
      console.log('📝 Conteúdo:', messageText || '[mensagem sem texto]')

      const data = {
        event: 'message_received',
        channel: 'whatsapp',
        sessionId: process.env.SESSION_ID || null,
        sender: {
          id: from,
          name: pushName
        },
        message: {
          id: messageId,
          text: messageText,
          type: 'text'
        },
        timestamp: new Date().toISOString(),
        raw: msg
      }

      await sendToWebhook(data)
    } catch (error) {
      console.error('❌ Erro ao processar mensagem:', error.message)
    }
  })
}

app.listen(PORT, () => {
  console.log(`🚀 Servidor HTTP rodando na porta ${PORT}`)
})

startWhatsApp().catch((error) => {
  console.error('❌ Erro fatal ao iniciar worker:', error)
  process.exit(1)
})
