const { App, ExpressReceiver } = require('@slack/bolt');
// const multer = require('multer'); // <--- REMOVIDO
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');
const axios = require('axios');

// MELHORIA: Configuração centralizada importada do novo arquivo config.js
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
// const upload = multer({ dest: 'uploads/' }); // <--- REMOVIDO

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

function trackMessage(timestamp, data) {
    sentMessages.set(timestamp, data);
    setTimeout(() => sentMessages.delete(timestamp), config.app.messageExpirationMs);
}

function trackFile(fileId) {
    processedFiles.add(fileId);
    setTimeout(() => processedFiles.delete(fileId), config.app.messageExpirationMs);
}

// --- LÓGICA DE NEGÓCIO CENTRALIZADA ---

/**
 * Função central para processar o arquivo CSV e notificar os usuários.
 * @param {string} filePath - Caminho do arquivo CSV.
 * @param {string} channelId - ID do canal para enviar o relatório.
 */
async function processCsvAndNotify(filePath, channelId) {
    try {
        // MELHORIA: A função readCsvFile agora valida os cabeçalhos do arquivo.
        const data = await readCsvFile(filePath);
        console.log(`Dados lidos do CSV: ${data.length} linhas.`);

        let reportMessages = '';
        let successCount = 0;
        const failedUsers = [];

        for (const row of data) {
            const agentName = row[CSV_COLS.NAME];
            try {
                const slackUserId = row[CSV_COLS.SLACK_ID];
                const salary = row[CSV_COLS.SALARY];

                if (!slackUserId || !salary || !agentName) {
                    failedUsers.push(agentName || 'Nome Desconhecido (ID ou Salário ausente)');
                    continue;
                }
                
                // MELHORIA: Validação robusta para dados numéricos.
                const faltasRaw = row[CSV_COLS.FALTAS] || 0;
                const feriadosRaw = row[CSV_COLS.FERIADOS] || 0;
                const faltas = parseInt(faltasRaw, 10);
                const feriadosTrabalhados = parseInt(feriadosRaw, 10);

                if (isNaN(faltas) || isNaN(feriadosTrabalhados)) {
                    console.warn(`Dados inválidos para ${agentName}. Faltas: '${faltasRaw}', Feriados: '${feriadosRaw}'.`);
                    failedUsers.push(`${agentName} (dados numéricos inválidos)`);
                    continue;
                }

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
                console.error(`Falha ao processar linha para ${agentName}:`, error.data || error.message);
                failedUsers.push(agentName);
            }
        }

        let reportText = `Planilha processada! ✅\n*${successCount} de ${data.length}* mensagens enviadas com sucesso.`;
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

    } catch (error) {
        console.error('Falha crítica no processamento do CSV:', error);
        // Envia feedback específico se o erro for de cabeçalho inválido
        const errorMessage = error.code === 'INVALID_HEADERS' 
            ? error.message
            : 'Ocorreu um erro inesperado ao processar a planilha.';
            
        await slackApp.client.chat.postMessage({
            channel: channelId,
            text: `❌ ${errorMessage}`
        });
    } finally {
        // MELHORIA CRÍTICA: O bloco finally garante que o arquivo seja deletado,
        // mesmo que ocorra um erro durante o processamento.
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`Arquivo temporário ${filePath} limpo com sucesso.`);
        }
    }
}

/**
 * Lê e valida um arquivo CSV.
 * MELHORIA: Adicionada validação de cabeçalhos.
 * @param {string} filePath - Caminho do arquivo.
 * @returns {Promise<Array<object>>} - Uma promessa que resolve com os dados do CSV.
 */
function readCsvFile(filePath) {
    return new Promise((resolve, reject) => {
        const data = [];
        const expectedHeaders = new Set(Object.values(CSV_COLS));
        const stream = fs.createReadStream(filePath).pipe(csv());
        
        stream.on('headers', (headers) => {
            const missingHeaders = [...expectedHeaders].filter(h => !headers.includes(h));
            if (missingHeaders.length > 0) {
                const err = new Error(`Cabeçalhos obrigatórios ausentes no CSV: ${missingHeaders.join(', ')}`);
                err.code = 'INVALID_HEADERS';
                stream.destroy(); // Para o processamento
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
    const faltasText = faltas === 1 ? `houve *${faltas} falta*` : `houve *${faltas} faltas*`;
    const feriadosText = feriadosTrabalhados === 1 ? `trabalhou em *${feriadosTrabalhados} feriado*` : `trabalhou em *${feriadosTrabalhados} feriados*`;

    return `
:wave: *Olá, ${name}!*
Esperamos que esteja tudo bem. Passamos aqui para compartilhar os detalhes do seu salário referente a este mês.

*Valor do salário a ser pago neste mês:* US$${salary}

*Instruções para emissão da nota:*
• A nota deve ser emitida no _último dia útil do mês_.
• Ao emitir a nota, inclua o valor do câmbio utilizado e o mês de referência. Segue um exemplo:
  \`\`\`
  Honorários <mês> - Asesoramiento de atenção al cliente + cambio utilizado (US$ 1 = BR$ 5,55)
  \`\`\`

*Detalhes adicionais:*
• Faltas: ${faltas > 0 ? faltasText : '*não houve faltas*'}.
• Feriados trabalhados: ${feriadosTrabalhados > 0 ? feriadosText : '*não trabalhou em nenhum feriado*'}.

*Caso não haja pendências*, você pode emitir a nota com os valores acima no último dia útil do mês. Por favor, envie a nota fiscal para *corefone@domus.global* com cópia para *administracion@corefone.us*, *gilda.romero@corefone.us*, e os supervisores.

Por favor, confirme que recebeu esta mensagem e concorda com os valores acima reagindo com um ✅ (*check*).

Agradecemos sua atenção e desejamos um ótimo trabalho!
_Atenciosamente,_  
*Supervisão Corefone BR*
`;
}

// --- ROTAS E LISTENERS ---

// Listener para uploads de arquivos via UI do Slack
slackApp.event('file_shared', async ({ event, client }) => {
    try {
        if (processedFiles.has(event.file_id)) {
            console.log(`Arquivo ${event.file_id} já foi processado, ignorando.`);
            return;
        }
        trackFile(event.file_id);

        const fileInfo = await client.files.info({ file: event.file_id });
        if (fileInfo.file.filetype !== 'csv') return;

        const response = await axios.get(fileInfo.file.url_private_download, {
            headers: { 'Authorization': `Bearer ${config.slack.botToken}` },
            responseType: 'stream'
        });

        const filePath = path.join(uploadDir, `${event.file_id}-${fileInfo.file.name}`);
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
            text: `❌ Ocorreu um erro ao baixar ou processar o arquivo: ${error.message}`
        });
    }
});

// Monitora reações
slackApp.event('reaction_added', async ({ event, client }) => {
    try {
        const { reaction, item, user } = event;
        const messageInfo = sentMessages.get(item.ts);

        if (reaction === 'white_check_mark' && messageInfo && messageInfo.user === user) {
            const { name } = messageInfo;
            await client.chat.postMessage({
                channel: config.slack.adminChannelId,
                text: `✅ O agente *${name}* (<@${user}>) confirmou o recebimento do salário e está de acordo com os valores.`,
            });
            sentMessages.delete(item.ts);
        }
    } catch (error) {
        console.error('Erro ao processar reação:', error);
    }
});

// Listener para DMs
slackApp.event('message', async ({ event, say }) => {
    if (event.channel_type === 'im' && !event.bot_id) {
        console.log(`Mensagem recebida de ${event.user} na DM: ${event.text}`);
        await say(`Olá! Sou um bot e não consigo responder conversas. Se precisar de ajuda, contate seu supervisor.`);
    }
});

// Rotas de health check
app.get('/', (req, res) => res.status(200).send('Bot is running!'));

// --- INICIALIZAÇÃO DO SERVIDOR ---
(async () => {
    const port = config.server.port;
    await slackApp.start(port);
    console.log(`🚀 Slack Bolt app está rodando na porta ${port}!`);
})();
