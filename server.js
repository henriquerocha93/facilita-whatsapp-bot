import express from 'express';
import cors from 'cors';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let sock = null;
let isConnected = false;
let connectedPhone = '';
let currentQrCodeDataUrl = '';
let lastQrTimestamp = 0;
let connectionAttempts = 0;

const AUTH_FOLDER = path.join(__dirname, 'auth_session');
if (!fs.existsSync(AUTH_FOLDER)) {
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
}

function normalizarTelefone(numero) {
    if (!numero) return '';
    let limpo = String(numero).replace(/\D/g, '');
    if (limpo.startsWith('55') && limpo.length >= 12) return limpo;
    if (limpo.length === 10 || limpo.length === 11) return `55${limpo}`;
    return limpo;
}

async function startWhatsAppBot() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: true,
            auth: state,
            browser: ['Facilita Moto Bot', 'Chrome', '1.0.0'],
            defaultQueryTimeoutMs: 60000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    currentQrCodeDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
                    lastQrTimestamp = Date.now();
                    isConnected = false;
                    console.log('⚡ [WhatsApp Bot] Novo QR Code gerado! Abra a página inicial para escanear.');
                } catch (err) {
                    console.error('Erro ao gerar imagem QR:', err);
                }
            }

            if (connection === 'close') {
                isConnected = false;
                currentQrCodeDataUrl = '';
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`❌ [WhatsApp Bot] Conexão fechada (${statusCode}). Reconectar: ${shouldReconnect}`);

                if (statusCode === DisconnectReason.loggedOut) {
                    try {
                        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
                        fs.mkdirSync(AUTH_FOLDER, { recursive: true });
                    } catch (e) {}
                }

                if (shouldReconnect) {
                    connectionAttempts++;
                    const delay = Math.min(connectionAttempts * 2000, 10000);
                    setTimeout(startWhatsAppBot, delay);
                }
            } else if (connection === 'open') {
                isConnected = true;
                currentQrCodeDataUrl = '';
                connectionAttempts = 0;
                connectedPhone = sock?.user?.id?.split(':')[0] || 'Conectado';
                console.log(`✅ [WhatsApp Bot] Conectado com sucesso com o número: ${connectedPhone}!`);
            }
        });
    } catch (err) {
        console.error('Erro ao inicializar Baileys:', err);
        setTimeout(startWhatsAppBot, 5000);
    }
}

// Inicia o motor Baileys
startWhatsAppBot();

// Endpoint de Status JSON
app.get('/status', (req, res) => {
    res.json({
        connected: isConnected,
        phone: connectedPhone,
        hasQr: !!currentQrCodeDataUrl,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Endpoint de Ping para manter o servidor acordado
app.get('/ping', (req, res) => {
    res.json({
        ok: true,
        service: 'facilita-whatsapp-bot',
        connected: isConnected,
        timestamp: new Date().toISOString()
    });
});

// Painel Visual para Escanear o QR Code
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Robô WhatsApp — Facilita Moto</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        body { background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
        .card { background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 32px; max-width: 480px; width: 100%; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
        .logo { font-size: 2.2rem; font-weight: 800; color: #38bdf8; margin-bottom: 8px; display: flex; align-items: center; justify-content: center; gap: 10px; }
        .subtitle { color: #94a3b8; font-size: 0.9rem; margin-bottom: 24px; }
        .status-badge { display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 999px; font-size: 0.85rem; font-weight: 700; margin-bottom: 24px; }
        .status-connected { background: #065f46; color: #6ee7b7; border: 1px solid #059669; }
        .status-waiting { background: #7c2d12; color: #fdba74; border: 1px solid #ea580c; }
        .qr-box { background: #fff; border-radius: 12px; padding: 16px; display: inline-block; margin-bottom: 20px; box-shadow: 0 8px 24px rgba(0,0,0,0.25); min-width: 280px; min-height: 280px; display: flex; align-items: center; justify-content: center; }
        .qr-box img { width: 280px; height: 280px; object-fit: contain; }
        .instructions { text-align: left; background: #0f172a; border-radius: 10px; padding: 16px; font-size: 0.85rem; color: #cbd5e1; line-height: 1.5; margin-bottom: 20px; }
        .instructions ol { padding-left: 20px; }
        .instructions li { margin-bottom: 6px; }
        .btn-refresh { background: #2563eb; color: #fff; border: none; padding: 10px 20px; border-radius: 8px; font-weight: 600; cursor: pointer; transition: 0.2s; font-size: 0.85rem; }
        .btn-refresh:hover { background: #1d4ed8; }
    </style>
</head>
<body>
    <div class="card">
        <div class="logo">
            <i class="fa-solid fa-motorcycle"></i> FACILITA MOTO
        </div>
        <p class="subtitle">Robô Autônomo de Disparos de WhatsApp em Nuvem</p>

        <div id="status-container">
            ${isConnected ? `
                <div class="status-badge status-connected">
                    <i class="fa-solid fa-circle-check"></i> CONECTADO (${connectedPhone})
                </div>
                <div style="background:#064e3b; border:1px solid #059669; border-radius:12px; padding:24px 16px; margin-bottom:20px;">
                    <i class="fa-brands fa-whatsapp" style="font-size:3.5rem; color:#34d399; margin-bottom:12px; display:block;"></i>
                    <strong style="font-size:1.1rem; color:#ecfdf5; display:block; margin-bottom:6px;">WhatsApp Online & Pronto!</strong>
                    <p style="font-size:0.85rem; color:#a7f3d0;">O robô está conectado e enviará automaticamente as cobranças das 08h, bloqueios das 18h e recibos do PIX.</p>
                </div>
            ` : `
                <div class="status-badge status-waiting">
                    <i class="fa-solid fa-hourglass-half"></i> AGUARDANDO LEITURA DO QR CODE
                </div>
                <div class="qr-box">
                    ${currentQrCodeDataUrl ? `
                        <img src="${currentQrCodeDataUrl}" alt="QR Code WhatsApp">
                    ` : `
                        <div style="color:#475569; font-size:0.85rem;">
                            <i class="fa-solid fa-circle-notch fa-spin" style="font-size:2rem; margin-bottom:8px; display:block; color:#0284c7;"></i>
                            Gerando QR Code...
                        </div>
                    `}
                </div>
                <div class="instructions">
                    <strong style="color:#38bdf8; display:block; margin-bottom:6px;"><i class="fa-solid fa-mobile-screen"></i> Como Conectar:</strong>
                    <ol>
                        <li>Abra o <strong>WhatsApp</strong> no celular</li>
                        <li>Toque nos <strong>3 pontinhos</strong> (ou Configurações no iPhone)</li>
                        <li>Toque em <strong>Aparelhos conectados &rarr; Conectar um aparelho</strong></li>
                        <li>Aponte a câmera para o QR Code acima</li>
                    </ol>
                </div>
            `}
        </div>

        <button class="btn-refresh" onclick="location.reload()">
            <i class="fa-solid fa-rotate-right"></i> Atualizar Tela
        </button>
    </div>

    <script>
        // Auto-refresh a cada 3 segundos enquanto aguarda leitura do QR Code
        setInterval(async () => {
            try {
                const res = await fetch('/status');
                const data = await res.json();
                if (data.connected !== ${isConnected}) {
                    location.reload();
                }
            } catch (e) {}
        }, 3000);
    </script>
</body>
</html>
    `);
});

// Endpoint Principal de Disparo de Mensagens (/send-message)
app.post('/send-message', async (req, res) => {
    const body = req.body || {};
    const dest = body.phone || body.number || body.to;
    const msg = body.message || body.text || body.body;
    const pixCopiaECola = body.pixCopiaECola || '';

    if (!dest || !msg) {
        return res.status(400).json({
            success: false,
            error: 'Campos "phone" (ou number) e "message" (ou text) são obrigatórios.'
        });
    }

    if (!isConnected || !sock) {
        return res.status(503).json({
            success: false,
            error: 'Robô do WhatsApp ainda não está conectado. Escaneie o QR Code na página inicial.'
        });
    }

    const numLimpo = normalizarTelefone(dest);
    let targetJid = `${numLimpo}@s.whatsapp.net`;

    try {
        // Identifica no servidor do WhatsApp o JID exato (resolve o problema brasileiro do 9º dígito)
        const checkResults = await sock.onWhatsApp(numLimpo);
        if (checkResults && checkResults.length > 0 && checkResults[0].exists) {
            targetJid = checkResults[0].jid;
        } else if (numLimpo.startsWith('55') && numLimpo.length === 13) {
            // Tenta sem o 9º dígito (55 + DDD + 8 dígitos)
            const semNove = `${numLimpo.substring(0, 4)}${numLimpo.substring(5)}`;
            const checkSemNove = await sock.onWhatsApp(semNove);
            if (checkSemNove && checkSemNove.length > 0 && checkSemNove[0].exists) {
                targetJid = checkSemNove[0].jid;
            }
        } else if (numLimpo.startsWith('55') && numLimpo.length === 12) {
            // Tenta com o 9º dígito (55 + DDD + 9 + 8 dígitos)
            const comNove = `${numLimpo.substring(0, 4)}9${numLimpo.substring(4)}`;
            const checkComNove = await sock.onWhatsApp(comNove);
            if (checkComNove && checkComNove.length > 0 && checkComNove[0].exists) {
                targetJid = checkComNove[0].jid;
            }
        }
    } catch (e) {
        console.warn('onWhatsApp lookup warning:', e.message);
    }

    try {
        console.log(`📤 Enviando mensagem para JID validado: ${targetJid}`);
        const sent = await sock.sendMessage(targetJid, { text: String(msg) });

        // Se houver PIX Copia e Cola, envia como mensagem separada para facilitar copiar no celular com 1 toque
        if (pixCopiaECola && !String(msg).includes(pixCopiaECola)) {
            setTimeout(async () => {
                try {
                    await sock.sendMessage(targetJid, { text: String(pixCopiaECola).trim() });
                } catch (e) {}
            }, 1200);
        }

        return res.json({
            success: true,
            messageId: sent.key.id,
            to: targetJid.replace('@s.whatsapp.net', ''),
            targetJid,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error('Erro ao enviar mensagem:', err);
        return res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 [Facilita WhatsApp Bot] Rodando na porta ${PORT}`);
});
