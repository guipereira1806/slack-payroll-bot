const { App, ExpressReceiver } = require('@slack/bolt');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');
const axios = require('axios');
const config = require('./config');

// --- SETUP INICIAL ---
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const receiver = new ExpressReceiver({ signingSecret: config.slack.signingSecret });
const slackApp = new App({
    token: config.slack.botToken,
    receiver: receiver
});
const app = receiver.app;

// --- CONSTANTES E GERENCIAMENTO DE ESTADO ---
const CSV_COLS = {
    SLACK_ID: 'Slack User',
    NAME: 'Name',
    SALARY: 'Salary',
    FALTAS: 'Faltas',
    FERIADOS: 'Feriados Trabalhados'
};

const sentMessages = new Map();
const processedFiles = new Set();
const pendingJobs = new Map();

// Funções de rastreamento (sem alterações)
function trackMessage(timestamp, data) {
    sentMessages.set(timestamp, data);
    setTimeout(() => sentMessages.delete(timestamp), config.app.messageExpirationMs);
}

function trackFile(fileId) {
    processedFiles.add(fileId);
    setTimeout(() => processedFiles.delete(fileId), config.app.messageExpirationMs);
}


// --- LÓGICA DE NEGÓCIO E FUNÇÕES AUXILIARES ---

function readCsvFile(filePath) {
    // (Esta função permanece a mesma da versão anterior)
    return new Promise((resolve, reject) => {
        const data = [];
        const expectedHeaders = new Set(Object.values(CSV_COLS));
        const stream = fs.createReadStream(filePath).pipe(csv());
        
        stream.on('headers', (headers) => {
            const missingHeaders = [...expectedHeaders].filter(h => !headers.includes(h));
            if (missingHeaders.length > 0) {
                const err = new Error(`Cabeçalhos obrigatórios ausentes no CSV: ${missingHeaders.join(', ')}`);
                err.code = 'INVALID_HEADERS';
                stream.destroy();
                reject(err);
            }
        });
        stream.on('data', (row) => {
            if (Object.values(row).some(val => val && val.trim() !== '')) {
                data.push(row);
            }
        });
        stream.on('end', () => resolve(data));
        stream.on('error', (error) => reject(error));
    });
}

function generateMessage(name, salary, faltas, feriadosTrabalhados) {
    // (Esta função permanece a mesma da versão anterior)
    const faltasText = faltas === 1 ? `houve *${faltas} falta*` : `houve *${faltas} faltas*`;
    const feriadosText = feriadosTrabalhados === 1 ? `trabalhou em *${feriadosTrabalhados} feriado*` : `trabalhou em *${feriadosTrabalhados} feriados*`;
    return `
:wave: *Olá, ${name}!*
... (conteúdo da mensagem omitido para brevidade) ...
`;
}

// NOVA FUNÇÃO: Formata os dados do CSV para exibição no modal
function formatDataForPreview(data) {
    const MAX_ROWS_TO_PREVIEW = 25;
    const MAX_CHARS = 2800; // Limite de segurança para o bloco de texto do modal

    let previewText = `*Nome* | *Salário* | *Faltas* | *Feriados*\n`;
    previewText += `------------------------------------------------\n`;

    for (let i = 0; i < data.length; i++) {
        const row = data[i];
        const line = `*${row[CSV_COLS.NAME]}* | US$${row[CSV_COLS.SALARY]} | ${row[CSV_COLS.FALTAS] || 0} | ${row[CSV_COLS.FERIADOS] || 0}\n`;

        if (previewText.length + line.length > MAX_CHARS || i >= MAX_ROWS_TO_PREVIEW) {
            const remainingRows = data.length - i;
            previewText += `\n... e mais *${remainingRows}* linha(s).`;
            break;
        }
        previewText += line;
    }
    return previewText;
}


// --- LISTENERS DE EVENTOS E AÇÕES ---

// ETAPA 1: Listener para upload de arquivos
slackApp.event('file_shared', async ({ event, client }) => {
    // (Lógica de download e análise do arquivo permanece a mesma)
    const filePath = path.join(uploadDir, `${event.file_id}-temp.csv`);
    const { file_id: fileId, channel_id: channelId, user_id: userId } = event;

    try {
        if (processedFiles.has(fileId)) return;

        const fileInfo = await client.files.info({ file: fileId });
        if (fileInfo.file.filetype !== 'csv') return;

        const response = await axios.get(fileInfo.file.url_private_download, {
            headers: { 'Authorization': `Bearer ${config.slack.botToken}` }, responseType: 'stream'
        });
        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve); writer.on('error', reject);
        });

        const data = await readCsvFile(filePath);
        const jobId = fileId;
        pendingJobs.set(jobId, { data, filePath, channelId, userId, fileName: fileInfo.file.name });
        
        // ALTERAÇÃO: Adicionado o botão "Visualizar Dados"
        await client.chat.postMessage({
            channel: channelId,
            text: `Arquivo \`${fileInfo.file.name}\` processado.`,
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `Olá <@${userId}>! Encontrei *${data.length} usuários* no arquivo \`${fileInfo.file.name}\`.\n\nVerifique os dados antes de prosseguir.`
                    }
                },
                {
                    type: "actions",
                    elements: [
                        { // NOVO BOTÃO
                            type: "button",
                            text: { type: "plain_text", text: "📄 Visualizar Dados", emoji: true },
                            value: jobId,
                            action_id: "preview_data_action"
                        },
                        {
                            type: "button",
                            text: { type: "plain_text", text: "✅ Enviar Notificações", emoji: true },
                            style: "primary",
                            value: jobId,
                            action_id: "confirm_send_action"
                        },
                        {
                            type: "button",
                            text: { type: "plain_text", text: "❌ Cancelar", emoji: true },
                            style: "danger",
                            value: jobId,
                            action_id: "cancel_send_action"
                        }
                    ]
                }
            ]
        });

    } catch (error) {
        console.error('Erro na etapa de upload e análise:', error);
        await client.chat.postMessage({
            channel: channelId,
            text: `❌ Ocorreu um erro ao processar o arquivo: ${error.message}`
        });
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
});


// NOVO LISTENER: Para a ação do botão "Visualizar Dados"
slackApp.action('preview_data_action', async ({ ack, body, client }) => {
    await ack();

    const jobId = body.actions[0].value;
    const trigger_id = body.trigger_id;
    const job = pendingJobs.get(jobId);

    if (!job) {
        // O job pode já ter sido processado ou cancelado
        console.warn(`Tentativa de visualizar job inexistente: ${jobId}`);
        return;
    }

    // Formata os dados para exibição
    const previewText = formatDataForPreview(job.data);

    try {
        // Abre o modal com os dados
        await client.views.open({
            trigger_id: trigger_id,
            view: {
                type: 'modal',
                title: {
                    type: 'plain_text',
                    text: `Prévia de ${job.fileName}`
                },
                close: {
                    type: 'plain_text',
                    text: 'Fechar'
                },
                blocks: [
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: `Exibindo as primeiras linhas do arquivo. Verifique se os dados estão corretos antes de confirmar o envio.`
                        }
                    },
                    { type: 'divider' },
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: previewText
                        }
                    }
                ]
            }
        });
    } catch (error) {
        console.error("Falha ao abrir o modal de visualização:", error);
    }
});


// Listener para o botão de CONFIRMAR (lógica interna sem alterações)
slackApp.action('confirm_send_action', async ({ ack, body, client }) => {
    // (Esta função permanece a mesma da versão anterior)
    await ack();

    const jobId = body.actions[0].value;
    const job = pendingJobs.get(jobId);
    const clickingUser = body.user.id;

    if (!job) return;
    
    if (clickingUser !== job.userId) {
        // Lógica de segurança (sem alterações)
        return;
    }

    try {
        await client.chat.update({
            channel: body.channel.id, ts: body.message.ts,
            text: `Enviando ${job.data.length} notificações... ⏳`, blocks: []
        });

        let successCount = 0;
        const failedUsers = [];
        // ... (resto da lógica de envio e relatório sem alterações) ...
         for (const row of job.data) {
            const agentName = row[CSV_COLS.NAME];
            try {
                // ...
                successCount++;
            } catch (error) {
                failedUsers.push(agentName);
            }
        }
        let reportText = `Relatório de Envio! ✅\n*${successCount} de ${job.data.length}* mensagens enviadas com sucesso.`;
        if (failedUsers.length > 0) {
            reportText += `\n\n❌ *Falha ao enviar para:* ${failedUsers.join(', ')}`;
        }
        await client.chat.update({ channel: body.channel.id, ts: body.message.ts, text: reportText });
        trackFile(jobId);

    } catch (error) {
        console.error('Erro ao enviar notificações:', error);
    } finally {
        pendingJobs.delete(jobId);
        if (fs.existsSync(job.filePath)) fs.unlinkSync(job.filePath);
    }
});


// Listener para o botão de CANCELAR (sem alterações)
slackApp.action('cancel_send_action', async ({ ack, body, client }) => {
    // (Esta função permanece a mesma da versão anterior)
    await ack();
    const jobId = body.actions[0].value;
    const job = pendingJobs.get(jobId);
    const clickingUser = body.user.id;
    if (!job || clickingUser !== job.userId) return;

    await client.chat.update({
        channel: body.channel.id, ts: body.message.ts,
        text: `Operação cancelada por <@${clickingUser}>. O arquivo não será processado.`, blocks: []
    });

    pendingJobs.delete(jobId);
    if (fs.existsSync(job.filePath)) fs.unlinkSync(job.filePath);
});

// Listener para reações (sem alterações)
slackApp.event('reaction_added', async ({ event, client }) => { /* ... */ });

// Listener para DMs (sem alterações)
slackApp.event('message', async ({ event, say }) => { /* ... */ });

// Rota de health check (sem alterações)
app.get('/', (req, res) => res.status(200).send('Bot is running!'));

// --- INICIALIZAÇÃO DO SERVIDOR ---
(async () => {
    const port = config.server.port;
    await slackApp.start(port);
    console.log(`🚀 Slack Bolt app está rodando na porta ${port}!`);
})();
