const { App, ExpressReceiver } = require('@slack/bolt');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');
const axios = require('axios');
const config = require('./config');

// --- SETUP INICIAL ---
const uploadDir = path.join(__dirname, 'uploads');
const jobsDir = path.join(__dirname, 'jobs'); // NOVO: Diretório para arquivos de estado
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(jobsDir)) fs.mkdirSync(jobsDir, { recursive: true });


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

const sentMessages = new Map(); // Rastreamento de DMs para reações (pode continuar em memória)

// REMOVIDO: A variável pendingJobs não é mais necessária, usaremos o sistema de arquivos.

// --- LÓGICA DE NEGÓCIO E FUNÇÕES AUXILIARES ---

function readCsvFile(filePath) {
    // (Esta função permanece a mesma)
    return new Promise((resolve, reject) => {
        const data = [];
        const expectedHeaders = new Set(Object.values(CSV_COLS));
        const stream = fs.createReadStream(filePath).pipe(csv());
        
        stream.on('headers', (headers) => {
            const missingHeaders = [...expectedHeaders].filter(h => !headers.includes(h));
            if (missingHeaders.length > 0) {
                const err = new Error(`Cabeçalhos obrigatórios ausentes: ${missingHeaders.join(', ')}`);
                err.code = 'INVALID_HEADERS';
                stream.destroy();
                reject(err);
            }
        });
        stream.on('data', (row) => {
            if (Object.values(row).some(val => val && val.trim() !== '')) data.push(row);
        });
        stream.on('end', () => resolve(data));
        stream.on('error', (error) => reject(error));
    });
}

function formatDataForPreview(data) {
    // (Esta função permanece a mesma)
    const MAX_ROWS_TO_PREVIEW = 25;
    let previewText = `*Nome* | *Salário* | *Faltas* | *Feriados*\n------------------------------------------------\n`;
    for (let i = 0; i < Math.min(data.length, MAX_ROWS_TO_PREVIEW); i++) {
        const row = data[i];
        previewText += `*${row[CSV_COLS.NAME]}* | US$${row[CSV_COLS.SALARY]} | ${row[CSV_COLS.FALTAS] || 0} | ${row[CSV_COLS.FERIADOS] || 0}\n`;
    }
    if (data.length > MAX_ROWS_TO_PREVIEW) {
        previewText += `\n... e mais *${data.length - MAX_ROWS_TO_PREVIEW}* linha(s).`;
    }
    return previewText;
}

// (generateMessage e outras funções auxiliares permanecem as mesmas)
function generateMessage(name, salary, faltas, feriadosTrabalhados) {
    const faltasText = faltas === 1 ? `houve *${faltas} falta*` : `houve *${faltas} faltas*`;
    const feriadosText = feriadosTrabalhados === 1 ? `trabalhou em *${feriadosTrabalhados} feriado*` : `trabalhou em *${feriadosTrabalhados} feriados*`;
    return `
:wave: *Olá, ${name}!*
... (conteúdo da mensagem omitido para brevidade) ...
`;
}


// --- LISTENERS DE EVENTOS E AÇÕES ---

// ETAPA 1: Listener para upload de arquivos
slackApp.event('file_shared', async ({ event, client }) => {
    const { file_id: fileId, channel_id: channelId, user_id: userId } = event;
    const csvFilePath = path.join(uploadDir, `${fileId}.csv`);
    const jobFilePath = path.join(jobsDir, `${fileId}.json`); // NOVO: Caminho para o arquivo de estado

    try {
        const fileInfo = await client.files.info({ file: fileId });
        if (fileInfo.file.filetype !== 'csv') return;

        // Download do arquivo
        const response = await axios.get(fileInfo.file.url_private_download, {
            headers: { 'Authorization': `Bearer ${config.slack.botToken}` }, responseType: 'stream'
        });
        const writer = fs.createWriteStream(csvFilePath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve); writer.on('error', reject);
        });

        // Lê e valida o CSV
        const data = await readCsvFile(csvFilePath);
        
        // CORREÇÃO: Salva os dados do job em um arquivo JSON em vez de na memória
        const jobData = { data, csvFilePath, channelId, userId, fileName: fileInfo.file.name };
        fs.writeFileSync(jobFilePath, JSON.stringify(jobData, null, 2));

        // Envia a mensagem com os botões
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
                         { type: "button", text: { type: "plain_text", text: "📄 Visualizar Dados", emoji: true }, value: fileId, action_id: "preview_data_action" },
                         { type: "button", text: { type: "plain_text", text: "✅ Enviar Notificações", emoji: true }, style: "primary", value: fileId, action_id: "confirm_send_action" },
                         { type: "button", text: { type: "plain_text", text: "❌ Cancelar", emoji: true }, style: "danger", value: fileId, action_id: "cancel_send_action" }
                    ]
                }
            ]
        });

    } catch (error) {
        console.error('Erro na etapa de upload e análise:', error);
        await client.chat.postMessage({ channel: channelId, text: `❌ Ocorreu um erro ao processar o arquivo: ${error.message}` });
        // Limpa os arquivos em caso de erro
        if (fs.existsSync(csvFilePath)) fs.unlinkSync(csvFilePath);
        if (fs.existsSync(jobFilePath)) fs.unlinkSync(jobFilePath);
    }
});

// Listener para o botão "Visualizar Dados"
slackApp.action('preview_data_action', async ({ ack, body, client }) => {
    await ack();
    const jobId = body.actions[0].value;
    const jobFilePath = path.join(jobsDir, `${jobId}.json`);

    try {
        // CORREÇÃO: Lê os dados do arquivo JSON
        if (!fs.existsSync(jobFilePath)) throw new Error("Job expirado ou não encontrado.");
        const job = JSON.parse(fs.readFileSync(jobFilePath, 'utf-8'));

        const previewText = formatDataForPreview(job.data);
        
        await client.views.open({
            trigger_id: body.trigger_id,
            view: {
                type: 'modal',
                title: { type: 'plain_text', text: 'Prévia do Arquivo' },
                close: { type: 'plain_text', text: 'Fechar' },
                blocks: [
                    { type: 'section', text: { type: 'mrkdwn', text: `Exibindo as primeiras linhas do arquivo *${job.fileName}*.` } },
                    { type: 'divider' },
                    { type: 'section', text: { type: 'mrkdwn', text: previewText } }
                ]
            }
        });
    } catch (error) {
        console.error("Falha ao abrir o modal de visualização:", error);
    }
});


// Listener para o botão de CONFIRMAR
slackApp.action('confirm_send_action', async ({ ack, body, client }) => {
    await ack();
    const jobId = body.actions[0].value;
    const jobFilePath = path.join(jobsDir, `${jobId}.json`);
    let job;

    try {
        // CORREÇÃO: Lê os dados do arquivo JSON
        if (!fs.existsSync(jobFilePath)) throw new Error("Job expirado ou não encontrado. Por favor, envie o arquivo novamente.");
        job = JSON.parse(fs.readFileSync(jobFilePath, 'utf-8'));
        
        const clickingUser = body.user.id;
        if (clickingUser !== job.userId) { /* ... (lógica de segurança) ... */ return; }

        await client.chat.update({
            channel: body.channel.id, ts: body.message.ts,
            text: `Enviando ${job.data.length} notificações... ⏳`, blocks: []
        });

        // Lógica de envio e relatório (sem alterações)
        let successCount = 0;
        const failedUsers = [];
        for (const row of job.data) {
           // ...
        }
        // ...
        
        await client.chat.update({
            channel: body.channel.id, ts: body.message.ts,
            text: `Relatório de Envio! ✅\n*${successCount} de ${job.data.length}* mensagens enviadas.`,
        });

    } catch (error) {
        console.error('Erro ao enviar notificações:', error);
        await client.chat.update({
            channel: body.channel.id, ts: body.message.ts,
            text: `❌ Ocorreu um erro crítico durante o envio: ${error.message}`,
        });
    } finally {
        // CORREÇÃO: Limpa os dois arquivos
        if (job && fs.existsSync(job.csvFilePath)) fs.unlinkSync(job.csvFilePath);
        if (fs.existsSync(jobFilePath)) fs.unlinkSync(jobFilePath);
        console.log(`Job ${jobId} finalizado e arquivos limpos.`);
    }
});


// Listener para o botão de CANCELAR
slackApp.action('cancel_send_action', async ({ ack, body, client }) => {
    await ack();
    const jobId = body.actions[0].value;
    const jobFilePath = path.join(jobsDir, `${jobId}.json`);

    try {
        if (!fs.existsSync(jobFilePath)) return; // Já foi processado
        const job = JSON.parse(fs.readFileSync(jobFilePath, 'utf-8'));

        if (body.user.id !== job.userId) return;

        await client.chat.update({
            channel: body.channel.id, ts: body.message.ts,
            text: `Operação cancelada por <@${body.user.id}>.`, blocks: []
        });

        // CORREÇÃO: Limpa os dois arquivos
        if (fs.existsSync(job.csvFilePath)) fs.unlinkSync(job.csvFilePath);
        if (fs.existsSync(jobFilePath)) fs.unlinkSync(jobFilePath);
        console.log(`Job ${jobId} cancelado pelo usuário.`);

    } catch (error) {
        console.error("Erro ao cancelar o job:", error);
    }
});


// Outros Listeners (reações, DMs) e inicialização do servidor (sem alterações)
slackApp.event('reaction_added', async ({ event, client }) => { /* ... */ });
slackApp.event('message', async ({ event, say }) => { /* ... */ });
app.get('/', (req, res) => res.status(200).send('Bot is running!'));
(async () => {
    const port = config.server.port;
    await slackApp.start(port);
    console.log(`🚀 Slack Bolt app está rodando na porta ${port}!`);
})();
