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
async function criarPixMercadoPago(identificador = 'Cliente') {
    const valor = 350.00;
    const txidUnico = `MP${Date.now().toString().slice(-10)}`;
    let pixCopiaECola = '';

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
                    first_name: identificador.substring(0, 20),
                    last_name: 'Facilita Moto'
                }
            })
        });

        if (mpResp.ok) {
            const mpData = await mpResp.json();
            pixCopiaECola = mpData.point_of_interaction?.transaction_data?.qr_code || '';
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
            descricao: `FACILITA ${identificador.substring(0, 10)}`
        });
    }

    return {
        valor: valor.toFixed(2).replace('.', ','),
        identificador,
        pixCopiaECola
    };
}

async function getValidatedJid(numero, ehHenrique = false) {
    if (!sock || !isConnected) return null;
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

*Digite o NÚMERO da opção desejada:*

*1* - 🏍️ Motos Disponíveis (Fila de Espera e Requisitos)
*2* - 💳 2ª Via do PIX Semanal (Gerar código na hora)
*3* - 🛢️ Informar Troca de Óleo (1.000 km)
*4* - 🔓 Solicitar Desbloqueio da Moto
*5* - 🚨 Informar Roubo ou Furto (Emergência 24h)
*6* - 💬 Falar com Atendente Humano`,

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

⚠️ *Atenção aos prazos para preservar o motor da sua moto:*
• A troca de óleo deve ser feita rigorosamente a cada *1.000 km rodados* (tolerância máxima de até 1.100 km).
• Óleo recomendado: 20W-50 Mineral ou Semissintético 10W-30 conforme especificação Honda.
• Tire uma foto nítida do painel marcando o km e do frasco do óleo e envie aqui nesta conversa para registro!

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

    foraDoHorario: `🕒 *ATENDIMENTO COM ATENDENTE HUMANO*

Nosso horário de atendimento é:
🗓️ *Segunda a Sábado: das 10h00 às 18h00*.
🚫 Domingos e feriados: Plantão restrito a emergências.

No momento estamos fora do horário de expediente. Deixe sua mensagem e dúvida aqui, e responderemos assim que abrirmos às 10h!

*(Se for emergência de roubo/furto, digite 5 para acionamento imediato).*`
};

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

                atualizarIdentidadesHenrique().catch(e => console.warn('Erro ao atualizar identidades:', e));
            }
        });

        // =====================================================================
        // PROCESSAMENTO DE MENSAGENS RECEBIDAS (CHATBOT URA + RELAY BRIDGE)
        // =====================================================================
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                if (!msg.message) continue;

                const remoteJid = msg.key.remoteJid;
                if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') continue;

                const textoOriginal = msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    msg.message.imageMessage?.caption ||
                    msg.message.videoMessage?.caption ||
                    '';

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
                if (msg.key.fromMe) {
                    // Se alguém digitou no próprio aparelho da Facilita para um cliente,
                    // ativa o modo humano para o robô não interromper com menu
                    if (!remoteJid.includes(HENRIQUE_RAW_PHONE) && !remoteJid.includes('5186551068')) {
                        const sessao = clientSessions.get(remoteJid) || {};
                        sessao.mode = 'HUMAN_SUPPORT';
                        sessao.lastActive = Date.now();
                        clientSessions.set(remoteJid, sessao);
                    }
                    continue;
                }

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
                    (pushName && (pushName.toLowerCase().includes('henrique') || pushName.toLowerCase().includes('rocha'))) ||
                    // Se o atendimento humano está ativo com um cliente externo e outra pessoa responde:
                    (activeSupport && (Date.now() - activeSupport.startedAt < 30 * 60 * 1000) && remoteJid !== activeSupport.clientJid)
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
                        await enviarMensagem(remoteJid, `Olá Henrique! Você está no canal administrativo da Facilita Moto.\nNo momento não há nenhum cliente externo em atendimento ativo.\n\n👉 Para conectar e falar com um cliente agora, digite:\n*#atender [número]* (ex: *#atender 51999998888*)\n\nAssim que você conectar, qualquer mensagem enviada aqui será repassada na hora para ele!`);
                    }
                    continue;
                }

                // =============================================================
                // 3. MENSAGEM RECEBIDA DE UM CLIENTE
                // =============================================================
                let sessao = clientSessions.get(remoteJid) || { mode: 'MENU', lastActive: Date.now() };

                // 3.1. SE O CLIENTE JÁ ESTÁ EM ATENDIMENTO HUMANO
                if (sessao.mode === 'HUMAN_SUPPORT') {
                    // Cliente quer voltar para o menu
                    if (textoLower === 'sair' || textoLower === '#sair' || textoLower === 'menu' || textoLower === 'voltar') {
                        sessao.mode = 'MENU';
                        clientSessions.set(remoteJid, sessao);
                        if (activeSupport && activeSupport.clientJid === remoteJid) {
                            limparSuporteAtivo();
                        }
                        await enviarMensagem(remoteJid, MENUS.principal);

                        const hJid = henriqueJidCache || await getValidatedJid(HENRIQUE_RAW_PHONE);
                        if (hJid) {
                            await enviarMensagem(hJid, `ℹ️ O cliente *${pushName}* (${senderNumber}) encerrou o atendimento humano e voltou ao menu.`);
                        }
                        continue;
                    }

                    // Garante que este cliente é o cliente ativo no suporte com Henrique
                    const phoneWaMe = formatarParaWaMe(senderNumber);
                    salvarSuporteAtivo(remoteJid, phoneWaMe, pushName);

                    // REPASSA A MENSAGEM DO CLIENTE PARA O WHATSAPP DO HENRIQUE
                    const hJid = henriqueJidCache || await getValidatedJid(HENRIQUE_RAW_PHONE);
                    if (hJid) {
                        const alertaCliente = `💬 *[Cliente ${pushName} - ${phoneWaMe}]:*
"${textoOriginal || '[Foto ou Áudio enviado]'}"

👉 *Basta responder esta mensagem para falar com ele pelo WhatsApp da Facilita!*
*(Para finalizar digite #sair).*`;
                        await enviarMensagem(hJid, alertaCliente);
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

                // =============================================================
                // 3.4. CHATBOT URA SEQUENCIAL 1 A 6
                // =============================================================
                sessao.lastActive = Date.now();
                clientSessions.set(remoteJid, sessao);

                // Opção 1: Motos Disponíveis
                if (texto === '1' || textoLower.includes('motos') || textoLower.includes('disponivel') || textoLower.includes('aluguel') || textoLower.includes('valor')) {
                    sessao.mode = 'WAITING_LEAD_INFO';
                    clientSessions.set(remoteJid, sessao);
                    await enviarMensagem(remoteJid, MENUS.motos);
                    continue;
                }

                // Opção 2: Segunda via do PIX
                if (texto === '2' || textoLower === 'pix' || textoLower.includes('segunda via') || textoLower.includes('2a via') || textoLower.includes('fatura')) {
                    sessao.mode = 'WAITING_PIX_INFO';
                    clientSessions.set(remoteJid, sessao);
                    await enviarMensagem(remoteJid, MENUS.pedeIdentificacaoPix);
                    continue;
                }

                // Opção 3: Informar Troca de Óleo
                if (texto === '3' || textoLower.includes('oleo') || textoLower.includes('óleo') || textoLower.includes('troca')) {
                    await enviarMensagem(remoteJid, MENUS.oleo);
                    continue;
                }

                // Opção 4: Solicitar Desbloqueio
                if (texto === '4' || textoLower.includes('desbloqueio') || textoLower.includes('desbloquear')) {
                    await enviarMensagem(remoteJid, MENUS.desbloqueio);
                    continue;
                }

                // Opção 5: ROUBO OU FURTO (EMERGÊNCIA 24H)
                if (texto === '5' || textoLower.includes('roubo') || textoLower.includes('furto') || textoLower.includes('emergencia') || textoLower.includes('emergência') || textoLower.includes('socorro')) {
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

                    // Dispara Alerta de Prioridade Máxima no WhatsApp particular do Henrique
                    const hJid = henriqueJidCache || await getValidatedJid(HENRIQUE_RAW_PHONE);
                    if (hJid) {
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
                        await enviarMensagem(hJid, alertaMaximo);
                    }
                    continue;
                }

                // Opção 6: Falar com Atendente Humano (Ponte Bidirecional 24h Henrique <-> Cliente)
                if (texto === '6' || textoLower.includes('atendente') || textoLower.includes('falar') || textoLower.includes('humano')) {
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

app.listen(PORT, () => {
    console.log(`🚀 [Facilita WhatsApp Bot] Rodando na porta ${PORT}`);
});
