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

// Configuração do Telefone Particular do Henrique para Notificações e Atendimento Humano
const HENRIQUE_RAW_PHONE = '5551986551068';
let henriqueJidCache = null;

// Armazenamento de Sessões dos Clientes e Ponte de Atendimento Humano (Relay Bridge)
const clientSessions = new Map();
let activeRelayClientJid = null; // Cliente que está conversando com Henrique no momento

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

// Retorna o horário de Brasília (UTC-3)
function getSaoPauloDate() {
    const now = new Date();
    const spString = now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" });
    return new Date(spString);
}

// Verifica se está dentro do horário de atendimento humano: Segunda a Sábado das 10h às 18h
function isAtendimentoHumanoDisponivel() {
    const spDate = getSaoPauloDate();
    const dia = spDate.getDay(); // 0 = Domingo, 1 = Segunda, ..., 6 = Sábado
    const hora = spDate.getHours(); // 0 a 23

    // Segunda (1) a Sábado (6), das 10h00 às 17h59 (fecha às 18h00)
    const diaValido = dia >= 1 && dia <= 6;
    const horaValida = hora >= 10 && hora < 18;
    return diaValido && horaValida;
}

// Resolve o JID exato no WhatsApp (resolve o 9º dígito brasileiro)
async function getValidatedJid(numero) {
    if (!sock || !isConnected) return null;
    const numLimpo = normalizarTelefone(numero);
    try {
        const check = await sock.onWhatsApp(numLimpo);
        if (check && check.length > 0 && check[0].exists) {
            return check[0].jid;
        }
        if (numLimpo.startsWith('55') && numLimpo.length === 13) {
            const semNove = `${numLimpo.substring(0, 4)}${numLimpo.substring(5)}`;
            const checkSemNove = await sock.onWhatsApp(semNove);
            if (checkSemNove && checkSemNove.length > 0 && checkSemNove[0].exists) {
                return checkSemNove[0].jid;
            }
        } else if (numLimpo.startsWith('55') && numLimpo.length === 12) {
            const comNove = `${numLimpo.substring(0, 4)}9${numLimpo.substring(4)}`;
            const checkComNove = await sock.onWhatsApp(comNove);
            if (checkComNove && checkComNove.length > 0 && checkComNove[0].exists) {
                return checkComNove[0].jid;
            }
        }
    } catch (e) {
        console.warn('[JID Lookup Warning]:', e.message);
    }
    return `${numLimpo}@s.whatsapp.net`;
}

// Envia mensagem segura
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

// Mensagens padrão da URA
const MENUS = {
    principal: `👋 Olá! Seja muito bem-vindo(a) à *Facilita Moto*! 🏍️💨
Sua melhor opção em locação de motos com quilometragem livre e suporte completo.

Como podemos te ajudar hoje? *Digite o número da opção desejada:*

*1* - 🏍️ *Saber sobre Motos Disponíveis* (Valores e Requisitos)
*2* - 👤 *Já sou Cliente* (2ª via PIX, Manutenção e Desbloqueio)
*3* - 🚨 *Informar Roubo ou Furto* (Canal de Emergência 24h)
*4* - 💬 *Falar com um Atendente*`,

    motos: `🏍️ *FACILITA MOTO — INFORMAÇÕES DE LOCAÇÃO*

✅ *Modelo Disponível:* Honda CG 150 Titan Mix
• Super econômica, revisada e pronta para rodar e lucrar!
• *Quilometragem Livre* (rode o quanto precisar).
• *Rastreador Xtrack integrado* com telemetria e bloqueio via satélite.
• Manutenção preventiva de desgaste natural por nossa conta.

💰 *Valores:*
• *R$ 350,00 por semana* (apenas R$ 50,00 por dia!)
• *Caução facilitada* de R$ 500,00 (devolvida no encerramento do contrato).

📋 *Requisitos para Locação:*
1. CNH categoria A válida
2. Comprovante de residência atualizado
3. Pagamento da caução + 1ª semana na retirada do veículo

👉 *Deseja alugar ou enviar seus documentos?*
Digite *4* para falar com o atendente agora mesmo!
Digite *0* para voltar ao menu principal.`,

    jaSouCliente: `👤 *ÁREA DO CLIENTE — FACILITA MOTO*

Por favor, escolha uma das opções abaixo digitando o número correspondente:

*2.1* - 💳 Segunda via do PIX semanal (Mercado Pago)
*2.2* - 🛢️ Informações sobre Troca de Óleo / Manutenção
*2.3* - 🔓 Solicitar Desbloqueio da Moto
*2.4* - 💬 Falar com Suporte Humano
*0* - ↩️ Voltar ao menu principal`,

    pix: `💳 *SEGUNDA VIA PIX — FACILITA MOTO*

Todos os nossos pagamentos são emitidos de forma 100% oficial e automática pelo *Mercado Pago*, com liberação imediata no sistema.

🌐 *Acesse o portal do cliente para emitir seu PIX agora:*
https://moto-hub-aluguel-de-motos-jhnu.vercel.app

Ou digite seu *CPF* ou nome aqui, ou digite *4* para que nosso atendente envie a fatura diretamente para você!
Digite *0* para voltar ao menu.`,

    oleo: `🛢️ *INFORMAÇÕES SOBRE TROCA DE ÓLEO*

⚠️ *Atenção aos prazos para preservar o motor da sua moto:*
• A troca de óleo deve ser feita rigorosamente a cada *1.000 km rodados* (tolerância máxima de até 1.100 km).
• Utilize óleo homologado Honda (20W-50 Mineral ou 10W-30 conforme motor).
• Tire uma foto nítida do painel marcando o km e do frasco do óleo e envie aqui nesta conversa para registro na sua ficha!

Digite *0* para voltar ao menu.`,

    desbloqueio: `🔓 *SOLICITAÇÃO DE DESBLOQUEIO DE MOTO*

O desbloqueio automático via satélite Xtrack ocorre em até 5 minutos após a compensação do PIX no Mercado Pago.

Se você já realizou o pagamento e ainda não desbloqueou:
1. Envie o comprovante do PIX aqui nesta conversa.
2. Digite *4* para falar com o atendente e liberar imediatamente.
Digite *0* para voltar ao menu.`,

    emergenciaRoubo: `🚨🚨 *CANAL DE EMERGÊNCIA — ROUBO OU FURTO* 🚨🚨

1. *MANTENHA A CALMA* e coloque-se imediatamente em local seguro. A sua vida é a prioridade número 1!
2. Todas as nossas motos possuem rastreador satelital *Xtrack* com bloqueio remoto imediato.
3. *Por favor, envie imediatamente aqui:*
   • Seu Nome Completo
   • Placa ou modelo da moto
   • Local / Bairro aproximado onde ocorreu o fato

⚠️ *Nossa central de monitoramento foi acionada com prioridade máxima e o veículo está sendo localizado agora!*`,

    foraDoHorario: `🕒 *ATENDIMENTO COM ATENDENTE HUMANO*

Nosso horário de atendimento humanizado é:
🗓️ *Segunda a Sábado: das 10h00 às 18h00*.
🚫 Domingos e feriados: Plantão exclusivo para emergências.

No momento estamos fora do horário de expediente. Deixe sua mensagem e dúvida detalhada aqui, e responderemos assim que abrirmos às 10h!

*(Se for ocorrência de roubo/furto, digite 3 para emergência imediata).*`
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

                // Pré-valida o JID do WhatsApp do Henrique
                getValidatedJid(HENRIQUE_RAW_PHONE).then(jid => {
                    henriqueJidCache = jid;
                    console.log(`📱 [WhatsApp Bot] Telefone de Alerta do Henrique mapeado: ${henriqueJidCache}`);
                }).catch(e => console.warn('Erro ao mapear JID do Henrique:', e));
            }
        });

        // =========================================================================
        // MOTOR DE MENSAGENS RECEBIDAS (CHATBOT URA + ATENDIMENTO HUMANO RELAY)
        // =========================================================================
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                if (!msg.message) continue;

                const remoteJid = msg.key.remoteJid;
                // Ignora grupos, status e mensagens de broadcast
                if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') continue;

                // Extrai o texto da mensagem
                const textoOriginal = msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    msg.message.imageMessage?.caption ||
                    msg.message.videoMessage?.caption ||
                    '';

                const texto = textoOriginal.trim();
                const textoLower = texto.toLowerCase();
                const senderNumber = remoteJid.replace('@s.whatsapp.net', '');
                const pushName = msg.pushName || 'Cliente';

                // =================================================================
                // 1. MENSAGEM ENVIADA PELO PRÓPRIO ROBÔ / APARELHO FACILITA MOTO
                // =================================================================
                if (msg.key.fromMe) {
                    // Se o Henrique digitou diretamente no celular da Facilita para um cliente,
                    // ativa o modo Atendimento Humano para não enviar o menu robô em cima da conversa dele
                    if (!remoteJid.includes(HENRIQUE_RAW_PHONE) && !remoteJid.includes('5186551068')) {
                        const sessao = clientSessions.get(remoteJid) || {};
                        sessao.mode = 'HUMAN_SUPPORT';
                        sessao.lastActive = Date.now();
                        clientSessions.set(remoteJid, sessao);
                    }
                    continue;
                }

                // =================================================================
                // 2. MENSAGEM RECEBIDA DO TELEFONE PARTICULAR DO HENRIQUE (RELAY)
                // =================================================================
                const isHenrique = remoteJid === henriqueJidCache ||
                    remoteJid.includes('51986551068') ||
                    remoteJid.includes('5186551068');

                if (isHenrique) {
                    console.log(`💬 [Mensagem do Henrique]: "${texto}" | Cliente Alvo Ativo: ${activeRelayClientJid}`);

                    // Comandos de controle do Henrique
                    if (textoLower === '#sair' || textoLower === '#fechar' || textoLower === '#encerrar') {
                        if (activeRelayClientJid) {
                            await enviarMensagem(activeRelayClientJid, `✅ *Atendimento Finalizado!*\nObrigado por falar com a Facilita Moto. Se precisar de mais informações, basta enviar qualquer mensagem para abrir o menu.`);
                            const sessao = clientSessions.get(activeRelayClientJid);
                            if (sessao) sessao.mode = 'MENU';
                            await enviarMensagem(remoteJid, `👍 Atendimento com o cliente encerrado com sucesso. O robô automático voltou a responder por lá.`);
                            activeRelayClientJid = null;
                        } else {
                            await enviarMensagem(remoteJid, `Nenhum cliente em atendimento ativo no momento.`);
                        }
                        continue;
                    }

                    if (textoLower === '#status') {
                        const statusMsg = activeRelayClientJid
                            ? `👤 Cliente em atendimento ativo: ${activeRelayClientJid.replace('@s.whatsapp.net', '')}\nDigite sua mensagem normalmente para responder a ele ou #sair para finalizar.`
                            : `Nenhum cliente em atendimento humano ativo no momento. Quando alguém chamar, você será notificado aqui!`;
                        await enviarMensagem(remoteJid, statusMsg);
                        continue;
                    }

                    if (textoLower === '#ajuda') {
                        await enviarMensagem(remoteJid, `🛠️ *COMANDOS DISPONÍVEIS:*
• Qualquer texto normal: Envia direto para o cliente ativo.
• *#sair*: Encerra o atendimento humano e reativa o robô para o cliente.
• *#status*: Mostra quem está conectado com você agora.`);
                        continue;
                    }

                    // Se Henrique enviou uma mensagem comum e tem cliente ativo, REPÁSSA PARA O CLIENTE
                    if (activeRelayClientJid) {
                        const entregue = await enviarMensagem(activeRelayClientJid, texto);
                        if (entregue) {
                            // Confirmação sutil para o Henrique
                            console.log(`🚀 [Relay] Mensagem de Henrique entregue para ${activeRelayClientJid}: "${texto}"`);
                        } else {
                            await enviarMensagem(remoteJid, `❌ Não foi possível entregar para o cliente. Tente novamente.`);
                        }
                    } else {
                        await enviarMensagem(remoteJid, `Olá Henrique! Você não possui nenhum cliente em atendimento ativo no momento. Digite *#ajuda* para ver os comandos.`);
                    }
                    continue;
                }

                // =================================================================
                // 3. MENSAGEM RECEBIDA DE UM CLIENTE
                // =================================================================
                let sessao = clientSessions.get(remoteJid) || { mode: 'MENU', lastActive: Date.now() };

                // Se o cliente já está em atendimento humano
                if (sessao.mode === 'HUMAN_SUPPORT') {
                    // Cliente quer sair do atendimento humano
                    if (textoLower === 'sair' || textoLower === '#sair' || textoLower === 'menu' || textoLower === 'voltar') {
                        sessao.mode = 'MENU';
                        clientSessions.set(remoteJid, sessao);
                        if (activeRelayClientJid === remoteJid) activeRelayClientJid = null;
                        await enviarMensagem(remoteJid, MENUS.principal);

                        const hJid = henriqueJidCache || await getValidatedJid(HENRIQUE_RAW_PHONE);
                        if (hJid) {
                            await enviarMensagem(hJid, `ℹ️ O cliente ${pushName} (${senderNumber}) encerrou o atendimento humano e voltou ao menu principal.`);
                        }
                        continue;
                    }

                    // Repassa a mensagem do cliente para o WhatsApp do Henrique
                    activeRelayClientJid = remoteJid;
                    const hJid = henriqueJidCache || await getValidatedJid(HENRIQUE_RAW_PHONE);
                    if (hJid) {
                        const alertaCliente = `📩 *[Cliente ${pushName} - ${senderNumber}]:*
"${textoOriginal || '[Mídia ou Áudio]'}"

👉 *Basta responder esta mensagem para falar com ele!*
*(Digite #sair para finalizar).*`;
                        await enviarMensagem(hJid, alertaCliente);
                    }
                    continue;
                }

                // =================================================================
                // 4. CHATBOT / URA INTERATIVA DE OPÇÕES
                // =================================================================
                sessao.lastActive = Date.now();
                clientSessions.set(remoteJid, sessao);

                // Opção 1: Motos Disponíveis
                if (texto === '1' || textoLower.includes('motos') || textoLower.includes('disponivel') || textoLower.includes('disponíveis') || textoLower.includes('aluguel') || textoLower.includes('valor')) {
                    await enviarMensagem(remoteJid, MENUS.motos);
                    continue;
                }

                // Opção 2: Já sou cliente
                if (texto === '2' || textoLower.includes('sou cliente')) {
                    await enviarMensagem(remoteJid, MENUS.jaSouCliente);
                    continue;
                }

                // Opção 2.1: PIX
                if (texto === '2.1' || textoLower === 'pix' || textoLower.includes('segunda via') || textoLower.includes('2a via')) {
                    await enviarMensagem(remoteJid, MENUS.pix);
                    continue;
                }

                // Opção 2.2: Troca de óleo
                if (texto === '2.2' || textoLower.includes('oleo') || textoLower.includes('óleo') || textoLower.includes('troca')) {
                    await enviarMensagem(remoteJid, MENUS.oleo);
                    continue;
                }

                // Opção 2.3: Desbloqueio
                if (texto === '2.3' || textoLower.includes('desbloqueio') || textoLower.includes('desbloquear')) {
                    await enviarMensagem(remoteJid, MENUS.desbloqueio);
                    continue;
                }

                // Opção 2.4 ou Opção 4: Falar com Atendente
                if (texto === '4' || texto === '2.4' || textoLower.includes('atendente') || textoLower.includes('falar') || textoLower.includes('humano')) {
                    const aberto = isAtendimentoHumanoDisponivel();

                    if (!aberto) {
                        await enviarMensagem(remoteJid, MENUS.foraDoHorario);
                    } else {
                        // Ativa modo humano
                        sessao.mode = 'HUMAN_SUPPORT';
                        clientSessions.set(remoteJid, sessao);
                        activeRelayClientJid = remoteJid;

                        const msgConfirmacaoCliente = `🧑‍💼 *ATENDIMENTO HUMANO — FACILITA MOTO*

Olá ${pushName}! Você foi transferido para nossa equipe de atendimento.
O Henrique já foi notificado no celular particular e vai te responder diretamente por aqui em instantes!

Pode ir digitando sua mensagem, áudio ou dúvida enquanto isso. 👇
*(Para cancelar e voltar ao menu automático a qualquer momento, digite "sair").*`;

                        await enviarMensagem(remoteJid, msgConfirmacaoCliente);

                        // Notifica o Henrique no WhatsApp particular
                        const hJid = henriqueJidCache || await getValidatedJid(HENRIQUE_RAW_PHONE);
                        if (hJid) {
                            const horaSP = getSaoPauloDate().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                            const notificacaoHenrique = `🛎️ *NOVA SOLICITAÇÃO DE ATENDIMENTO HUMANO* 🛎️
👤 *Cliente:* ${pushName}
📱 *Telefone:* ${senderNumber}
⏰ *Horário:* ${horaSP}

💬 *Você pode responder diretamente aqui no seu WhatsApp particular e sua resposta será enviada ao cliente pelo número da Facilita Moto!*
Para encerrar depois, basta digitar *#sair*.`;
                            await enviarMensagem(hJid, notificacaoHenrique);
                        }
                    }
                    continue;
                }

                // Opção 3: Roubo ou Furto (URGÊNCIA)
                if (texto === '3' || textoLower.includes('roubo') || textoLower.includes('furto') || textoLower.includes('emergencia') || textoLower.includes('emergência') || textoLower.includes('socorro')) {
                    await enviarMensagem(remoteJid, MENUS.emergenciaRoubo);

                    // Alerta sonoro / de prioridade máxima no WhatsApp do Henrique
                    const hJid = henriqueJidCache || await getValidatedJid(HENRIQUE_RAW_PHONE);
                    if (hJid) {
                        const horaSP = getSaoPauloDate().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                        const alertaMaximo = `🚨🚨🚨 *ALERTA MÁXIMO: COMUNICADO DE ROUBO/FURTO* 🚨🚨🚨
👤 *Cliente:* ${pushName}
📱 *Número:* ${senderNumber}
⏰ *Hora:* ${horaSP}
💬 *Mensagem do condutor:* "${textoOriginal || 'Acionou opção de Roubo/Furto'}"

👉 *Ação Imediata:*
1. Abra o aplicativo da *Xtrack* e efetue o bloqueio satelital imediato do veículo!
2. Chamar o cliente: https://wa.me/${senderNumber}`;
                        await enviarMensagem(hJid, alertaMaximo);
                    }
                    continue;
                }

                // Opção 0 ou Voltar
                if (texto === '0' || textoLower === 'menu' || textoLower === 'voltar' || textoLower === 'inicio' || textoLower === 'início') {
                    await enviarMensagem(remoteJid, MENUS.principal);
                    continue;
                }

                // Qualquer outra mensagem: Apresenta o Menu Principal
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
        activeRelayClient: activeRelayClientJid ? activeRelayClientJid.replace('@s.whatsapp.net', '') : null,
        totalSessions: clientSessions.size,
        horarioAtendimentoDisponivel: isAtendimentoHumanoDisponivel(),
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Endpoint de Ping para manter o servidor acordado no Render
app.get('/ping', (req, res) => {
    res.json({
        ok: true,
        service: 'facilita-whatsapp-bot',
        connected: isConnected,
        timestamp: new Date().toISOString()
    });
});

// Painel Visual para Escanear o QR Code e Monitorar o Robô
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
        .feature-box { background: #0f172a; border-radius: 10px; padding: 14px; text-align: left; font-size: 0.85rem; color: #cbd5e1; margin-bottom: 16px; border-left: 4px solid #38bdf8; }
        .btn-refresh { background: #2563eb; color: #fff; border: none; padding: 10px 20px; border-radius: 8px; font-weight: 600; cursor: pointer; transition: 0.2s; font-size: 0.85rem; }
        .btn-refresh:hover { background: #1d4ed8; }
    </style>
</head>
<body>
    <div class="card">
        <div class="logo">
            <i class="fa-solid fa-motorcycle"></i> FACILITA MOTO
        </div>
        <p class="subtitle">Robô URA Inteligente & Ponte de Atendimento Humano</p>

        <div id="status-container">
            ${isConnected ? `
                <div class="status-badge status-connected">
                    <i class="fa-solid fa-circle-check"></i> ONLINE (${connectedPhone})
                </div>
                <div style="background:#064e3b; border:1px solid #059669; border-radius:12px; padding:20px 16px; margin-bottom:20px; text-align:left;">
                    <strong style="font-size:1rem; color:#ecfdf5; display:block; margin-bottom:8px;">
                        <i class="fa-solid fa-robot"></i> Recursos Ativos no Robô:
                    </strong>
                    <ul style="font-size:0.85rem; color:#a7f3d0; padding-left:20px; line-height:1.6;">
                        <li><strong>Menu Interativo:</strong> Motos, Área do Cliente, PIX e Roubo/Furto</li>
                        <li><strong>Atendimento Humano:</strong> Seg a Sáb das 10h às 18h (Hora atual: ${spTime})</li>
                        <li><strong>Ponte Celular:</strong> Henrique responde no <code>51 98655-1068</code> e entrega no WhatsApp da Facilita!</li>
                        <li><strong>Status Atendimento:</strong> ${atendimentoAberto ? '<span style="color:#4ade80;">ABERTO (Disponível)</span>' : '<span style="color:#f87171;">FECHADO (Fora do Horário)</span>'}</li>
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

// Endpoint Principal de Disparo de Mensagens (/send-message) do CRM MotoHub
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
