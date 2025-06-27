require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const multer = require('multer');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');
// Usando axios por ser mais direto em ambientes CommonJS e ter melhor tratamento de erros
const axios = require('axios');

// --- SETUP INICIAL ---
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const receiver = new ExpressReceiver({ signingSecret: process.env.SLACK_SIGNING_SECRET });
const slackApp = new App({
    token: process.env.SLACK_BOT_TOKEN,
    receiver: receiver
});
const app = receiver.app; // Acesso ao app Express

const upload = multer({ dest: 'uploads/' });

// --- MELHORIA: CONSTANTES E GERENCIAMENTO DE ESTADO ---
const CSV_COLS = {
    SLACK_ID: 'Slack User',
    NAME: 'Name',
    SALARY: 'Salary',
    FALTAS: 'Faltas',
    FERIADOS: 'Feriados Trabalhados'
};

const sentMessages = new Map();
const processedFiles = new Set();
const MESSAGE_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

function trackMessage(timestamp, data) {
    sentMessages.set(timestamp, data);
    setTimeout(() => sentMessages.delete(timestamp), MESSAGE_EXPIRATION_MS);
}

function trackFile(fileId) {
    processedFiles.add(fileId);
    setTimeout(() => processedFiles.delete(fileId), MESSAGE_EXPIRATION_MS);
}


// --- LÓGICA DE NEGÓCIO CENTRALIZADA (CORREÇÃO DA DUPLICAÇÃO) ---

/**
 * Função central para processar o arquivo CSV e notificar os usuários.
 * @param {string} filePath - Caminho do arquivo CSV.
 * @param {string} channelId - ID do canal para enviar o relatório.
 */
async function processCsvAndNotify(filePath, channelId) {
    const data = await readCsvFile(filePath);
    console.log('Dados lidos do CSV:', data);

    let reportMessages = '';
    let successCount = 0;
    const failedUsers = [];

    for (const row of data) {
        const slackUserId = row[CSV_COLS.SLACK_ID];
        const salary = row[CSV_COLS.SALARY];
        const agentName = row[CSV_COLS.NAME];

        if (!slackUserId || !salary) {
            if (agentName) failedUsers.push(agentName);
            continue;
        }

        try {
            const faltas = parseInt(row[CSV_COLS.FALTAS] || 0, 10);
            const feriadosTrabalhados = parseInt(row[CSV_COLS.FERIADOS] || 0, 10);

            const message = generateMessage(agentName, salary, faltas, feriadosTrabalhados);
            const result = await slackApp.client.chat.postMessage({
                channel: slackUserId,
                text: message,
            });

            console.log(`Mensagem enviada para ${agentName} (ID: ${slackUserId})`);
            trackMessage(result.ts, { user: slackUserId, name: agentName });
            successCount++;
            reportMessages += `\n• *${agentName}:* Salário: US$${salary}, Faltas: ${faltas}, Feriados: ${feriadosTrabalhados}`;
        } catch (error) {
            console.error(`Falha ao enviar mensagem para ${agentName}:`, error.data || error.message);
            failedUsers.push(agentName);
        }
    }

    let reportText = `Planilha processada! ✅\n${successCount}/${data.length} mensagens enviadas.`;
    if (reportMessages) {
        reportText += `\n\n*Detalhes enviados:*${reportMessages}`;
    }
    if (failedUsers.length > 0) {
        reportText += `\n\n❌ *Falha ao enviar para:* ${failedUsers.join(', ')}`;
    }

    await slackApp.client.chat.postMessage({
        channel: channelId,
        text: reportText,
    });

    fs.unlinkSync(filePath); // Limpa o arquivo após o uso
}

function readCsvFile(filePath) {
    return new Promise((resolve, reject) => {
        const data = [];
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (row) => {
                // Filtra linhas completamente vazias
                if (Object.values(row).some(val => val !== '')) {
                    data.push(row);
                }
            })
            .on('end', () => resolve(data))
            .on('error', (error) => reject(error));
    });
}

function generateMessage(name, salary, faltas, feriadosTrabalhados) {
    // Sua função generateMessage original aqui (sem alterações)
    const faltasText = faltas === 1 ? `houve *${faltas} falta*` : `houve *${faltas} faltas*`;
    const feriadosText = feriadosTrabalhados === 1 ? `trabalhou em *${feriadosTrabalhados} feriado*` : `trabalhou em *${feriadosTrabalhados} feriados*`;

    return `
:wave: *Olá, ${name}!*
Esperamos que esteja tudo bem. Passamos aqui para compartilhar os detalhes do seu salário referente a este mês.

*Valor do salário a ser pago neste mês:* US$${salary}

*Instruções para emissão da nota:*
• A nota deve ser emitida até o _último dia útil do mês_.
• Ao emitir a nota, inclua o valor do câmbio utilizado e o mês de referência. Segue um exemplo:
  \`\`\`
  Honorários <mês> - Asesoramiento de atenção al cliente + cambio utilizado (US$ 1 = BR$ 5,55)
  \`\`\`

*Detalhes adicionais:*
• Faltas: ${faltas > 0 ? faltasText : '*não houve faltas*'}.
• Feriados trabalhados: ${feriadosTrabalhados > 0 ? feriadosText : '*não trabalhou em nenhum feriado*'}.

*Caso não haja pendências*, você pode emitir a nota com os valores acima até o último dia útil do mês. Por favor, envie a nota fiscal para *corefone@domus.global* com cópia para *administracion@corefone.us*, *gilda.romero@corefone.us*, e os supervisores.

Por favor, confirme que recebeu esta mensagem e concorda com os valores acima reagindo com um ✅ (*check*).

Agradecemos sua atenção e desejamos um ótimo trabalho!
_Atenciosamente,_  
*Supervisão Corefone BR*
`;
}


// --- ROTAS E LISTENERS ---

// Rota para Slash Command
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).send('Nenhum arquivo foi enviado.');
        }
        await processCsvAndNotify(req.file.path, req.body.channel_id);
        res.status(200).send('Planilha sendo processada! Você receberá um relatório no canal em breve.');
    } catch (error) {
        console.error('Erro em /upload:', error);
        res.status(500).send('Erro ao processar a planilha.');
    }
});

// Listener para uploads de arquivos via UI do Slack
slackApp.event('file_shared', async ({ event, client }) => {
    try {
        if (processedFiles.has(event.file_id)) {
            console.log(`Arquivo ${event.file_id} já foi processado, ignorando.`);
            return;
        }
        trackFile(event.file_id);

        const fileInfo = await client.files.info({ file: event.file_id });
        if (fileInfo.file.filetype !== 'csv') {
            return;
        }

        const response = await axios.get(fileInfo.file.url_private_download, {
            headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` },
            responseType: 'stream'
        });

        const filePath = path.join(uploadDir, fileInfo.file.name);
        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        await processCsvAndNotify(filePath, event.channel_id);

    } catch (error) {
        console.error('Erro ao processar o arquivo compartilhado:', error);
        await client.chat.postMessage({
            channel: event.channel_id,
            text: `❌ Ocorreu um erro ao processar o arquivo: ${error.message}`
        });
    }
});

// Monitora reações
slackApp.event('reaction_added', async ({ event, client }) => {
    try {
        const { reaction, item, user } = event;
        const messageInfo = sentMessages.get(item.ts);

        // CORREÇÃO CRÍTICA: Verifica se a reação é a correta, se a mensagem está sendo rastreada E se o usuário que reagiu é o correto.
        if (reaction === 'white_check_mark' && messageInfo && messageInfo.user === user) {
            const { name } = messageInfo;
            await client.chat.postMessage({
                channel: process.env.ADMIN_CHANNEL_ID || process.env.CHANNEL_ID, // Use um canal de admin
                text: `✅ O agente *${name}* (<@${user}>) confirmou o recebimento do salário e está de acordo com os valores.`,
            });
            // Opcional: remover a mensagem do mapa após a confirmação
            sentMessages.delete(item.ts);
        }
    } catch (error) {
        console.error('Erro ao processar reação:', error);
    }
});

// Listener para DMs (sem grandes alterações)
slackApp.event('message', async ({ event, say }) => {
    if (event.channel_type ===
