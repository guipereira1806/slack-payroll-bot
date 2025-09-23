const { App, ExpressReceiver } = require('@slack/bolt');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');
const axios = require('axios');

// MELHORIA: Configuração centralizada importada do novo arquivo config.js
// Certifique-se de ter um arquivo config.js com as variáveis de ambiente
// module.exports = {
//   slack: {
//     signingSecret: process.env.SLACK_SIGNING_SECRET,
//     botToken: process.env.SLACK_BOT_TOKEN,
//     adminChannelId: process.env.SLACK_ADMIN_CHANNEL_ID,
//   },
//   server: {
//     port: process.env.PORT || 3000,
//   },
//   app: {
//     messageExpirationMs: 12 * 60 * 60 * 1000 // 12 horas
//   }
// };
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
                
                const faltasRaw = row[CSV_COLS.FALTAS] || 0;
                const feriadosRaw = row[CSV_COLS.FERIADOS] || 0;
                const faltas = parseInt(faltasRaw, 10);
                const feriadosTrabalhados = parseInt(feriadosRaw, 10);

                if (isNaN(faltas) || isNaN(feriadosTrabalhados)) {
                    console.warn(`Dados inválidos para ${agentName}. Faltas: '${faltasRaw}', Feriados: '${feriadosRaw}'.`);
                    failedUsers.push(`${agentName} (dados numéricos inválidos)`);
                    continue;
                }

                // MELHORIA: Usa a nova função que retorna blocos de mensagem
                const messageBlocks = generateMessage(agentName, salary, faltas, feriadosTrabalhados);
                
                const result = await slackApp.client.chat.postMessage({
                    channel: slackUserId,
                    blocks: messageBlocks, // Passa os blocos para a propriedade 'blocks'
                    text: 'Detalhes de pagamento mensal. Por favor, visualize em um cliente Slack que suporte blocos de mensagem.' // Fallback text
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
        
        const errorMessage = error.code === 'INVALID_HEADERS' 
            ? error.message
            : 'Ocorreu um erro inesperado ao processar a planilha.';
            
        await slackApp.client.chat.postMessage({
            channel: channelId,
            text: `❌ ${errorMessage}`
        });
    } finally {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`Arquivo temporário ${filePath} limpo com sucesso.`);
        }
    }
}

/**
 * Lê e valida um arquivo CSV.
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

/**
 * Gera um array de Slack Blocks para uma mensagem formatada.
 * @param {string} name - Nome do usuário.
 * @param {number} salary - Valor do salário.
 * @param {number} faltas - Número de faltas.
 * @param {number} feriadosTrabalhados - Número de feriados trabalhados.
 * @returns {Array<object>} - Array de blocos de mensagem do Slack.
 */
function generateMessage(name, salary, faltas, feriadosTrabalhados) {
    const faltasText = faltas > 0 ? (faltas === 1 ? `houve *${faltas} falta*` : `houve *${faltas} faltas*`) : '*não houve faltas*';
    const feriadosText = feriadosTrabalhados > 0 ? (feriadosTrabalhados === 1 ? `trabalhou em *${feriadosTrabalhados} feriado*` : `trabalhou em *${feriadosTrabalhados} feriados*`) : '*não trabalhou em nenhum feriado*';

    return [
        {
            "type": "header",
            "text": {
                "type": "plain_text",
                "text": "Detalhes de Pagamento Mensal"
            }
        },
        {
            "type": "divider"
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": `:wave: Olá, *${name}!*`
            }
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": "Esperamos que esteja tudo bem. Passamos aqui para compartilhar os detalhes do seu salário referente a este mês."
            }
        },
        {
            "type": "divider"
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": `*Valor a ser pago:* *US$${salary}*`
            }
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": `*Detalhes adicionais:*\n• Faltas: ${faltasText}\n• Feriados trabalhados: ${feriadosText}`
            }
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": `*Instruções para emissão da nota:*\n• A nota deve ser emitida no _último dia útil do mês_.\n• Ao emitir a nota, inclua o valor do câmbio utilizado e o mês de referência. Exemplo:`
            }
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": "```\nHonorários <mês> - Asesoramiento de atenção al cliente + cambio utilizado (US$ 1 = BR$ 5,55)\n```"
            }
        },
        {
            "type": "divider"
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": `Envie o anexo com o nome neste formato:\n"Nome Sobrenome - Mês.Ano"`
            }
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": "```\nPor exemplo: Claudia Fonseca - 09.2025\n```"
            }
        },
        {
            "type": "divider"
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": "*Caso não haja pendências*, você pode emitir a nota fiscal para `corefone@domus.global` com cópia para `administracion@corefone.us`, `gilda.romero@corefone.us`, e os supervisores."
            }
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": "Por favor, confirme que recebeu esta mensagem e concorda com os valores acima reagindo com um ✅ (*check*)."
            }
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": "Agradecemos sua atenção e desejamos um ótimo trabalho!\nAtenciosamente,\n*Supervisão Corefone BR*"
            }
        }
    ];
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
