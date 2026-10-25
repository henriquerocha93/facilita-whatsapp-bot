import express from 'express';
import cors from 'cors';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';

// =====================================================================

// =====================================================================
// LIVE SYSTEM LOG BUFFER (ÚLTIMOS 100 LOGS EM MEMÓRIA PARA /api/logs)
// =====================================================================
const recentLogs = [];
const origLog = console.log;
const origWarn = console.warn;
const origErr = console.error;

function recordLog(level, args) {
    try {
        const text = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        recentLogs.unshift({
            time: new Date().toLocaleTimeString('pt-BR', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0'),
            level,
            text
        });
        if (recentLogs.length > 150) recentLogs.pop();
    } catch (e) {}
}

console.log = (...args) => { recordLog('INFO', args); origLog(...args); };
console.warn = (...args) => { recordLog('WARN', args); origWarn(...args); };
console.error = (...args) => { recordLog('ERROR', args); origErr(...args); };

// CRASH GUARD 24/7 (Proteção contra quedas do processo Node.js)
// Garante que nenhum erro inesperado derrube o robô de emergência
// =====================================================================
process.on('uncaughtException', (err) => {
    console.error('🛡️ [Crash Guard 24h] Exceção capturada com segurança:', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
    console.error('🛡️ [Crash Guard 24h] Rejeição de Promise capturada:', reason?.message || reason);
});


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


// =====================================================================
// AUTO-DESBLOQUEIO EM TEMPO REAL APÓS PAGAMENTO PIX NO MERCADO PAGO
// =====================================================================
function monitorarPagamentoEDesbloquear(paymentId, identificador, remoteJid) {
    if (!paymentId) return;
    console.log(`🔍 [Auto-Desbloqueio] Monitorando pagamento Mercado Pago #${paymentId} para ${identificador}...`);
    let tentativas = 0;
    const maxTentativas = 90; // 90 x 10s = 15 minutos de monitoramento ativo
    const timer = setInterval(async () => {
        tentativas++;
        if (tentativas > maxTentativas) {
            clearInterval(timer);
            console.log(`⏱️ [Auto-Desbloqueio] Tempo limite esgotado para o pagamento #${paymentId}.`);
            return;
        }

        try {
            const res = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
                headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` }
            });
            if (!res.ok) return;
            const data = await res.json();

            if (data.status === 'approved') {
                clearInterval(timer);
                console.log(`🎉 [Auto-Desbloqueio] PIX #${paymentId} APROVADO! Desbloqueando veículo ${identificador}...`);

                // Detecta qual moto desbloquear (suporta qualquer placa do sistema)
                let placaDetectada = (identificador || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();

                // 1. Dispara o desbloqueio satelital na API da Facilita Moto (Xtrack)
                try {
                    await fetch('https://www.facilitamoto.com.br/api/telemetry', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            action: 'command_block',
                            bloquear: false,
                            placa: placaDetectada,
                            motivo: `PIX Mercado Pago #${paymentId} Aprovado - Desbloqueio Automático via WhatsApp`
                        })
                    });
                } catch (e) {
                    console.error('Erro ao enviar desbloqueio para API de telemetria:', e.message);
                }

                // 2. Notifica o condutor no WhatsApp com confirmação oficial
                const msgConfirmacao = `🎉 *PAGAMENTO CONFIRMADO NO BANCO MERCADO PAGO!* 🎉\n\n` +
                    `🔓 *SUA MOTO (${placaDetectada}) FOI DESBLOQUEADA COM SUCESSO!* 🏍️💨\n\n` +
                    `✅ O bloqueador via satélite foi desativado e o motor liberado na hora.\n` +
                    `Obrigado pelo pagamento! Tenha uma excelente rota e boa viagem com a Facilita Moto! 🚀`;
                await enviarMensagem(remoteJid, msgConfirmacao);

                // 3. Notifica o Henrique no WhatsApp particular
                const hJid = henriqueJidCache || await getValidatedJid(HENRIQUE_RAW_PHONE);
                if (hJid) {
                    const alertaHenrique = `💰 *PIX DE DESBLOQUEIO PAGO NO MERCADO PAGO!* 💰\n` +
                        `• Veículo: *${placaDetectada}*\n` +
                        `• Valor: *R$ 350,00*\n` +
                        `• ID Pagamento: #${paymentId}\n` +
                        `• Status: *MOTO DESBLOQUEADA AUTOMATICAMENTE NO SATÉLITE!* 🔓`;
                    await enviarMensagem(hJid, alertaHenrique);
                }
            }
        } catch (err) {
            console.warn('Erro ao verificar status do pagamento:', err.message);
        }
    }, 10 * 1000);
}

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

// Configurações do Henrique e Mercado Pago Oficial
const HENRIQUE_RAW_PHONE = '5551986551068';
const MP_ACCESS_TOKEN = 'APP_USR-6194243169013538-102220-43c64ed326354129ba6d2d512a427b04-213948720';
let henriqueJidCache = null;
const henriqueKnownJids = new Set([
    '5551986551068@s.whatsapp.net',
    '555186551068@s.whatsapp.net'
]);

// Armazenamento Persistente de Atendimento Ativo (Ponte Relay Henrique <-> Cliente)
const SUPPORT_FILE = path.join(__dirname, 'active_support.json');
let activeSupport = null;

function carregarSuporteAtivo() {
    try {
        if (fs.existsSync(SUPPORT_FILE)) {
            const data = JSON.parse(fs.readFileSync(SUPPORT_FILE, 'utf8'));
            if (data && data.clientJid) {
                // Não permite que o próprio Henrique fique salvo como cliente
                if (data.clientJid.includes('51986551068') || data.clientJid.includes('5186551068')) {
                    fs.unlinkSync(SUPPORT_FILE);
                    activeSupport = null;
                    return;
                }
                activeSupport = data;
                console.log(`📌 [Suporte Ativo Restaurado]: ${data.clientName} (${data.clientPhone})`);
            }
        }
    } catch (e) {}
}

function salvarSuporteAtivo(clientJid, clientPhone, clientName) {
    activeSupport = { clientJid, clientPhone, clientName, startedAt: Date.now() };
    try {
        fs.writeFileSync(SUPPORT_FILE, JSON.stringify(activeSupport));
        console.log(`💾 [Ponte Salva]: Conectado com ${clientName} (${clientPhone})`);
    } catch (e) {}
}

function limparSuporteAtivo() {
    activeSupport = null;
    try {
        if (fs.existsSync(SUPPORT_FILE)) fs.unlinkSync(SUPPORT_FILE);
    } catch (e) {}
}

// Inicializa suporte ativo salvo em disco
carregarSuporteAtivo();

// Armazenamento em memória para sessões locais, emergências e leads
const clientSessions = new Map();
let activeEmergencies = []; // Alertas de Roubo/Furto para o som no CRM
let leadsFilaDeEspera = []; // Leads que entraram na fila de espera

const AUTH_FOLDER = path.join(__dirname, 'auth_session');
if (!fs.existsSync(AUTH_FOLDER)) {
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
} else {
    try {
        const existingAuthFiles = fs.readdirSync(AUTH_FOLDER);
        for (const f of existingAuthFiles) {
            if (f.startsWith('session-')) {
                fs.unlinkSync(path.join(AUTH_FOLDER, f));
            }
        }
    } catch(e) {}
}

// =====================================================================
// PERSISTÊNCIA DE SESSÃO DO WHATSAPP NA NUVEM (FIRESTORE)
// Evita perda da sessão e necessidade de novo QR Code em reinicializações do Render
// =====================================================================
const FIRESTORE_API_KEY = "AIzaSyDp8U3HYT_XAbZ30dSQlKoh8zw02DLeIvc";
const FIRESTORE_PROJECT_ID = "motohub-9e839";
const FIRESTORE_AUTH_URL = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/bot_whatsapp_auth`;


const FIRESTORE_EMERGENCIAS_URL = "https://firestore.googleapis.com/v1/projects/" + FIRESTORE_PROJECT_ID + "/databases/(default)/documents/alertas_emergencia";
const FIRESTORE_LOJISTAS_URL = "https://firestore.googleapis.com/v1/projects/" + FIRESTORE_PROJECT_ID + "/databases/(default)/documents/propostas_lojistas";

async function salvarEmergenciaNoFirestore(alertObj) {
    try {
        const docId = alertObj.id || ("EMERGENCY-" + Date.now());
        const res = await fetch(FIRESTORE_EMERGENCIAS_URL + "/" + docId + "?key=" + FIRESTORE_API_KEY, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fields: {
                    id: { stringValue: docId },
                    clienteNome: { stringValue: alertObj.clienteNome || 'Cliente' },
                    clienteTelefone: { stringValue: alertObj.clienteTelefone || '' },
                    mensagem: { stringValue: alertObj.mensagem || '' },
                    hora: { stringValue: alertObj.hora || '' },
                    timestamp: { integerValue: String(alertObj.timestamp || Date.now()) },
                    status: { stringValue: 'PENDENTE' }
                }
            })
        });
        console.log("🚨 [Firestore] Alerta de emergência salvo na nuvem com status " + res.status + ": " + docId);
    } catch (e) {
        console.warn('Erro ao salvar emergência no Firestore:', e.message);
    }
}

async function salvarPropostaLojistaNoFirestore(lojistaObj) {
    try {
        const docId = lojistaObj.id || ("LOJISTA-" + Date.now());
        const res = await fetch(FIRESTORE_LOJISTAS_URL + "/" + docId + "?key=" + FIRESTORE_API_KEY, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fields: {
                    id: { stringValue: docId },
                    clienteNome: { stringValue: lojistaObj.clienteNome || '' },
                    clienteTelefone: { stringValue: lojistaObj.clienteTelefone || '' },
                    lojaEGerente: { stringValue: lojistaObj.lojaEGerente || '' },
                    endereco: { stringValue: lojistaObj.endereco || '' },
                    proposta: { stringValue: lojistaObj.proposta || '' },
                    hora: { stringValue: lojistaObj.hora || '' },
                    timestamp: { integerValue: String(lojistaObj.timestamp || Date.now()) },
                    status: { stringValue: 'NOVA' }
                }
            })
        });
        console.log("🏪 [Firestore] Proposta de lojista salva na nuvem com status " + res.status + ": " + docId);
    } catch (e) {
        console.warn('Erro ao salvar proposta de lojista no Firestore:', e.message);
    }
}

async function restaurarSessaoDoFirestore() {
    try {
        console.log('🔄 [Cloud Session] Verificando sessão salva no Firestore...');
        const res = await fetch(`${FIRESTORE_AUTH_URL}?key=${FIRESTORE_API_KEY}`);
        if (!res.ok) {
            console.log('ℹ️ [Cloud Session] Nenhuma sessão no Firestore ainda (Status:', res.status, ')');
            return false;
        }
        const data = await res.json();
        if (!data.documents || data.documents.length === 0) {
            console.log('ℹ️ [Cloud Session] Nenhuma sessão salva. Aguardando leitura do QR Code.');
            return false;
        }

        if (!fs.existsSync(AUTH_FOLDER)) {
            fs.mkdirSync(AUTH_FOLDER, { recursive: true });
        }

        let count = 0;
        for (const doc of data.documents) {
            const filename = doc.fields?.filename?.stringValue;
            if (!filename || filename.startsWith('session-')) continue;
            const b64 = doc.fields?.data?.stringValue;
            if (filename && b64) {
                const filePath = path.join(AUTH_FOLDER, filename);
                fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));
                count++;
            }
        }
        console.log(`✅ [Cloud Session] ${count} arquivos de sessão restaurados do Firestore! Reconectando sem precisar de QR Code...`);
        return count > 0;
    } catch (e) {
        console.warn('⚠️ [Cloud Session] Aviso ao restaurar sessão:', e.message);
        return false;
    }
}

let timeoutCloudSave = null;
function agendarSalvamentoSessaoNuvem() {
    if (timeoutCloudSave) clearTimeout(timeoutCloudSave);
    timeoutCloudSave = setTimeout(salvarSessaoNoFirestore, 3000);
}

async function salvarSessaoNoFirestore() {
    try {
        if (!fs.existsSync(AUTH_FOLDER)) return;
        const files = fs.readdirSync(AUTH_FOLDER);
        if (files.length === 0) return;

        console.log(`☁️ [Cloud Session] Sincronizando ${files.length} arquivos de sessão com o Firestore...`);
        for (const file of files) {
            if (file.startsWith('session-')) continue; // Nunca salva sessões individuais para evitar Bad MAC de descriptografia
            const filePath = path.join(AUTH_FOLDER, file);
            if (!fs.statSync(filePath).isFile()) continue;
            const content = fs.readFileSync(filePath);
            const b64 = content.toString('base64');
            const docId = file.replace(/[^a-zA-Z0-9_-]/g, '_');

            await fetch(`${FIRESTORE_AUTH_URL}/${docId}?key=${FIRESTORE_API_KEY}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fields: {
                        filename: { stringValue: file },
                        data: { stringValue: b64 },
                        updatedAt: { stringValue: new Date().toISOString() }
                    }
                })
            });
        }
        console.log('✅ [Cloud Session] Sessão persistida no Firestore com sucesso!');
    } catch (e) {
        console.warn('⚠️ [Cloud Session] Erro ao sincronizar sessão:', e.message);
    }
}

async function limparSessaoNoFirestore() {
    try {
        const res = await fetch(`${FIRESTORE_AUTH_URL}?key=${FIRESTORE_API_KEY}`);
        const data = await res.json();
        if (data.documents) {
            for (const doc of data.documents) {
                await fetch(`https://firestore.googleapis.com/v1/${doc.name}?key=${FIRESTORE_API_KEY}`, { method: 'DELETE' });
            }
        }
        console.log('🗑️ [Cloud Session] Sessão removida do Firestore.');
    } catch (e) {
        console.warn('Erro ao limpar sessão no Firestore:', e.message);
    }
}


function normalizarTelefone(numero) {
    if (!numero) return '';
    let limpo = String(numero).replace(/\D/g, '');
    if (limpo.startsWith('55') && limpo.length >= 12) return limpo;
    if (limpo.length === 10 || limpo.length === 11) return `55${limpo}`;
    return limpo;
}

// Formata o número brasileiro garantindo o 9º dígito para que o link https://wa.me/ abra perfeitamente
function formatarParaWaMe(numero) {
    let limpo = String(numero || '').replace(/\D/g, '');
    if (!limpo) return '';
    if (limpo.length === 10 || limpo.length === 11) {
        limpo = `55${limpo}`;
    }
    if (limpo.startsWith('55') && limpo.length === 12) {
        const ddd = limpo.substring(2, 4);
        const resto = limpo.substring(4);
        limpo = `55${ddd}9${resto}`;
    }
    return limpo;
}

function getSaoPauloDate() {
    const now = new Date();
    const spString = now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" });
    return new Date(spString);
}

function isAtendimentoHumanoDisponivel() {
    const spDate = getSaoPauloDate();
    const dia = spDate.getDay(); // 0 = Domingo, 1 = Segunda, ..., 6 = Sábado
    const hora = spDate.getHours();
    return (dia >= 1 && dia <= 6) && (hora >= 10 && hora < 18);
}

// Utilitário para cálculo de CRC16 do PIX BRCode Oficial
function calcularCRC16Pix(payload) {
    let crc = 0xFFFF;
    const polynomial = 0x1021;
    for (let i = 0; i < payload.length; i++) {
        crc ^= (payload.charCodeAt(i) << 8);
        for (let j = 0; j < 8; j++) {
            if ((crc & 0x8000) !== 0) {
                crc = ((crc << 1) ^ polynomial) & 0xFFFF;
            } else {
                crc = (crc << 1) & 0xFFFF;
            }
        }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
}

function formatEmvField(id, value) {
    const str = String(value || '');
    const len = str.length.toString().padStart(2, '0');
    return `${id}${len}${str}`;
}

function gerarPayloadPixBrCode({ chavePix, nomeBeneficiario, cidade, valor, txid, descricao }) {
    const chaveLimpa = String(chavePix || '+5551986551068').trim();
    const nomeLimpo = String(nomeBeneficiario || 'HENRIQUE ROCHA CLAVIJO')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().substring(0, 25);
    const cidadeLimpa = String(cidade || 'PORTO ALEGRE')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().substring(0, 15);
    const txidLimpo = String(txid || 'FACILITAMOTO').replace(/[^a-zA-Z0-9]/g, '').substring(0, 25) || 'FACILITAMOTO';
    const valorFormatado = (parseFloat(valor) || 350.00).toFixed(2);

    const gui = formatEmvField('00', 'br.gov.bcb.pix');
    const keyField = formatEmvField('01', chaveLimpa);
    const descField = descricao ? formatEmvField('02', String(descricao).substring(0, 25)) : '';
    const merchantAccount = formatEmvField('26', `${gui}${keyField}${descField}`);

    const payloadSemCrc =
        formatEmvField('00', '01') +
        formatEmvField('01', '12') +
        merchantAccount +
        formatEmvField('52', '0000') +
        formatEmvField('53', '986') +
        formatEmvField('54', valorFormatado) +
        formatEmvField('58', 'BR') +
        formatEmvField('59', nomeLimpo) +
        formatEmvField('60', cidadeLimpa) +
        formatEmvField('62', formatEmvField('05', txidLimpo)) +
        '6304';

    const crc = calcularCRC16Pix(payloadSemCrc);
    return `${payloadSemCrc}${crc}`;
}

// Gera cobrança PIX Oficial do Mercado Pago

// =====================================================================
// BUSCA DINÂMICA DE TODAS AS MOTOS E CONTRATOS DO SISTEMA NO FIRESTORE
// =====================================================================
async function buscarVeiculoCompleto(entrada) {
    const limpo = String(entrada || '').trim().toUpperCase();
    const digitos = limpo.replace(/\D/g, '');
    const placaBusca = limpo.replace(/[^A-Z0-9]/g, '');

    try {
        const [resMotos, resContratos, resClientes] = await Promise.all([
            fetch(`https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/crm_motos?key=${FIRESTORE_API_KEY}`).then(r => r.json()),
            fetch(`https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/crm_contratos?key=${FIRESTORE_API_KEY}`).then(r => r.json()),
            fetch(`https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/crm_clientes?key=${FIRESTORE_API_KEY}`).then(r => r.json())
        ]);

        const motos = (resMotos.documents || []).map(d => {
            const f = d.fields || {};
            return {
                id: d.name.split('/').pop(),
                placa: (f.placa?.stringValue || '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
                modelo: f.modelo?.stringValue || 'Moto',
                rastreadorImei: f.rastreadorImei?.stringValue || ''
            };
        });

        const clientes = (resClientes.documents || []).map(d => {
            const f = d.fields || {};
            return {
                id: d.name.split('/').pop(),
                nome: f.nome?.stringValue || 'Condutor',
                cpf: (f.cpf?.stringValue || '').replace(/\D/g, ''),
                telefone: (f.telefone?.stringValue || '').replace(/\D/g, '')
            };
        });

        const contratos = (resContratos.documents || []).map(d => {
            const f = d.fields || {};
            const pix = f.pixCobrancaAtual?.mapValue?.fields || {};
            const val = f.valorSemanal?.stringValue || f.valorSemanal?.integerValue || f.valorSemanal?.doubleValue || pix.valor?.stringValue || pix.valor?.integerValue || 350;
            return {
                id: d.name.split('/').pop(),
                clienteId: f.clienteId?.stringValue || '',
                clienteNome: f.clienteNome?.stringValue || pix.clienteNome?.stringValue || '',
                motoId: f.motoId?.stringValue || '',
                motoPlaca: (f.motoPlaca?.stringValue || pix.motoPlaca?.stringValue || '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
                valor: parseFloat(val) || 350.00,
                status: f.status?.stringValue || 'ativo'
            };
        }).filter(c => c.status !== 'encerrado');

        // 1. Procura por Placa
        let motoMatch = null;
        let contratoMatch = null;

        if (placaBusca.length >= 4) {
            motoMatch = motos.find(m => m.placa === placaBusca || m.placa.includes(placaBusca));
            if (motoMatch) {
                contratoMatch = contratos.find(c => c.motoPlaca === motoMatch.placa || c.motoId === motoMatch.id);
            }
        }

        // 2. Procura por CPF
        if (!motoMatch && digitos.length >= 8) {
            const clienteMatch = clientes.find(cli => cli.cpf.includes(digitos) || digitos.includes(cli.cpf));
            if (clienteMatch) {
                contratoMatch = contratos.find(c => c.clienteId === clienteMatch.id || (c.clienteNome && c.clienteNome.toLowerCase().includes(clienteMatch.nome.toLowerCase())));
                if (contratoMatch && contratoMatch.motoPlaca) {
                    motoMatch = motos.find(m => m.placa === contratoMatch.motoPlaca || m.id === contratoMatch.motoId);
                }
            }
        }

        if (contratoMatch && !motoMatch && contratoMatch.motoPlaca) {
            motoMatch = motos.find(m => m.placa === contratoMatch.motoPlaca);
        }

        if (motoMatch || contratoMatch) {
            return {
                encontrado: true,
                placa: motoMatch?.placa || contratoMatch?.motoPlaca || placaBusca,
                modelo: motoMatch?.modelo || 'Honda CG 150',
                clienteNome: contratoMatch?.clienteNome || 'Condutor',
                valor: contratoMatch?.valor || 350.00
            };
        }

        return {
            encontrado: false,
            placasDisponiveis: motos.map(m => m.placa)
        };
    } catch (e) {
        console.warn('Erro ao buscar veículos no Firestore:', e.message);
        return {
            encontrado: true,
            placa: placaBusca || 'IPU2I57',
            modelo: 'Honda CG 150',
            clienteNome: 'Condutor',
            valor: 350.00
        };
    }
}

async function criarPixMercadoPago(identificador = 'Cliente', valorPersonalizado = 350.00) {
    const valor = parseFloat(valorPersonalizado) || 350.00;
    const txidUnico = `MP${Date.now().toString().slice(-10)}`;
    let pixCopiaECola = '';
    let paymentId = null;

    try {
        const mpResp = await fetch('https://api.mercadopago.com/v1/payments', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
                'X-Idempotency-Key': `pix-${Date.now()}-${Math.random().toString(36).substring(7)}`
            },
            body: JSON.stringify({
                transaction_amount: valor,
                description: `Aluguel Semanal Facilita Moto - ${identificador}`,
                payment_method_id: 'pix',
                payer: {
                    email: 'pagamento.cliente@facilitamoto.com.br',
                    first_name: String(identificador || 'Condutor').substring(0, 20),
                    last_name: 'Facilita Moto'
                }
            })
        });

        if (mpResp.ok) {
            const mpData = await mpResp.json();
            paymentId = mpData.id ? String(mpData.id) : null;
            pixCopiaECola = mpData.point_of_interaction?.transaction_data?.qr_code || '';
            console.log(`💳 [Mercado Pago PIX Criado]: #${paymentId} para ${identificador} - R$ ${valor}`);
        } else {
            const errBody = await mpResp.text();
            console.warn('⚠️ [Mercado Pago Aviso]:', mpResp.status, errBody);
        }
    } catch (e) {
        console.warn('Erro ao chamar Mercado Pago:', e.message);
    }

    if (!pixCopiaECola) {
        pixCopiaECola = gerarPayloadPixBrCode({
            chavePix: '+5551986551068',
            nomeBeneficiario: 'HENRIQUE ROCHA CLAVIJO',
            cidade: 'PORTO ALEGRE',
            valor: valor,
            txid: txidUnico,
            descricao: `FACILITA ${String(identificador).substring(0, 10)}`
        });
    }

    return {
        valor: valor.toFixed(2).replace('.', ','),
        identificador,
        pixCopiaECola,
        paymentId
    };
}

async function getValidatedJid(numero, ehHenrique = false) {
    if (!sock || !isConnected) return null;
    if (typeof numero === "string" && (numero.endsWith("@s.whatsapp.net") || numero.endsWith("@lid"))) {
        return numero;
    }
    const numLimpo = normalizarTelefone(numero);
    try {
        const check = await sock.onWhatsApp(numLimpo);
        if (check && check.length > 0 && check[0].exists) {
            if (ehHenrique && check[0].lid) henriqueKnownJids.add(check[0].lid);
            return check[0].jid;
        }
        if (numLimpo.startsWith('55') && numLimpo.length === 13) {
            const semNove = `${numLimpo.substring(0, 4)}${numLimpo.substring(5)}`;
            const checkSemNove = await sock.onWhatsApp(semNove);
            if (checkSemNove && checkSemNove.length > 0 && checkSemNove[0].exists) {
                if (ehHenrique && checkSemNove[0].lid) henriqueKnownJids.add(checkSemNove[0].lid);
                return checkSemNove[0].jid;
            }
        } else if (numLimpo.startsWith('55') && numLimpo.length === 12) {
            const comNove = `${numLimpo.substring(0, 4)}9${numLimpo.substring(4)}`;
            const checkComNove = await sock.onWhatsApp(comNove);
            if (checkComNove && checkComNove.length > 0 && checkComNove[0].exists) {
                if (ehHenrique && checkComNove[0].lid) henriqueKnownJids.add(checkComNove[0].lid);
                return checkComNove[0].jid;
            }
        }
    } catch (e) {
        console.warn('[JID Lookup Warning]:', e.message);
    }
    return `${numLimpo}@s.whatsapp.net`;
}

async function atualizarIdentidadesHenrique() {
    try {
        const c1 = await sock.onWhatsApp('5551986551068');
        if (c1 && c1.length > 0) {
            if (c1[0].jid) { henriqueKnownJids.add(c1[0].jid); henriqueJidCache = c1[0].jid; }
            if (c1[0].lid) { henriqueKnownJids.add(c1[0].lid); }
        }
        const c2 = await sock.onWhatsApp('555186551068');
        if (c2 && c2.length > 0) {
            if (c2[0].jid) { henriqueKnownJids.add(c2[0].jid); if (!henriqueJidCache) henriqueJidCache = c2[0].jid; }
            if (c2[0].lid) { henriqueKnownJids.add(c2[0].lid); }
        }
        console.log('👑 [Identidades Conhecidas do Henrique]:', Array.from(henriqueKnownJids));
    } catch (e) {
        console.warn('Erro ao atualizar identidades do Henrique:', e.message);
    }
}


// =====================================================================
// DISPARADOR ROBUSTO DE NOTIFICAÇÃO PARA O HENRIQUE (TODOS OS JIDS/LIDS)
// =====================================================================
async function notificarHenrique(mensagem) {
    const targets = new Set([
        '5551986551068@s.whatsapp.net',
        '555186551068@s.whatsapp.net',
        '144543030767616@lid'
    ]);
    if (henriqueJidCache) targets.add(henriqueJidCache);
    for (const jid of henriqueKnownJids) {
        if (jid) targets.add(jid);
    }

    let entregueAlgum = false;
    for (const jid of targets) {
        if (!jid) continue;
        try {
            const ok = await sock.sendMessage(jid, { text: mensagem });
            if (ok) {
                console.log("📲 [Notificação Henrique]: Entregue com sucesso para " + jid);
                entregueAlgum = true;
            }
        } catch (e) {
            console.warn("[Notificação Henrique Warning] Falha ao enviar para " + jid + ": " + e.message);
        }
    }
    return entregueAlgum;
}

async function enviarMensagem(targetJid, texto) {
    if (!sock || !isConnected) return false;
    try {
        await sock.sendMessage(targetJid, { text: texto });
        return true;
    } catch (err) {
        console.error(`Erro ao enviar mensagem para ${targetJid}:`, err);
        return false;
    }
}

// Menus Sequenciais 1 a 6 com Requisitos e Valores Atualizados
const MENUS = {
    principal: `👋 Olá! Seja muito bem-vindo(a) à *Facilita Moto*! 🏍️💨
Locação de motos com quilometragem livre e suporte completo.

🌐 *Conheça nosso site oficial:* https://www.facilitamoto.com.br/

*Digite o NÚMERO da opção desejada:*

*1* - 🏍️ Motos Disponíveis (Fila de Espera e Requisitos)
*2* - 💳 2ª Via do PIX Semanal (Gerar código na hora)
*3* - 🔓 Solicitar Desbloqueio da Moto (Todas as motos da frota)
*4* - 🏪 Sou Lojista (Parcerias para Lojas e Oficinas)
*5* - 🚨 Informar Roubo ou Furto (Emergência 24h)
*6* - 💬 Falar com Atendente Humano (10h às 18h - Seg a Sáb)`,

    motos: `🏍️ *FACILITA MOTO — DISPONIBILIDADE E REQUISITOS*

⚠️ *Status da Frota:* No momento, *todas as nossas motos estão 100% LOCADAS!* 🛵💨
Nossa procura é grande, mas abrimos vagas conforme devoluções e novas motos entram na frota.

💰 *Valores para Retirada (R$ 700,00):*
• *R$ 350,00 de Caução* (devolvida no encerramento do contrato)
• *R$ 350,00 do Aluguel da 1ª Semana* (o valor semanal pode variar conforme o modelo disponível no painel adm)
• *Total de Entrada:* R$ 700,00 (caução + 1ª semana adiantada)
• *Quilometragem Livre* para você rodar e lucrar!

📋 *Requisitos Obrigatórios para Locação:*
1. *CNH Categoria A* (válida)
2. *Comprovante de Residência:* No seu próprio nome OU com firma autenticada em cartório (caso seja no nome de terceiros)
3. *1 Testemunha presente* no dia da assinatura do contrato
4. Pagamento do valor de entrada (R$ 700,00) no ato da retirada

👉 *Deseja entrar na nossa Fila de Espera prioritária?*
Envie agora o seu *Nome Completo*, seu *Bairro* e a foto da sua *CNH* aqui nesta conversa!
Assim que uma vaga liberar, nossa equipe entrará em contato com você com prioridade!

Digite *0* para voltar ao menu principal.`,

    pedeIdentificacaoPix: `💳 *2ª VIA PIX SEMANAL — FACILITA MOTO*

Por favor, envie aqui o seu *Nome Completo*, *CPF* ou a *Placa da moto*:
(Nosso robô vai gerar o seu código PIX instantaneamente aqui na conversa!).`,

    oleo: `🛢️ *INFORMAÇÕES SOBRE TROCA DE ÓLEO*

A troca de óleo agora é realizada e autorizada *exclusivamente pela nossa oficina mecânica parceira credenciada* ou pelo painel administrativo da Facilita Moto!

Para tirar dúvidas sobre a sua revisão de 1.000 km, digite *6* para falar com o atendente.
Digite *0* para voltar ao menu principal.`,

    desbloqueio: `🔓 *SOLICITAÇÃO DE DESBLOQUEIO DE MOTO*

O desbloqueio automático via satélite Xtrack ocorre em até 5 minutos após a compensação do PIX no Mercado Pago.

Se você já realizou o pagamento e ainda não desbloqueou:
1. Envie o comprovante do PIX aqui nesta conversa.
2. Digite *6* para falar com o atendente e liberar imediatamente.
Digite *0* para voltar ao menu principal.`,

    emergenciaRoubo: `🚨🚨 *CANAL DE EMERGÊNCIA — ROUBO OU FURTO* 🚨🚨

1. *MANTENHA A CALMA* e coloque-se imediatamente em local seguro. A sua vida é a prioridade!
2. Todas as nossas motos possuem rastreador satelital *Xtrack* com bloqueio remoto imediato.
3. *Por favor, envie imediatamente aqui:*
   • Seu Nome Completo
   • Placa ou modelo da moto
   • Local / Bairro onde ocorreu o fato

⚠️ *A nossa central de monitoramento já foi acionada com prioridade máxima para bloqueio e localização satelital imediata do veículo!*`,

    foraDoHorario: `🧑‍💼 *ATENDIMENTO COM ATENDENTE HUMANO*

Nosso horário de atendimento é:
🗓️ *Segunda a Sábado: das 10h00 às 18h00*.
🚫 Fora desse período não há atendimento humano disponível.

No momento estamos fora do horário de expediente. Deixe sua mensagem ou dúvida aqui, e responderemos assim que abrirmos às 10h00!

*(Se for emergência de roubo ou furto, digite 5 para acionamento imediato 24h).*`
};

let isSessionRestored = false;
async function startWhatsAppBot() {
    try {
        if (!isSessionRestored) {
            await restaurarSessaoDoFirestore();
            isSessionRestored = true;
        }
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

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            agendarSalvamentoSessaoNuvem();
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    currentQrCodeDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
                    lastQrTimestamp = Date.now();
                    isConnected = false;
                    console.log('⚡ [WhatsApp Bot] Novo QR Code gerado.');
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
                        limparSessaoNoFirestore().catch(() => {});
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
                console.log(`✅ [WhatsApp Bot] Conectado: ${connectedPhone}!`);

                agendarSalvamentoSessaoNuvem();
                atualizarIdentidadesHenrique().catch(e => console.warn('Erro ao atualizar identidades:', e));
            }
        });

        // =====================================================================
        // PROCESSAMENTO DE MENSAGENS RECEBIDAS (CHATBOT URA + RELAY BRIDGE)
        // =====================================================================
        
        // =====================================================================
        // TRATAMENTO DE CHAMADAS DE VOZ / VÍDEO RECEBIDAS NO WHATSAPP
        // =====================================================================
        sock.ev.on('call', async (calls) => {
            for (const call of calls) {
                if (call.status === 'offer') {
                    console.log(`📞 [Chamada de Voz/Vídeo]: Recebida de ${call.from}`);
                    try {
                        const sessao = clientSessions.get(call.from) || { mode: 'MENU', lastActive: Date.now() };
                        sessao.mode = 'MENU';
                        sessao.lastActive = Date.now();
                        clientSessions.set(call.from, sessao);

                        await enviarMensagem(call.from, "Olá! 👋 Nosso atendimento por este número é 100% digital e automatizado por mensagens.\n\nComo posso te ajudar agora? Escolha uma opção:\n\n" + MENUS.principal);
                    } catch (e) {
                        console.error('Erro ao responder chamada de voz:', e);
                    }
                }
            }
        });

        
// =====================================================================
// EXTRATOR UNIVERSAL DE TEXTO (Suporta mensagens de texto, botões, listas e efêmeras)
// =====================================================================
function extrairTextoMensagem(msg) {
    if (!msg || !msg.message) return '';
    let m = msg.message;
    if (m.ephemeralMessage) m = m.ephemeralMessage.message || m;
    if (m.viewOnceMessage) m = m.viewOnceMessage.message || m;
    if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message || m;
    if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message || m;
    if (m.editedMessage?.message?.protocolMessage?.editedMessage) {
        m = m.editedMessage.message.protocolMessage.editedMessage;
    }

    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        m.buttonsResponseMessage?.selectedButtonId ||
        m.buttonsResponseMessage?.selectedDisplayText ||
        m.listResponseMessage?.singleSelectReply?.selectedRowId ||
        m.listResponseMessage?.title ||
        m.templateButtonReplyMessage?.selectedId ||
        m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
        ''
    );
}

sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                if (!msg.message) continue;

                const remoteJid = msg.key.remoteJid;
                if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') continue;

                const textoOriginal = extrairTextoMensagem(msg);

                const texto = textoOriginal.trim();
                const textoLower = texto.toLowerCase();
                let senderNumber = remoteJid.replace('@s.whatsapp.net', '').replace('@lid', '');
                const pushName = msg.pushName || 'Cliente';

                // Mapeamento exclusivo de LIDs de clientes conhecidos
                if (remoteJid.includes('107941151653891') || senderNumber === '107941151653891') {
                    senderNumber = '5551984843741';
                }

                // =============================================================
                // 1. MENSAGEM ENVIADA PELO PRÓPRIO NÚMERO DA FACILITA MOTO
                // =============================================================
                // Ignora mensagens enviadas pelo próprio robô para evitar loops
                if (msg.key.fromMe) continue;

                // =============================================================
                // 2. MENSAGEM RECEBIDA DO HENRIQUE (DONO / ATENDENTE EXCLUSIVO)
                // =============================================================
                const ehClienteAtivo = activeSupport && (
                    activeSupport.clientJid === remoteJid ||
                    (activeSupport.clientPhone && remoteJid.includes(activeSupport.clientPhone)) ||
                    remoteJid.includes('107941151653891')
                );

                const isHenrique = !ehClienteAtivo && (
                    remoteJid === henriqueJidCache ||
                    henriqueKnownJids.has(remoteJid) ||
                    remoteJid.includes('51986551068') ||
                    remoteJid.includes('5186551068') ||
                    remoteJid.includes('144543030767616')
                );

                if (isHenrique) {
                    henriqueKnownJids.add(remoteJid);
                    henriqueJidCache = remoteJid;
                    console.log(`💬 [Mensagem do Henrique capturada]: "${texto}" de ${remoteJid} | Suporte Ativo:`, activeSupport);

                    // 2.1. Comandos de Controle do Administrador
                    if (textoLower === '#sair' || textoLower === '#fechar' || textoLower === '#encerrar') {
                        if (activeSupport && activeSupport.clientJid) {
                            await enviarMensagem(activeSupport.clientJid, `✅ *Atendimento Finalizado!*\nA equipe da Facilita Moto agradece seu contato. Se precisar de mais informações, envie qualquer mensagem para abrir o menu.`);
                            const sessao = clientSessions.get(activeSupport.clientJid);
                            if (sessao) sessao.mode = 'MENU';
                            await enviarMensagem(remoteJid, `👍 Atendimento com *${activeSupport.clientName}* (${activeSupport.clientPhone}) encerrado com sucesso. O robô automático voltou a responder por lá.`);
                            limparSuporteAtivo();
                        } else {
                            await enviarMensagem(remoteJid, `Nenhum cliente em atendimento ativo no momento.`);
                        }
                        continue;
                    }

                    if (textoLower === '#status') {
                        const isSelf = activeSupport && (
                            activeSupport.clientJid === remoteJid ||
                            henriqueKnownJids.has(activeSupport.clientJid) ||
                            activeSupport.clientJid.includes('51986551068') ||
                            activeSupport.clientJid.includes('5186551068')
                        );
                        const statusMsg = activeSupport && activeSupport.clientJid && !isSelf
                            ? `👤 *Cliente em Atendimento Ativo:*\n• Nome: *${activeSupport.clientName}*\n• Telefone: *${activeSupport.clientPhone}*\n\n💬 *Basta digitar qualquer mensagem aqui normalmente para falar com ele pelo WhatsApp da Facilita!*\nPara encerrar digite *#sair*.`
                            : `Nenhum cliente externo em atendimento no momento.\nPara iniciar conversa com um cliente agora, digite *#atender [número]* (ex: #atender 51999998888).`;
                        await enviarMensagem(remoteJid, statusMsg);
                        continue;
                    }

                    if (textoLower.startsWith('#atender ')) {
                        const novoNumero = texto.replace(/#atender/i, '').trim();
                        const novoJid = await getValidatedJid(novoNumero);
                        const phoneFmt = formatarParaWaMe(novoNumero);
                        salvarSuporteAtivo(novoJid, phoneFmt, `Cliente ${phoneFmt}`);
                        const sessao = clientSessions.get(novoJid) || {};
                        sessao.mode = 'HUMAN_SUPPORT';
                        clientSessions.set(novoJid, sessao);

                        await enviarMensagem(remoteJid, `✅ *Ponte Conectada!*\nVocê agora está conectado com o cliente: *${phoneFmt}*.\nDigite sua mensagem normalmente que ela será entregue a ele pelo WhatsApp da Facilita!`);
                        continue;
                    }

                    if (textoLower === '#leads') {
                        if (leadsFilaDeEspera.length === 0) {
                            await enviarMensagem(remoteJid, `📋 Nenhum lead na fila de espera no momento.`);
                        } else {
                            const lista = leadsFilaDeEspera.slice(0, 10).map((l, i) => `${i + 1}. *${l.nome}* (${l.telefone}) - ${l.hora}\n"${l.dados}"`).join('\n\n');
                            await enviarMensagem(remoteJid, `📋 *ÚLTIMOS LEADS DA FILA DE ESPERA:*\n\n${lista}`);
                        }
                        continue;
                    }

                    if (textoLower === '#ajuda') {
                        await enviarMensagem(remoteJid, `🛠️ *COMANDOS DISPONÍVEIS:*
• Qualquer mensagem de texto: Envia direto para o cliente ativo pelo WhatsApp da Facilita.
• *#sair*: Encerra o atendimento humano e religa o robô para o cliente.
• *#status*: Mostra quem está conectado com você.
• *#atender [número]*: Conecta o atendimento a um cliente (ex: #atender 51999998888).
• *#leads*: Lista os clientes na fila de espera.`);
                        continue;
                    }

                    // 2.2. ENVIO DIRETO DA MENSAGEM DO HENRIQUE PARA O CLIENTE (RELAY BRIDGE)
                    const isSelfClient = activeSupport && (
                        activeSupport.clientJid === remoteJid ||
                        henriqueKnownJids.has(activeSupport.clientJid) ||
                        activeSupport.clientJid.includes('51986551068') ||
                        activeSupport.clientJid.includes('5186551068')
                    );

                    if (activeSupport && activeSupport.clientJid && !isSelfClient) {
                        // Envia a mensagem para o cliente ATRAVÉS DO WHATSAPP OFICIAL DA FACILITA MOTO
                        const entregue = await enviarMensagem(activeSupport.clientJid, textoOriginal);

                        if (entregue) {
                            // Dá reação de check verde ✅ na mensagem do Henrique para confirmação visual imediata
                            try {
                                await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                            } catch (e) {}

                            // Confirmação por texto para Henrique
                            await enviarMensagem(remoteJid, `✓ Entregue para *${activeSupport.clientName}* (${activeSupport.clientPhone}) pelo WhatsApp da Facilita!`);
                            console.log(`🚀 [Relay] Mensagem de Henrique entregue para ${activeSupport.clientJid}`);
                        } else {
                            await enviarMensagem(remoteJid, `❌ Não foi possível entregar para ${activeSupport.clientPhone}. Verifique se o número existe ou tente novamente.`);
                        }
                    } else {
                        if (isSelfClient) limparSuporteAtivo();
                        if (texto.startsWith("#")) {
                            await enviarMensagem(remoteJid, `Olá Henrique! Você está no canal administrativo da Facilita Moto.\nNo momento não há nenhum cliente externo em atendimento ativo.\n\n👉 Para conectar e falar com um cliente agora, digite:\n*#atender [número]* (ex: *#atender 51999998888*)\n\nAssim que você conectar, qualquer mensagem enviada aqui será repassada na hora para ele!`);
                            continue;
                        }
                        console.log("🧪 [Teste Admin]: Henrique digitou \"" + texto + "\". Prosseguindo para fluxo de atendimento do bot.");
                    }
                }

                // =============================================================
                // 3. MENSAGEM RECEBIDA DE UM CLIENTE
                // =============================================================
                console.log("📨 [Msg Recebida]: \"" + texto + "\" de " + remoteJid + " (" + pushName + ") | Modo Atual: " + (clientSessions.get(remoteJid)?.mode || 'NOVO'));
                let sessao = clientSessions.get(remoteJid) || { mode: 'MENU', lastActive: Date.now() };

                // 3.0. PROTEÇÃO CONTRA TRAVAMENTO EM MODO HUMANO:
                // Se o cliente ficou inativo por mais de 15 minutos, volta AUTOMATICAMENTE para o menu
                const tempoInativo = Date.now() - (sessao.lastActive || 0);
                if (sessao.mode === 'HUMAN_SUPPORT' && tempoInativo > 15 * 60 * 1000) {
                    console.log(`⏱️ [Sessão Expirada]: ${remoteJid} inativo há mais de 15min. Retornando ao MENU.`);
                    sessao.mode = 'MENU';
                    if (activeSupport && activeSupport.clientJid === remoteJid) {
                        limparSuporteAtivo();
                    }
                }

                // PRIORIDADE MÁXIMA: Se o cliente digitou qualquer opção numérica (1 a 6), saudação ou palavra-chave, SAI IMEDIATAMENTE do HUMAN_SUPPORT e atende na hora!
                const digitosEntrada = texto.replace(/\D/g, '');
                const querOpcaoOuMenu = ['0', '1', '2', '3', '4', '5', '6'].includes(texto) ||
                                       ['0', '1', '2', '3', '4', '5', '6'].includes(digitosEntrada) ||
                                       ['menu', 'sair', 'voltar', 'inicio', 'início', 'opcoes', 'opções', 'oi', 'ola', 'olá', 'bom dia', 'boa tarde', 'boa noite', 'ajuda', 'quero', 'aluguel', 'motos', 'moto', 'lojista', 'loja', 'parceiro', 'parceria', 'sou lojista'].includes(textoLower) ||
                                       textoLower.includes('opcao') || textoLower.includes('opção') ||
                                       textoLower.includes('roubo') || textoLower.includes('furto') || textoLower.includes('socorro') || textoLower.includes('emergencia') || textoLower.includes('emergência');

                if (sessao.mode === 'HUMAN_SUPPORT' && querOpcaoOuMenu) {
                    console.log(`🔄 [Sessão Reset]: Cliente ${remoteJid} digitou "${texto}". Alternando de HUMAN_SUPPORT para MENU.`);
                    sessao.mode = 'MENU';
                    if (activeSupport && activeSupport.clientJid === remoteJid) {
                        limparSuporteAtivo();
                    }
                }

                // 3.1. SE O CLIENTE REALMENTE ESTÁ EM ATENDIMENTO HUMANO ATIVO (conversando agora)
                if (sessao.mode === 'HUMAN_SUPPORT') {
                    // Garante que este cliente é o cliente ativo no suporte com Henrique
                    const phoneWaMe = formatarParaWaMe(senderNumber);
                    salvarSuporteAtivo(remoteJid, phoneWaMe, pushName);
                    sessao.lastActive = Date.now();
                    clientSessions.set(remoteJid, sessao);

                    // AVISA O CLIENTE IMEDIATAMENTE (nunca deixa o cliente no vácuo sem resposta!)
                    await enviarMensagem(remoteJid, '📩 *Mensagem recebida e repassada ao atendente!*\nEm instantes responderemos por aqui.\n\n*(Se preferir ver as opções automáticas e valores agora, digite "menu" ou "0").*');

                    // REPASSA A MENSAGEM DO CLIENTE PARA O WHATSAPP DO HENRIQUE COM REDUNDÂNCIA TOTAL
                    const alertaCliente = '👤 *[Cliente ' + pushName + ' - ' + phoneWaMe + ']:*\n"' + (textoOriginal || '[Foto ou Áudio enviado]') + '"\n\n👉 *Basta responder esta mensagem para falar com ele pelo WhatsApp da Facilita!*\n*(Para finalizar digite #sair).*';
                    await notificarHenrique(alertaCliente);
                    continue;
                }

                // 3.15. SE O CLIENTE ESTAVA INFORMANDO PLACA/CPF PARA DESBLOQUEIO DE MOTO
                if (sessao.mode === 'WAITING_UNLOCK_INFO') {
                    if (texto === '0' || textoLower === 'menu' || textoLower === 'voltar') {
                        sessao.mode = 'MENU';
                        clientSessions.set(remoteJid, sessao);
                        await enviarMensagem(remoteJid, MENUS.principal);
                        continue;
                    }

                    try {
                        await enviarMensagem(remoteJid, "⏳ *Consultando frota e buscando contrato no sistema... Só um instante!*");

                        const veiculo = await buscarVeiculoCompleto(textoOriginal);

                        if (!veiculo || !veiculo.encontrado) {
                            await enviarMensagem(remoteJid, `⚠️ *Nenhum veículo localizado com a informação "*${textoOriginal}*"!*\n\nPor favor, digite a sua placa correta ou o seu CPF.\n*(Caso precise de ajuda imediata, digite 5 para falar com o atendente).*\nDigite *0* para voltar ao menu.`);
                            sessao.mode = 'WAITING_UNLOCK_INFO';
                            clientSessions.set(remoteJid, sessao);
                            continue;
                        }

                        sessao.mode = 'MENU';
                        clientSessions.set(remoteJid, sessao);

                        const descIdentificador = `${veiculo.placa} - ${veiculo.clienteNome}`;
                        const pixData = await criarPixMercadoPago(descIdentificador, veiculo.valor);

                        const textoPix = `✅ *DADOS LOCALIZADOS COM SUCESSO!* 🏍️🔑\n\n` +
                            `🏍️ *Veículo:* ${veiculo.placa} (${veiculo.modelo})\n` +
                            `👤 *Locatário:* ${veiculo.clienteNome}\n` +
                            `💰 *Valor do Desbloqueio:* R$ ${veiculo.valor.toFixed(2)}\n` +
                            `🏦 *Beneficiário:* Henrique Rocha Clavijo (Mercado Pago Oficial)\n` +
                            `⚡ *Desbloqueio:* Imediato via satélite Xtrack após o pagamento!\n\n` +
                            `📋 *Copie o código PIX Copia e Cola abaixo para pagar:*`;

                        await enviarMensagem(remoteJid, textoPix);

                        setTimeout(async () => {
                            await enviarMensagem(remoteJid, pixData.pixCopiaECola);

                            setTimeout(async () => {
                                await enviarMensagem(remoteJid, `📲 *Como funciona o Desbloqueio Automático:*\n` +
                                    `1. Abra o app do seu banco e escolha *PIX Copia e Cola*.\n` +
                                    `2. Cole o código acima e pague.\n` +
                                    `3. O Mercado Pago avisa nosso sistema e a sua moto *${veiculo.placa}* é *DESBLOQUEADA NA HORA* via satélite! 🔓🚀\n\n` +
                                    `*(Estamos aguardando seu pagamento. Assim que pagar, você receberá a confirmação aqui!)*\n` +
                                    `Digite *0* para voltar ao menu.`);
                            }, 800);
                        }, 500);

                        if (pixData.paymentId) {
                            monitorarPagamentoEDesbloquear(pixData.paymentId, veiculo.placa, remoteJid);
                        }
                    } catch (errUnlock) {
                        console.error('Erro no fluxo de desbloqueio:', errUnlock);
                        await enviarMensagem(remoteJid, `⚠️ Ocorreu uma oscilação momentânea ao gerar a cobrança. Digite *3* para tentar novamente ou *5* para falar com o atendente.`);
                        sessao.mode = 'MENU';
                        clientSessions.set(remoteJid, sessao);
                    }
                    continue;
                }

                // 3.2. SE O CLIENTE ESTAVA ENVIANDO DADOS PARA A FILA DE ESPERA (NOVO LEAD)
                if (sessao.mode === 'WAITING_LEAD_INFO') {
                    if (texto === '0' || textoLower === 'menu' || textoLower === 'voltar') {
                        sessao.mode = 'MENU';
                        clientSessions.set(remoteJid, sessao);
                        await enviarMensagem(remoteJid, MENUS.principal);
                        continue;
                    }

                    sessao.mode = 'MENU';
                    clientSessions.set(remoteJid, sessao);

                    const horaSP = getSaoPauloDate().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                    const phoneWaMe = formatarParaWaMe(senderNumber);

                    const novoLead = {
                        id: `LEAD-${Date.now()}`,
                        nome: pushName,
                        telefone: phoneWaMe,
                        dados: textoOriginal || 'Enviou documento/foto',
                        hora: horaSP,
                        timestamp: Date.now()
                    };
                    leadsFilaDeEspera.unshift(novoLead);
                    if (leadsFilaDeEspera.length > 50) leadsFilaDeEspera.pop();

                    const respCliente = `✅ *CADASTRO REALIZADO NA FILA DE ESPERA!* 🏍️📋

Muito obrigado, *${pushName}*! Seus dados foram cadastrados com sucesso em nossa Fila de Espera prioritária.

Assim que uma moto for liberada para locação, entraremos em contato direto com você por aqui!

*(Lembrando que os requisitos para retirada são: R$ 700,00 de entrada [caução + 1ª semana], CNH A, comprovante de residência e 1 testemunha no contrato).*

Digite *0* para voltar ao menu principal.`;
                    await enviarMensagem(remoteJid, respCliente);

                    const hJid = henriqueJidCache || await getValidatedJid(HENRIQUE_RAW_PHONE);
                    if (hJid) {
                        const alertaLead = `🔥 *NOVO LEAD NA FILA DE ESPERA — FACILITA MOTO* 🔥
👤 *Nome:* ${pushName}
📱 *Telefone:* ${phoneWaMe}
⏰ *Horário:* ${horaSP}
💬 *Dados informados:*
"${textoOriginal || '[Foto ou documento enviado]'}"

👉 *CLIQUE AQUI PARA FALAR COM O LEAD AGORA:*
https://wa.me/${phoneWaMe}`;
                        await enviarMensagem(hJid, alertaLead);
                    }
                    continue;
                }

                // 3.3. SE O CLIENTE ESTAVA AGUARDANDO NOME/CPF/PLACA PARA O PIX
                if (sessao.mode === 'WAITING_PIX_INFO') {
                    sessao.mode = 'MENU';
                    clientSessions.set(remoteJid, sessao);

                    await enviarMensagem(remoteJid, `⏳ *Gerando o seu código PIX no Mercado Pago... Só um instante!*`);

                    const pixData = await criarPixMercadoPago(textoOriginal || pushName);

                    const textoPix = `✅ *PIX GERADO COM SUCESSO!* 🏍️💨

👤 *Locatário:* ${pixData.identificador}
💰 *Valor Semanal:* R$ ${pixData.valor}
🏦 *Beneficiário:* Henrique Rocha Clavijo (Mercado Pago Oficial)
⚡ *Compensação:* Automática no sistema

👇 *Copie o código PIX Copia e Cola abaixo:*`;

                    await enviarMensagem(remoteJid, textoPix);

                    setTimeout(async () => {
                        await enviarMensagem(remoteJid, pixData.pixCopiaECola);

                        setTimeout(async () => {
                            await enviarMensagem(remoteJid, `📱 *Como pagar:*
1. Abra o app do seu banco
2. Escolha a opção *PIX Copia e Cola*
3. Cole o código acima e confirme o pagamento

Assim que você pagar, o sistema reconhece em até 2 minutos e confirma o recebimento automaticamente!
Digite *0* para voltar ao menu principal.`);
                        }, 800);
                    }, 500);

                    continue;
                }

                // -------------------------------------------------------------
                // 3.35. FLUXO MULTI-ETAPAS: SOU LOJISTA (PARCERIAS)
                // -------------------------------------------------------------
                if (sessao.mode === 'LOJISTA_STEP_GERENTE') {
                    if (texto === '0' || textoLower === 'menu' || textoLower === 'voltar') {
                        sessao.mode = 'MENU';
                        clientSessions.set(remoteJid, sessao);
                        await enviarMensagem(remoteJid, MENUS.principal);
                        continue;
                    }

                    sessao.lojista = sessao.lojista || {};
                    sessao.lojista.gerenteELoja = textoOriginal;
                    sessao.mode = 'LOJISTA_STEP_ENDERECO';
                    clientSessions.set(remoteJid, sessao);

                    const msgEndereco = `📍 *ENDEREÇO DA SUA LOJA*\n\nExcelente! Agora, por favor envie o *endereço completo* da sua loja:\n• Rua e Número\n• *Bairro*\n• *CEP* e Cidade\n\n*(Digite 0 para voltar ao menu).*`;
                    await enviarMensagem(remoteJid, msgEndereco);
                    continue;
                }

                if (sessao.mode === 'LOJISTA_STEP_ENDERECO') {
                    if (texto === '0' || textoLower === 'menu' || textoLower === 'voltar') {
                        sessao.mode = 'MENU';
                        clientSessions.set(remoteJid, sessao);
                        await enviarMensagem(remoteJid, MENUS.principal);
                        continue;
                    }

                    sessao.lojista = sessao.lojista || {};
                    sessao.lojista.endereco = textoOriginal;
                    sessao.mode = 'LOJISTA_STEP_PROPOSTA';
                    clientSessions.set(remoteJid, sessao);

                    const msgProposta = `📝 *PROPOSTA DE PARCERIA & CONDIÇÕES ESPECIAIS*\n\nExcelente! Por favor, envie agora a sua *proposta de parceria comercial*:\n\n• Descreva quais serviços ou peças sua loja oferece.\n• Quais as *condições e descontos especiais* para a frota da *Facilita Moto* (ex: desconto em peças, agilidade em revisões, troca de óleo, pneus)?\n\n*(Digite 0 para voltar ao menu).*`;
                    await enviarMensagem(remoteJid, msgProposta);
                    continue;
                }

                if (sessao.mode === 'LOJISTA_STEP_PROPOSTA') {
                    if (texto === '0' || textoLower === 'menu' || textoLower === 'voltar') {
                        sessao.mode = 'MENU';
                        clientSessions.set(remoteJid, sessao);
                        await enviarMensagem(remoteJid, MENUS.principal);
                        continue;
                    }

                    sessao.lojista = sessao.lojista || {};
                    sessao.lojista.proposta = textoOriginal;
                    sessao.mode = 'LOJISTA_STEP_FINAL';
                    clientSessions.set(remoteJid, sessao);

                    const horaSP = getSaoPauloDate().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                    const phoneWaMe = formatarParaWaMe(senderNumber);

                    // Salva a proposta no Firestore
                    salvarPropostaLojistaNoFirestore({
                        clienteNome: pushName,
                        clienteTelefone: phoneWaMe,
                        lojaEGerente: sessao.lojista.gerenteELoja,
                        endereco: sessao.lojista.endereco,
                        proposta: sessao.lojista.proposta,
                        hora: horaSP,
                        timestamp: Date.now()
                    }).catch(() => {});

                    // Notifica o Henrique com prioridade máxima no WhatsApp pessoal (igual furto)
                    const alertaLojistaHenrique = `🏪🤝 *NOVA PROPOSTA DE LOJISTA / OFICINA PARCEIRA!* 🤝🏍️\n👤 *Contato:* ${pushName}\n📱 *WhatsApp:* ${phoneWaMe}\n⏰ *Horário:* ${horaSP}\n\n🏢 *Loja & Gerente:*\n${sessao.lojista.gerenteELoja}\n\n📍 *Endereço Completo, Bairro e CEP:*\n${sessao.lojista.endereco}\n\n📝 *Proposta de Parceria & Condições Especiais:*\n"${sessao.lojista.proposta}"\n\n👉 *Conversa Direta com o Lojista:*\nhttps://wa.me/${phoneWaMe}`;
                    await notificarHenrique(alertaLojistaHenrique);

                    // Pergunta ao lojista se deseja falar com o atendimento agora
                    const msgConclusaoLojista = `✅ *PROPOSTA ENVIADA COM SUCESSO!* 🤝🎉\n\nMuito obrigado, *${pushName}*! Recebemos sua proposta de parceria com a *Facilita Moto*.\nNossa diretoria já recebeu todos os detalhes para avaliação.\n\nDeseja falar com o nosso atendimento agora mesmo?\n\n*1* - 💬 *Falar com o atendimento agora*\n*0* - 🏁 *Concluir e voltar ao menu principal*`;
                    await enviarMensagem(remoteJid, msgConclusaoLojista);
                    continue;
                }

                if (sessao.mode === 'LOJISTA_STEP_FINAL') {
                    const querEncerrar = texto === '0' || textoLower === 'sair' || textoLower === 'menu' || textoLower === 'voltar' || textoLower === 'concluir' || textoLower === 'nao' || textoLower === 'não';

                    if (!querEncerrar) {
                        // Conecta imediatamente ao suporte humano (sem restrição de horário comercial, igual furto)
                        sessao.mode = 'HUMAN_SUPPORT';
                        clientSessions.set(remoteJid, sessao);

                        const horaSP = getSaoPauloDate().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                        const phoneWaMe = formatarParaWaMe(senderNumber);

                        salvarSuporteAtivo(remoteJid, phoneWaMe, `${pushName} (Lojista)`);

                        const msgLojistaConectado = `🧑‍💼 *ATENDIMENTO CONECTADO!* 🤝\n\nVocê está conectado diretamente com o Henrique da Facilita Moto.\nPode enviar sua mensagem por aqui que responderemos em instantes!\n\n*(Para encerrar a conversa a qualquer momento, digite "sair" ou "0").*`;
                        await enviarMensagem(remoteJid, msgLojistaConectado);

                        // Se digitou algo além de '1', repassa a mensagem já dita para o Henrique
                        const mensagemAdicional = (texto === '1' || digitosTexto === '1') ? 'Lojista solicitou atendimento imediato após enviar proposta.' : textoOriginal;

                        const alertaAtendimentoLojista = `🏪🚨 *ATENDIMENTO DE LOJISTA ACIONADO!* 🚨\n👤 *Lojista:* ${pushName}\n📱 *WhatsApp:* ${phoneWaMe}\n🏢 *Loja:* ${sessao.lojista?.gerenteELoja || 'Loja Parceira'}\n⏰ *Horário:* ${horaSP}\n💬 *Mensagem:* "${mensagemAdicional}"\n\n🟢 *A PONTE ESTÁ ATIVADA!* Basta responder esta mensagem aqui no seu WhatsApp para falar direto com o lojista pelo WhatsApp da Facilita!\n\n👉 Ou abra direto: https://wa.me/${phoneWaMe}\n*(Para encerrar depois, basta digitar #sair).*`;
                        await notificarHenrique(alertaAtendimentoLojista);
                        continue;
                    } else {
                        sessao.mode = 'MENU';
                        clientSessions.set(remoteJid, sessao);
                        await enviarMensagem(remoteJid, `🤝 Muito obrigado pela parceria! Entraremos em contato em breve.\n\n` + MENUS.principal);
                        continue;
                    }
                }

                // =============================================================
                // 3.4. CHATBOT URA SEQUENCIAL 1 A 6
                // =============================================================
                sessao.lastActive = Date.now();
                clientSessions.set(remoteJid, sessao);

                // Extrai dígitos isolados para matching 100% infalível de opções (ex: "1", "1.", "Opção 1", "opcao 1")
                const digitosTexto = texto.replace(/\D/g, '');
                const ehOpcao1 = texto === '1' || digitosTexto === '1' || textoLower.includes('opcao 1') || textoLower.includes('opção 1') || textoLower.includes('motos') || textoLower.includes('disponivel') || textoLower.includes('aluguel') || textoLower.includes('requisito');
                const ehOpcao2 = texto === '2' || digitosTexto === '2' || textoLower.includes('opcao 2') || textoLower.includes('opção 2') || textoLower === 'pix' || textoLower.includes('segunda via') || textoLower.includes('2a via') || textoLower.includes('fatura') || textoLower.includes('pagamento');
                const ehOpcao3 = texto === '3' || digitosTexto === '3' || textoLower.includes('opcao 3') || textoLower.includes('opção 3') || textoLower.includes('desbloqueio') || textoLower.includes('desbloquear');
                
                // Opção 5: Roubo ou Furto (Prioridade total para segurança)
                const ehOpcaoRoubo = texto === '5' || digitosTexto === '5' || textoLower.includes('opcao 5') || textoLower.includes('opção 5') || textoLower.includes('roubo') || textoLower.includes('furto') || textoLower.includes('emergencia') || textoLower.includes('emergência') || textoLower.includes('socorro') || textoLower.includes('assalto');

                // Opção 4: Sou Lojista (Parceria para lojas e oficinas)
                const ehOpcaoLojista = !ehOpcaoRoubo && (texto === '4' || digitosTexto === '4' || textoLower.includes('opcao 4') || textoLower.includes('opção 4') || textoLower.includes('lojista') || textoLower.includes('sou lojista') || textoLower.includes('parceir') || textoLower.includes('parceria'));

                // Opção 6: Falar com Atendente Humano
                const ehOpcaoHumano = !ehOpcaoRoubo && !ehOpcaoLojista && (texto === '6' || digitosTexto === '6' || textoLower.includes('opcao 6') || textoLower.includes('opção 6') || textoLower.includes('atendente') || textoLower.includes('humano') || textoLower.includes('suporte') || textoLower.includes('falar'));

                // Opção 1: Motos Disponíveis
                if (ehOpcao1) {
                    sessao.mode = 'WAITING_LEAD_INFO';
                    clientSessions.set(remoteJid, sessao);
                    await enviarMensagem(remoteJid, MENUS.motos);
                    continue;
                }

                // Opção 2: Segunda via do PIX
                if (ehOpcao2) {
                    sessao.mode = 'WAITING_PIX_INFO';
                    clientSessions.set(remoteJid, sessao);
                    await enviarMensagem(remoteJid, MENUS.pedeIdentificacaoPix);
                    continue;
                }

                // Opção 3: Solicitar Desbloqueio da Moto (com PIX Mercado Pago e Desbloqueio Automático)
                if (ehOpcao3) {
                    sessao.mode = 'WAITING_UNLOCK_INFO';
                    clientSessions.set(remoteJid, sessao);
                    const msgPedePlaca = `🔓 *SOLICITAÇÃO DE DESBLOQUEIO DE MOTO* 🏍️💨\n\n` +
                        `Nosso sistema localiza qualquer moto da frota Facilita Moto em tempo real.\n\n` +
                        `👉 *Digite a PLACA da sua moto* ou o seu *CPF*:\n\n` +
                        `*(Consultaremos o seu contrato e geraremos o PIX exato para liberação satelital imediata!)*\n` +
                        `Digite *0* para voltar ao menu.`;
                    await enviarMensagem(remoteJid, msgPedePlaca);
                    continue;
                }

                // Informações sobre Troca de Óleo (Somente oficina parceira credenciada ou painel adm)
                if (textoLower.includes('oleo') || textoLower.includes('óleo') || textoLower.includes('troca')) {
                    await enviarMensagem(remoteJid, MENUS.oleo);
                    continue;
                }

                // Opção 4: SOU LOJISTA (Parcerias para Lojas e Oficinas)
                if (ehOpcaoLojista) {
                    sessao.mode = 'LOJISTA_STEP_GERENTE';
                    sessao.lojista = {};
                    clientSessions.set(remoteJid, sessao);

                    const msgLojista = `🏪 *SEJA UMA LOJA OU OFICINA PARCEIRA — FACILITA MOTO* 🤝🏍️\n\n` +
                        `Buscamos parcerias com oficinas mecânicas, motopeças e lojas para atendimento, peças e manutenção da nossa frota!\n\n` +
                        `👉 *Para iniciarmos, por favor digite:*\n` +
                        `• *Nome da sua Loja/Oficina*\n` +
                        `• *Nome do Gerente ou Responsável*\n\n` +
                        `*(Digite 0 para voltar ao menu).*`;
                    await enviarMensagem(remoteJid, msgLojista);
                    continue;
                }

                // Opção 5: ROUBO OU FURTO (EMERGÊNCIA 24H)
                if (ehOpcaoRoubo) {
                    // Responde o cliente com instruções de segurança imediatas
                    await enviarMensagem(remoteJid, MENUS.emergenciaRoubo);

                    // Ativa o modo de Atendimento Humano para este cliente
                    sessao.mode = 'HUMAN_SUPPORT';
                    clientSessions.set(remoteJid, sessao);

                    const horaSP = getSaoPauloDate().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                    const phoneWaMe = formatarParaWaMe(senderNumber);

                    // Registra e conecta este cliente na Ponte com Henrique
                    salvarSuporteAtivo(remoteJid, phoneWaMe, pushName);

                    // Cria alerta sonoro para tocar no CRM do administrador
                    const alertObj = {
                        id: `EMERGENCY-${Date.now()}`,
                        clienteNome: pushName,
                        clienteTelefone: phoneWaMe,
                        mensagem: textoOriginal || 'Acionou canal de Roubo/Furto',
                        hora: horaSP,
                        timestamp: Date.now()
                    };
                    activeEmergencies.unshift(alertObj);
                    if (activeEmergencies.length > 20) activeEmergencies.pop();

                    // Salva alerta no Firestore para disparar sirene e notificação no CRM Desktop e Mobile
                    salvarEmergenciaNoFirestore(alertObj).catch(() => {});

                    // Dispara Alerta de Prioridade Máxima no WhatsApp particular do Henrique (com redundância de JIDs)
                    const alertaMaximo = `🚨🚨🚨 *ALERTA MÁXIMO: ROUBO OU FURTO ACIONADO!* 🚨🚨🚨
👤 *Condutor:* ${pushName}
📱 *WhatsApp:* ${phoneWaMe}
⏰ *Hora:* ${horaSP}
💬 *Mensagem dele:* "${textoOriginal || 'Opção 5 - Roubo/Furto'}"

🟢 *A PONTE ESTÁ ATIVADA!*
Basta responder esta mensagem aqui no seu WhatsApp!
Qualquer mensagem que você digitar agora será entregue ao condutor pelo WhatsApp da Facilita \`(51) 8142-9980\`!

👉 Ou clique para abrir a conversa direta: https://wa.me/${phoneWaMe}
⚠️ Acesse o aplicativo Xtrack para bloqueio satelital imediato!
*(Para encerrar depois, digite #sair).*`;
                    await notificarHenrique(alertaMaximo);
                    continue;
                }

                // Opção 6: Falar com Atendente Humano (10h às 18h - Seg a Sáb)
                if (ehOpcaoHumano) {
                    const aberto = isAtendimentoHumanoDisponivel();

                    if (!aberto) {
                        // Fora do expediente comercial: envia aviso e não abre a ponte
                        await enviarMensagem(remoteJid, MENUS.foraDoHorario);
                        continue;
                    }

                    // Dentro do horário (10h às 18h de Seg a Sáb): ativa a ponte direta com Henrique!
                    sessao.mode = 'HUMAN_SUPPORT';
                    clientSessions.set(remoteJid, sessao);

                    const horaSP = getSaoPauloDate().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                    const phoneWaMe = formatarParaWaMe(senderNumber);

                    // Ativa a Ponte de Suporte conectando Henrique ao Cliente
                    salvarSuporteAtivo(remoteJid, phoneWaMe, pushName);

                    const msgConfirmacaoCliente = `🧑‍💼 *ATENDIMENTO HUMANO — FACILITA MOTO*

Olá ${pushName}! Você foi transferido para nossa equipe de atendimento.
A nossa central já foi notificada e vai te responder diretamente por aqui em instantes!

Pode ir digitando sua mensagem ou dúvida enquanto isso. 👇
*(Para cancelar e voltar ao menu automático a qualquer momento, digite "sair").*`;

                    await enviarMensagem(remoteJid, msgConfirmacaoCliente);

                    // Dispara a Notificação com a Ponte Ativada diretamente no WhatsApp pessoal do Henrique
                    const hJid = henriqueJidCache || await getValidatedJid(HENRIQUE_RAW_PHONE, true);
                    if (hJid) {
                        const notificacaoHenrique = `🛎️ *NOVA SOLICITAÇÃO DE ATENDIMENTO HUMANO* 🛎️
👤 *Cliente:* ${pushName}
📱 *WhatsApp:* ${phoneWaMe}
⏰ *Horário:* ${horaSP}
💬 *Mensagem dele:* "${textoOriginal || 'Opção 6 - Falar com Atendente'}"

🟢 *A PONTE ESTÁ ATIVADA!*
Basta responder esta mensagem aqui no seu WhatsApp!
Qualquer mensagem que você digitar agora será entregue ao cliente pelo WhatsApp da Facilita \`(51) 8142-9980\`!

👉 Ou clique para abrir a conversa direta: https://wa.me/${phoneWaMe}
*(Para encerrar depois, basta digitar #sair).*`;
                        await enviarMensagem(hJid, notificacaoHenrique);
                    }
                    continue;
                }

                // Opção 0 ou Voltar
                if (texto === '0' || textoLower === 'menu' || textoLower === 'voltar' || textoLower === 'inicio') {
                    sessao.mode = 'MENU';
                    clientSessions.set(remoteJid, sessao);
                    await enviarMensagem(remoteJid, MENUS.principal);
                    continue;
                }

                // Se o usuário digitou um CPF ou Placa direto, gera o PIX automaticamente
                const ehCpf = /^\d{11}$/.test(texto.replace(/\D/g, '')) || /^\d{3}\.\d{3}\.\d{3}\-\d{2}$/.test(texto);
                const ehPlaca = /^[a-zA-Z]{3}[0-9][a-zA-Z0-9][0-9]{2}$/.test(texto.replace(/\W/g, ''));
                if (ehCpf || ehPlaca) {
                    await enviarMensagem(remoteJid, `⏳ *Identificamos sua solicitação! Gerando seu PIX no Mercado Pago...*`);
                    const pixData = await criarPixMercadoPago(textoOriginal);
                    const textoPix = `✅ *PIX GERADO COM SUCESSO!* 🏍️💨

👤 *Referência:* ${pixData.identificador}
💰 *Valor Semanal:* R$ ${pixData.valor}
🏦 *Beneficiário:* Henrique Rocha Clavijo (Mercado Pago Oficial)

👇 *Copie o código PIX Copia e Cola abaixo:*`;
                    await enviarMensagem(remoteJid, textoPix);
                    setTimeout(async () => {
                        await enviarMensagem(remoteJid, pixData.pixCopiaECola);
                    }, 500);
                    continue;
                }

                // Padrão: Apresenta o Menu Principal
                await enviarMensagem(remoteJid, MENUS.principal);
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

// Endpoint para Resetar Sessões de Clientes Travadas
app.all('/api/clear-sessions', (req, res) => {
    const total = clientSessions.size;
    clientSessions.clear();
    activeSupport = null;
    res.json({ ok: true, cleared: total, message: 'Todas as sessões de clientes foram resetadas para o MENU com sucesso!' });
});

app.get('/api/logs', (req, res) => {
    res.json({ count: recentLogs.length, logs: recentLogs });
});

app.get('/status', (req, res) => {
    res.json({
        connected: isConnected,
        phone: connectedPhone,
        hasQr: !!currentQrCodeDataUrl,
        activeSupportClient: activeSupport ? activeSupport.clientPhone : null,
        totalSessions: clientSessions.size,
        leadsCount: leadsFilaDeEspera.length,
        emergenciesCount: activeEmergencies.length,
        horarioAtendimentoDisponivel: isAtendimentoHumanoDisponivel(),
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Endpoint de Diagnóstico e Inspeção de Identidades
app.get('/api/debug', (req, res) => {
    res.json({
        henriqueKnownJids: Array.from(henriqueKnownJids),
        henriqueJidCache,
        activeSupport,
        sessions: Array.from(clientSessions.entries())
    });
});

// Endpoint de Emergências para o CRM Principal tocar som de sirene
app.get('/api/emergencies', (req, res) => {
    res.json({
        ok: true,
        alerts: activeEmergencies
    });
});

// Endpoint para silenciar emergências
app.post('/api/emergencies/dismiss', (req, res) => {
    const { id } = req.body || {};
    if (id) {
        activeEmergencies = activeEmergencies.filter(a => a.id !== id);
    } else {
        activeEmergencies = [];
    }
    res.json({ ok: true, activeEmergencies: activeEmergencies.length });
});

// Endpoint de Leads para o CRM
app.get('/api/leads', (req, res) => {
    res.json({
        ok: true,
        leads: leadsFilaDeEspera
    });
});

// Endpoint de Ping
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
    const spTime = getSaoPauloDate().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const atendimentoAberto = isAtendimentoHumanoDisponivel();

    res.send(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Robô WhatsApp & URA — Facilita Moto</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        body { background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
        .card { background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 32px; max-width: 520px; width: 100%; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
        .logo { font-size: 2.2rem; font-weight: 800; color: #38bdf8; margin-bottom: 8px; display: flex; align-items: center; justify-content: center; gap: 10px; }
        .subtitle { color: #94a3b8; font-size: 0.9rem; margin-bottom: 24px; }
        .status-badge { display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 999px; font-size: 0.85rem; font-weight: 700; margin-bottom: 24px; }
        .status-connected { background: #065f46; color: #6ee7b7; border: 1px solid #059669; }
        .status-waiting { background: #7c2d12; color: #fdba74; border: 1px solid #ea580c; }
        .qr-box { background: #fff; border-radius: 12px; padding: 16px; display: inline-block; margin-bottom: 20px; box-shadow: 0 8px 24px rgba(0,0,0,0.25); min-width: 280px; min-height: 280px; display: flex; align-items: center; justify-content: center; }
        .qr-box img { width: 280px; height: 280px; object-fit: contain; }
        .btn-refresh { background: #2563eb; color: #fff; border: none; padding: 10px 20px; border-radius: 8px; font-weight: 600; cursor: pointer; transition: 0.2s; font-size: 0.85rem; }
        .btn-refresh:hover { background: #1d4ed8; }
    </style>
</head>
<body>
    <div class="card">
        <div class="logo">
            <i class="fa-solid fa-motorcycle"></i> FACILITA MOTO
        </div>
        <p class="subtitle">Robô URA Inteligente & Ponte Bidirecional de Atendimento</p>

        <div id="status-container">
            ${isConnected ? `
                <div class="status-badge status-connected">
                    <i class="fa-solid fa-circle-check"></i> ONLINE (${connectedPhone})
                </div>
                <div style="background:#064e3b; border:1px solid #059669; border-radius:12px; padding:20px 16px; margin-bottom:20px; text-align:left;">
                    <strong style="font-size:1rem; color:#ecfdf5; display:block; margin-bottom:8px;">
                        <i class="fa-solid fa-robot"></i> Recursos Ativos:
                    </strong>
                    <ul style="font-size:0.85rem; color:#a7f3d0; padding-left:20px; line-height:1.6;">
                        <li><strong>Ponte Celular Ativa:</strong> Henrique responde no <code>51 98655-1068</code> e entrega no WhatsApp da Facilita</li>
                        <li><strong>Cliente Conectado:</strong> ${activeSupport ? `<span style="color:#38bdf8;">${activeSupport.clientName} (${activeSupport.clientPhone})</span>` : 'Nenhum no momento'}</li>
                        <li><strong>Sirene Roubo/Furto:</strong> Dispara som no CRM + Notificação instantânea</li>
                        <li><strong>PIX Automático:</strong> Mercado Pago sem redirecionamento para site</li>
                    </ul>
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
            `}
        </div>

        <button class="btn-refresh" onclick="location.reload()">
            <i class="fa-solid fa-rotate-right"></i> Atualizar Tela
        </button>
    </div>

    <script>
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

// --- ROBÔ COLETOR 24H XTRACK / FULLTRACK (xtrack.app.br / tela.xtrack.app.br) ---
let xtrackSessionCookie = null;
let lastXtrackLoginTime = 0;
let liveFleetTelemetries = new Map();
let lastLiveTelemetry = {
    id: '00018E1B',
    iccid: '89555480000080813880',
    placa: 'IPU2I57',
    lat: -30.043753,
    lng: -51.183861,
    velocidade: 0,
    ignicao: false,
    odometro: 270185,
    kmAtual: 270185,
    endereco: 'Rua Câncio Gomes, 664, Floresta, Porto Alegre - RS, 90220-060, Brasil',
    updatedAt: new Date().toISOString(),
    source: 'xtrack_live_crawler'
};
liveFleetTelemetries.set('IPU2I57', lastLiveTelemetry);
liveFleetTelemetries.set('00018E1B', lastLiveTelemetry);

async function autenticarXtrack() {
    try {
        const initialRes = await fetch('https://tela.xtrack.app.br/', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        });
        const setCookie = initialRes.headers.get('set-cookie');
        const cookies = [];
        if (setCookie) {
            setCookie.split(',').forEach(c => {
                const part = c.split(';')[0].trim();
                if (part && !cookies.includes(part)) cookies.push(part);
            });
        }
        const cookieHeader = cookies.join('; ');

        const formData = new URLSearchParams();
        formData.append('login', process.env.XTRACK_LOGIN || '51986551068');
        formData.append('password', process.env.XTRACK_PASSWORD || '120909');

        const loginRes = await fetch('https://tela.xtrack.app.br/emp/tela', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': cookieHeader,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Origin': 'https://tela.xtrack.app.br',
                'Referer': 'https://tela.xtrack.app.br/'
            },
            body: formData.toString(),
            redirect: 'manual'
        });

        if (loginRes.status === 302 || loginRes.status === 200) {
            xtrackSessionCookie = cookieHeader;
            lastXtrackLoginTime = Date.now();
            console.log('✅ [Xtrack Bot] Sessão autenticada com sucesso em tela.xtrack.app.br!');
            return true;
        }
        return false;
    } catch (e) {
        console.error('❌ [Xtrack Bot] Erro na autenticação:', e.message);
        return false;
    }
}

const KNOWN_FLEET_TRACKERS = {
    'IPU2I57': { id: '00018E1B', iccid: '89555480000080813880', chip: '51986551068', modelo: 'Coban 303 / Xtrack' },
    'IMJ6E36': { id: '00016415', iccid: '5521959604209', imei: '357746431285144', chip: '5521959604209', modelo: 'BWS NB2 (BWS IOT TIM)' }
};

async function coletarTelemetriaXtrackAoVivo() {
    try {
        const now = Date.now();
        if (!xtrackSessionCookie || now - lastXtrackLoginTime > 45 * 60 * 1000) {
            await autenticarXtrack();
        }
        if (!xtrackSessionCookie) return lastLiveTelemetry;

        const vehiclesToProcess = [];

        // 1. Extração Completa da Frota via dados-lista-clientes do mapaGeral
        try {
            const htmlRes = await fetch('https://tela.xtrack.app.br/mapaGeral', {
                headers: {
                    'Cookie': xtrackSessionCookie,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': 'https://tela.xtrack.app.br/emp/tela'
                }
            });
            const html = await htmlRes.text();
            const idx = html.indexOf('id="dados-lista-clientes"');
            if (idx !== -1) {
                const start = html.indexOf('>', idx) + 1;
                const end = html.indexOf('</div>', start);
                const jsonStr = html.substring(start, end).trim();
                const parsed = JSON.parse(jsonStr);
                const regs = parsed?.registros || parsed;
                if (regs && typeof regs === 'object') {
                    for (const cliKey of Object.keys(regs)) {
                        const cliObj = regs[cliKey];
                        if (cliObj && typeof cliObj === 'object') {
                            for (const autKey of Object.keys(cliObj)) {
                                if (cliObj[autKey] && typeof cliObj[autKey] === 'object') {
                                    vehiclesToProcess.push(cliObj[autKey]);
                                }
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.error('⚠️ [Xtrack Bot] Erro ao extrair dados do mapaGeral:', e.message);
        }

        // 2. Fallback / Complemento via atualizaMapa POST
        if (vehiclesToProcess.length === 0) {
            const formData = new URLSearchParams();
            formData.append('clientes[]', '600696');

            let res = await fetch('https://tela.xtrack.app.br/mapaGeral/atualizaMapa', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Cookie': xtrackSessionCookie,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': 'https://tela.xtrack.app.br/mapaGeral',
                    'X-Requested-With': 'XMLHttpRequest'
                },
                body: formData.toString()
            });

            let json = await res.json().catch(() => null);

            if (!json || json.status !== true) {
                console.log('🔄 [Xtrack Bot] Sessão expirou, reautenticando...');
                const ok = await autenticarXtrack();
                if (ok) {
                    res = await fetch('https://tela.xtrack.app.br/mapaGeral/atualizaMapa', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'Cookie': xtrackSessionCookie,
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                            'Referer': 'https://tela.xtrack.app.br/mapaGeral',
                            'X-Requested-With': 'XMLHttpRequest'
                        },
                        body: formData.toString()
                    });
                    json = await res.json().catch(() => null);
                }
            }

            if (json && json.status === true && Array.isArray(json.dados)) {
                vehiclesToProcess.push(...json.dados);
            }
        }

        if (vehiclesToProcess.length > 0) {
            for (const motoData of vehiclesToProcess) {
                const loc = motoData.loc || [];
                const lat = parseFloat(loc[0]);
                const lng = parseFloat(loc[1]);
                const vel = parseInt(motoData.ras_eve_velocidade) || 0;
                const ignicao = parseInt(motoData.ras_eve_ignicao) === 1;
                const odo = parseInt(motoData.ras_veiculos?.ras_vei_odometro) || 0;
                const placa = (motoData.ras_veiculos?.ras_vei_placa || '').toUpperCase().trim();
                const autId = String(motoData.ras_eve_aut_id || motoData.ras_veiculos?.ras_vei_id || '').toUpperCase();

                if (!isNaN(lat) && !isNaN(lng) && placa) {
                    const trackerInfo = KNOWN_FLEET_TRACKERS[placa] || { id: autId, iccid: '', imei: '', chip: '' };
                    const devId = trackerInfo.id || autId;

                    const prev = liveFleetTelemetries.get(placa) || liveFleetTelemetries.get(devId) || liveFleetTelemetries.get(autId);
                    let endereco = prev?.endereco || 'Porto Alegre - RS';
                    if (!prev || Math.abs(lat - prev.lat) > 0.0003 || Math.abs(lng - prev.lng) > 0.0003) {
                        try {
                            const geoRes = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`, {
                                headers: { 'User-Agent': 'FacilitaMotoBot/1.0 (contato@facilitamoto.com.br)' }
                            });
                            const geoData = await geoRes.json();
                            if (geoData && geoData.display_name) {
                                endereco = geoData.display_name;
                            }
                        } catch (e) {}
                    }

                    const telemetryItem = {
                        id: devId,
                        autId: autId,
                        iccid: trackerInfo.iccid || '',
                        imei: trackerInfo.imei || '',
                        chip: trackerInfo.chip || '',
                        placa: placa,
                        lat: lat,
                        lng: lng,
                        velocidade: vel,
                        ignicao: ignicao,
                        odometro: odo,
                        kmAtual: odo,
                        endereco: endereco,
                        updatedAt: new Date().toISOString(),
                        source: 'xtrack_live_crawler'
                    };

                    liveFleetTelemetries.set(placa, telemetryItem);
                    liveFleetTelemetries.set(devId, telemetryItem);
                    liveFleetTelemetries.set(autId, telemetryItem);
                    if (placa === 'IPU2I57' || !lastLiveTelemetry) {
                        lastLiveTelemetry = telemetryItem;
                    }

                    // Envia telemetria ao vivo para a API do CRM Vercel
                    fetch('https://www.facilitamoto.com.br/api/telemetry', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(telemetryItem)
                    }).catch(() => {});

                    console.log(`📡 [Xtrack Live Multi-Frota]: ${placa} (ID: ${devId} / Aut: ${autId}) | Lat: ${lat}, Lng: ${lng} | ${vel} km/h | Ign: ${ignicao ? 'ON' : 'OFF'} | Odo: ${odo} km`);
                }
            }
        }
        return lastLiveTelemetry;
    } catch (err) {
        console.error('⚠️ [Xtrack Bot Error]:', err.message);
        return lastLiveTelemetry;
    }
}

// Endpoint de Consulta em Tempo Real pelo CRM (Suporta Placa ou ID específico da Moto)
app.get('/api/tracker-live', (req, res) => {
    const qPlaca = (req.query.placa || '').toUpperCase().trim();
    const qId = (req.query.id || '').toUpperCase().trim();
    let dev = null;
    if (qPlaca && liveFleetTelemetries.has(qPlaca)) dev = liveFleetTelemetries.get(qPlaca);
    else if (qId && liveFleetTelemetries.has(qId)) dev = liveFleetTelemetries.get(qId);
    else dev = lastLiveTelemetry;

    const uniqueFleet = Array.from(new Set(liveFleetTelemetries.values()));
    res.json({
        status: 'ok',
        device: dev,
        fleet: uniqueFleet,
        count: uniqueFleet.length,
        lastSync: dev ? dev.updatedAt : null
    });
});

// Endpoint para Forçar Sincronização Imediata
app.post('/api/tracker-sync', async (req, res) => {
    const data = await coletarTelemetriaXtrackAoVivo();
    res.json({ status: 'ok', device: data, count: liveFleetTelemetries.size });
});

// Endpoint Principal de Disparo de Mensagens (/send-message) do CRM
app.post('/send-message', async (req, res) => {
    const body = req.body || {};
    const dest = body.phone || body.number || body.to;
    const msg = body.message || body.text || body.body;
    const pixCopiaECola = body.pixCopiaECola || '';

    if (!dest || !msg) {
        return res.status(400).json({
            success: false,
            error: 'Campos "phone" e "message" são obrigatórios.'
        });
    }

    if (!isConnected || !sock) {
        return res.status(503).json({
            success: false,
            error: 'Robô do WhatsApp ainda não está conectado.'
        });
    }

    const targetJid = await getValidatedJid(dest);

    try {
        console.log(`📤 Enviando mensagem disparada pelo CRM para: ${targetJid}`);
        const sent = await sock.sendMessage(targetJid, { text: String(msg) });

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


// =====================================================================
// WATCHDOG & HEARTBEAT 24/7 PARA EMERGÊNCIA DE ROUBO/FURTO
// =====================================================================
// 1. Presença ativa contínua a cada 30 segundos para o WhatsApp não derrubar o socket
setInterval(async () => {
    if (isConnected && sock) {
        try {
            await sock.sendPresenceUpdate('available');
        } catch (e) {}
    }
}, 30 * 1000);

// 2. Watchdog anti-queda: se desconectar por mais de 30 segundos, força reconexão imediata
let tempoUltimaConexaoAtiva = Date.now();
setInterval(() => {
    if (isConnected) {
        tempoUltimaConexaoAtiva = Date.now();
    } else {
        const tempoFora = Date.now() - tempoUltimaConexaoAtiva;
        if (tempoFora > 35000) {
            console.log(`🛡️ [Watchdog 24h Emergência] Bot offline há ${Math.round(tempoFora / 1000)}s. Acionando reconexão forçada imediata...`);
            tempoUltimaConexaoAtiva = Date.now();
            try {
                if (sock) {
                    try { sock.end(); } catch (e) {}
                }
                startWhatsAppBot();
            } catch (err) {
                console.error('Erro no Watchdog ao reconectar:', err);
            }
        }
    }
}, 15 * 1000);

// 3. Auto Keep-Alive interno a cada 3 minutos (Render nunca hiberna)
setInterval(async () => {
    try {
        await fetch('https://facilita-whatsapp-bot.onrender.com/ping');
    } catch (e) {}
}, 3 * 60 * 1000);

app.listen(PORT, () => {
    console.log(`🚀 [Facilita WhatsApp Bot] Rodando na porta ${PORT}`);
    
    // Auto Keep-Alive anti-hibernação do Render (Evita desligamento após 15 min de inatividade)
    setInterval(() => {
        fetch('https://facilita-whatsapp-bot.onrender.com/status')
            .then(r => r.json())
            .then(d => {
                console.log(`📡 [Keep-Alive Ping]: Status = ${d.connected ? '✅ Conectado (' + d.phone + ')' : '⚠️ Desconectado (Aguardando QR Code)'}`);
            })
            .catch(err => console.error('⚠️ [Keep-Alive Error]:', err.message));
    }, 8 * 60 * 1000); // Dispara a cada 8 minutos

    // Robô Coletor 24h de GPS do Xtrack (Atualiza posição a cada 20 segundos)
    setInterval(() => {
        coletarTelemetriaXtrackAoVivo().catch(e => console.error('Erro ciclo telemetria:', e.message));
    }, 20 * 1000);

    // Primeira coleta imediata após 4 segundos de inicialização
    setTimeout(() => {
        coletarTelemetriaXtrackAoVivo().catch(e => console.error('Erro primeira telemetria:', e.message));
    }, 4000);
});
