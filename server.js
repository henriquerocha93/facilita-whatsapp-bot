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

// Armazenamento de Sessões, Emergências e Leads
const clientSessions = new Map();
let activeRelayClientJid = null;
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
*6* - 💬 Falar com Atendente Humano (10h às 18h)`,

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

⚠️ *A nossa central e o Henrique já foram acionados com sirene de alerta máximo para bloqueio e localização satelital agora mesmo!*`,

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

                getValidatedJid(HENRIQUE_RAW_PHONE).then(jid => {
                    henriqueJidCache = jid;
                    console.log(`📱 [WhatsApp Bot] Telefone do Henrique: ${henriqueJidCache}`);
                }).catch(e => console.warn('Erro ao mapear JID do Henrique:', e));
            }
        });

        // PROCESSAMENTO DE MENSAGENS RECEBIDAS
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
                // Se o identificador for o LID do celular do Henrique, mapeia para o telefone real
                if (remoteJid.includes('107941151653891') || senderNumber === '107941151653891') {
                    senderNumber = HENRIQUE_RAW_PHONE;
                }
                const pushName = msg.pushName || 'Cliente';

                // 1. Mensagem enviada pelo próprio aparelho da Facilita Moto
                if (msg.key.fromMe) {
                    if (!remoteJid.includes(HENRIQUE_RAW_PHONE) && !remoteJid.includes('5186551068')) {
                        const sessao = clientSessions.get(remoteJid) || {};
                        sessao.mode = 'HUMAN_SUPPORT';
                        sessao.lastActive = Date.now();
                        clientSessions.set(remoteJid, sessao);
                    }
                    continue;
                }

                // 2. Mensagem do WhatsApp particular do Henrique (Ponte Relay / Comandos)
                const isHenrique = remoteJid === henriqueJidCache ||
                    remoteJid.includes('107941151653891') ||
                    remoteJid.includes('51986551068') ||
                    remoteJid.includes('5186551068');

                if (isHenrique) {
                    console.log(`💬 [Mensagem do Henrique]: "${texto}" | Alvo Ativo: ${activeRelayClientJid}`);

                    if (textoLower === '#sair' || textoLower === '#fechar' || textoLower === '#encerrar') {
                        if (activeRelayClientJid) {
                            await enviarMensagem(activeRelayClientJid, `✅ *Atendimento Finalizado!*\nObrigado por falar com a Facilita Moto. Se precisar de mais informações, envie qualquer mensagem para abrir o menu.`);
                            const sessao = clientSessions.get(activeRelayClientJid);
                            if (sessao) sessao.mode = 'MENU';
                            await enviarMensagem(remoteJid, `👍 Atendimento encerrado. O robô voltou a responder o cliente.`);
                            activeRelayClientJid = null;
                        } else {
                            await enviarMensagem(remoteJid, `Nenhum cliente em atendimento ativo.`);
                        }
                        continue;
                    }

                    if (textoLower === '#status') {
                        const statusMsg = activeRelayClientJid
                            ? `👤 Cliente em atendimento ativo: ${activeRelayClientJid.replace('@s.whatsapp.net', '')}\nDigite qualquer mensagem normal para responder a ele ou #sair para finalizar.`
                            : `Nenhum cliente em atendimento ativo no momento. Total de leads na fila: ${leadsFilaDeEspera.length}`;
                        await enviarMensagem(remoteJid, statusMsg);
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
                        await enviarMensagem(remoteJid, `🛠️ *COMANDOS:*
• Mensagem normal (quando em atendimento): Envia direto para o cliente ativo.
• *#sair*: Encerra o atendimento humano e religa o robô.
• *#status*: Mostra o cliente ativo atual.
• *#leads*: Lista os clientes na fila de espera.`);
                        continue;
                    }

                    // Se estiver em modo de teste simulado
                    if (activeRelayClientJid === 'SIMULATED_TEST_CLIENT') {
                        await enviarMensagem(remoteJid, `🚀 *[RESPOSTA ENTREGUE AO CONDUTOR!]*
O robô da Facilita Moto \`(51) 8142-9980\` entregou a sua resposta para o condutor:
"${texto}"

✅ *Ponte de Atendimento funcionando 100%!*
(Em uma ocorrência real com outro aparelho, o condutor recebe exatamente este texto no WhatsApp dele enviado pelo número da Facilita).
Digite *#sair* para encerrar a simulação.`);
                        continue;
                    }

                    // Se Henrique está em atendimento ativo com um cliente externo, encaminha a mensagem
                    if (activeRelayClientJid && activeRelayClientJid !== remoteJid) {
                        const entregue = await enviarMensagem(activeRelayClientJid, texto);
                        if (entregue) {
                            console.log(`🚀 [Relay] Mensagem de Henrique entregue para ${activeRelayClientJid}`);
                        } else {
                            await enviarMensagem(remoteJid, `❌ Não foi possível entregar para o cliente.`);
                        }
                        continue;
                    }

                    // Se Henrique NÃO está atendendo cliente e digitou texto normal (sem #), permite que ele teste o bot!
                }

                // 3. Mensagem de um Cliente
                let sessao = clientSessions.get(remoteJid) || { mode: 'MENU', lastActive: Date.now() };

                // Se o cliente estiver em Atendimento Humano
                if (sessao.mode === 'HUMAN_SUPPORT') {
                    if (textoLower === 'sair' || textoLower === '#sair' || textoLower === 'menu' || textoLower === 'voltar') {
                        sessao.mode = 'MENU';
                        clientSessions.set(remoteJid, sessao);
                        if (activeRelayClientJid === remoteJid) activeRelayClientJid = null;
                        await enviarMensagem(remoteJid, MENUS.principal);

                        const hJid = henriqueJidCache || await getValidatedJid(HENRIQUE_RAW_PHONE);
                        if (hJid) {
                            await enviarMensagem(hJid, `ℹ️ O cliente ${pushName} (${senderNumber}) encerrou o atendimento humano e voltou ao menu.`);
                        }
                        continue;
                    }

                    activeRelayClientJid = remoteJid;
                    const hJid = henriqueJidCache || await getValidatedJid(HENRIQUE_RAW_PHONE);
                    if (hJid) {
                        const alertaCliente = `📩 *[Cliente ${pushName} - ${senderNumber}]:*
"${textoOriginal || '[Mídia ou Áudio]'}"

👉 *Responda aqui para falar com ele pelo WhatsApp da Facilita!*
*(Para finalizar digite #sair).*`;
                        await enviarMensagem(hJid, alertaCliente);
                    }
                    continue;
                }

                // Se o cliente estiver enviando dados para a FILA DE ESPERA (Novo Lead)
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
                    const novoLead = {
                        id: `LEAD-${Date.now()}`,
                        nome: pushName,
                        telefone: senderNumber,
                        dados: textoOriginal || 'Enviou documento/foto',
                        hora: horaSP,
                        timestamp: Date.now()
                    };
                    leadsFilaDeEspera.unshift(novoLead);
                    if (leadsFilaDeEspera.length > 50) leadsFilaDeEspera.pop();

                    // Responde o cliente confirmando a entrada na fila
                    const respCliente = `✅ *CADASTRO REALIZADO NA FILA DE ESPERA!* 🏍️📋

Muito obrigado, *${pushName}*! Seus dados foram cadastrados com sucesso em nossa Fila de Espera prioritária.

Assim que uma moto for liberada para locação, entraremos em contato direto com você por aqui!

*(Lembrando que os requisitos para retirada são: R$ 700,00 de entrada [caução + 1ª semana], CNH A, comprovante de residência e 1 testemunha no contrato).*

Digite *0* para voltar ao menu principal.`;
                    await enviarMensagem(remoteJid, respCliente);

                    // Notifica imediatamente o Henrique no WhatsApp particular como NOVO LEAD
                    const hJid = henriqueJidCache || await getValidatedJid(HENRIQUE_RAW_PHONE);
                    if (hJid) {
                        const phoneWaMe = formatarParaWaMe(senderNumber);
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

                // Se o cliente estava aguardando envio de Nome/CPF/Placa para o PIX
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
                // URA SEQUENCIAL 1, 2, 3, 4, 5, 6
                // =============================================================
                sessao.lastActive = Date.now();
                clientSessions.set(remoteJid, sessao);

                // Opção 1: Motos Disponíveis (Informa que estão todas locadas e coloca em modo de espera)
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
                    await enviarMensagem(remoteJid, MENUS.emergenciaRoubo);

                    const horaSP = getSaoPauloDate().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                    const isSenderAdmin = remoteJid.includes(HENRIQUE_RAW_PHONE) ||
                        remoteJid.includes('5186551068') ||
                        remoteJid.includes('107941151653891');

                    if (isSenderAdmin) {
                        // TESTE REALIZADO PELO PRÓPRIO CELULAR DO HENRIQUE
                        activeRelayClientJid = 'SIMULATED_TEST_CLIENT';

                        const alertObj = {
                            id: `EMERGENCY-${Date.now()}`,
                            clienteNome: 'João da Silva (Simulação Admin)',
                            clienteTelefone: '5551999998888',
                            mensagem: 'Simulação de Roubo/Furto acionada pelo Administrador para teste de alarme e sirene',
                            hora: horaSP,
                            timestamp: Date.now()
                        };
                        activeEmergencies.unshift(alertObj);
                        if (activeEmergencies.length > 20) activeEmergencies.pop();

                        const hJid = henriqueJidCache || await getValidatedJid(HENRIQUE_RAW_PHONE);
                        if (hJid) {
                            const alertaSimulacao = `🚨🚨🚨 *SIMULAÇÃO DE ROUBO/FURTO (MODO TESTE)* 🚨🚨🚨
👤 *Condutor Simulado:* João da Silva
📱 *Telefone do Condutor:* (51) 99999-8888
⏰ *Hora:* ${horaSP}
💬 *Mensagem:* "Roubaram minha moto na Av. Assis Brasil"

ℹ️ *POR QUE O LOOP ACONTECEU ANTES?*
Como você disparou o teste do seu próprio WhatsApp particular (*51 98655-1068*), o robô achou que o "condutor roubado" era você mesmo e mandou o link do seu próprio número!

👉 *COMO FUNCIONA NA VIDA REAL COM UM CLIENTE:*
• O link que chega aqui é o do cliente: https://wa.me/5551999998888
• E quando você responde a esta mensagem aqui, sua resposta é entregue para o condutor através do WhatsApp oficial da Facilita \`(51) 8142-9980\`!

👉 *TESTE A RESPOSTA AGORA:* Digite qualquer resposta aqui (ex: *"Estamos localizando pelo rastreador"*) e veja a confirmação de entrega pelo robô!`;
                            await enviarMensagem(hJid, alertaSimulacao);
                        }
                    } else {
                        // CLIENTE REAL (QUALQUER OUTRO CELULAR)
                        sessao.mode = 'HUMAN_SUPPORT';
                        clientSessions.set(remoteJid, sessao);
                        activeRelayClientJid = remoteJid;

                        const phoneWaMe = formatarParaWaMe(senderNumber);

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

                        const hJid = henriqueJidCache || await getValidatedJid(HENRIQUE_RAW_PHONE);
                        if (hJid) {
                            const alertaMaximo = `🚨🚨🚨 *ALERTA MÁXIMO: COMUNICADO DE ROUBO/FURTO* 🚨🚨🚨
👤 *Cliente:* ${pushName}
📱 *Número:* ${phoneWaMe}
⏰ *Hora:* ${horaSP}
💬 *Mensagem do condutor:* "${textoOriginal || 'Acionou opção de Roubo/Furto'}"

👉 *OPÇÃO 1 — CLIQUE PARA FALAR COM O CLIENTE NO WHATSAPP:*
https://wa.me/${phoneWaMe}

👉 *OPÇÃO 2 — RESPONDA DIRETO AQUI:*
Basta responder esta mensagem que ela será enviada ao condutor pelo WhatsApp da Facilita!

⚠️ *Acesse o aplicativo da Xtrack para bloqueio e localização satelital do veículo!*`;
                            await enviarMensagem(hJid, alertaMaximo);
                        }
                    }
                    continue;
                }

                // Opção 6: Falar com Atendente Humano
                if (texto === '6' || textoLower.includes('atendente') || textoLower.includes('falar') || textoLower.includes('humano')) {
                    const aberto = isAtendimentoHumanoDisponivel();

                    if (!aberto) {
                        await enviarMensagem(remoteJid, MENUS.foraDoHorario);
                    } else {
                        const horaSP = getSaoPauloDate().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                        const isSenderAdmin = remoteJid.includes(HENRIQUE_RAW_PHONE) ||
                            remoteJid.includes('5186551068') ||
                            remoteJid.includes('107941151653891');

                        if (isSenderAdmin) {
                            activeRelayClientJid = 'SIMULATED_TEST_CLIENT';

                            const msgConfirmacaoCliente = `🧑‍💼 *ATENDIMENTO HUMANO — FACILITA MOTO (TESTE)*

Olá Henrique! O robô acionou a simulação de atendimento humano.
Responda qualquer mensagem para testar a ponte de envio pelo WhatsApp oficial da Facilita!`;
                            await enviarMensagem(remoteJid, msgConfirmacaoCliente);
                        } else {
                            sessao.mode = 'HUMAN_SUPPORT';
                            clientSessions.set(remoteJid, sessao);
                            activeRelayClientJid = remoteJid;

                            const msgConfirmacaoCliente = `🧑‍💼 *ATENDIMENTO HUMANO — FACILITA MOTO*

Olá ${pushName}! Você foi transferido para nossa equipe de atendimento.
O Henrique já foi notificado no celular particular e vai te responder diretamente por aqui em instantes!

Pode ir digitando sua mensagem ou dúvida enquanto isso. 👇
*(Para cancelar e voltar ao menu automático a qualquer momento, digite "sair").*`;

                            await enviarMensagem(remoteJid, msgConfirmacaoCliente);

                            const hJid = henriqueJidCache || await getValidatedJid(HENRIQUE_RAW_PHONE);
                            if (hJid) {
                                const phoneWaMe = formatarParaWaMe(senderNumber);
                                const notificacaoHenrique = `🛎️ *NOVA SOLICITAÇÃO DE ATENDIMENTO HUMANO* 🛎️
👤 *Cliente:* ${pushName}
📱 *Telefone:* ${phoneWaMe}
⏰ *Horário:* ${horaSP}

👉 *OPÇÃO 1 — CLIQUE PARA ABRIR O WHATSAPP DO CLIENTE:*
https://wa.me/${phoneWaMe}

👉 *OPÇÃO 2 — RESPONDA DIRETO AQUI:*
Você pode responder diretamente aqui no seu WhatsApp particular e sua resposta será enviada ao cliente pelo número da Facilita Moto!
(Para encerrar digite *#sair*).`;
                                await enviarMensagem(hJid, notificacaoHenrique);
                            }
                        }
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

                // Se o usuário digitou um CPF ou Placa direto sem escolher opção, gera o PIX automaticamente
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
        activeRelayClient: activeRelayClientJid ? activeRelayClientJid.replace('@s.whatsapp.net', '') : null,
        totalSessions: clientSessions.size,
        leadsCount: leadsFilaDeEspera.length,
        emergenciesCount: activeEmergencies.length,
        horarioAtendimentoDisponivel: isAtendimentoHumanoDisponivel(),
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
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
        <p class="subtitle">Robô URA Inteligente & Captação de Leads</p>

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
                        <li><strong>Motos 100% Locadas:</strong> Capta novos Leads na Fila de Espera</li>
                        <li><strong>Requisitos:</strong> R$ 700 entrada (R$ 350 caução + R$ 350 semana), CNH A, Comprovante e 1 Testemunha</li>
                        <li><strong>PIX Automático:</strong> Mercado Pago sem redirecionamento</li>
                        <li><strong>Alerta Sirene:</strong> Roubo/Furto integrado ao CRM</li>
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
