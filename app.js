const { App, ExpressReceiver } = require('@slack/bolt');
const multer = require('multer');
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
// MELHORIA: Mapa para guardar trabalhos pendentes de confirmação
const pendingJobs = new Map();

// Funções de rastreamento (iguais à versão anterior)
function trackMessage(timestamp, data) {
    sentMessages.set(timestamp, data);
    setTimeout(() => sentMessages.delete(timestamp), config.app.messageExpirationMs);
}

function trackFile(fileId) {
    processedFiles.add(fileId);
    setTimeout(() => processedFiles.delete(fileId), config.app.messageExpirationMs);
}


// --- LÓGICA DE NEGÓCIO ---

/**
 * Lê e valida um arquivo CSV.
 * @param {string} filePath - Caminho do arquivo.
 * @returns {Promise<Array<object>>}
 */
function readCsvFile(filePath) {
    // (Esta função permanece a mesma da versão anterior, com validação de cabeçalho)
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


// --- LISTENERS DE EVENTOS E AÇÕES ---

// ETAPA 1: Listener para upload de arquivos
slackApp.event('file_shared', async ({ event, client }) => {
    const filePath = path.join(uploadDir, `${event.file_id}-temp.csv`);
    const { file_id: fileId, channel_id: channelId, user_id: userId } = event;

    try {
        if (processedFiles.has(fileId)) {
            console.log(`Arquivo ${fileId} já foi processado, ignorando.`);
            return;
        }

        const fileInfo = await client.files.info({ file: fileId });
        if (fileInfo.file.filetype !== 'csv') return;

        // Processo de download do arquivo (igual à versão anterior)
        const response = await axios.get(fileInfo.file.url_private_download, {
            headers: { 'Authorization': `Bearer ${config.slack.botToken}` },
            responseType: 'stream'
        });
        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        // Analisa o arquivo e valida
        const data = await readCsvFile(filePath);

        // Guarda os dados para a confirmação
        const jobId = fileId; // Usa o ID do arquivo como ID do trabalho
        pendingJobs.set(jobId, { data, filePath, channelId, userId });
        
        // Posta a mensagem de confirmação com botões
        await client.chat.postMessage({
            channel: channelId,
            text: `Arquivo \`${fileInfo.file.name}\` processado.`,
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `Olá <@${userId}>! Encontrei *${data.length} usuários* no arquivo \`${fileInfo.file.name}\`.\n\nDeseja enviar as notificações de salário para todos?`
                    }
                },
                {
                    type: "actions",
                    elements: [
                        {
                            type: "button",
                            text: {
                                type: "plain_text",
                                text: "✅ Enviar Notificações",
                                emoji: true
                            },
                            style: "primary",
                            value: jobId,
                            action_id: "confirm_send_action"
                        },
                        {
                            type: "button",
                            text: {
                                type: "plain_text",
                                text: "❌ Cancelar",
                                emoji: true
                            },
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
        // Garante a limpeza em caso de falha nesta etapa
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
});

// ETAPA 2: Listener para o botão de CONFIRMAR
slackApp.action('confirm_send_action', async ({ ack, body, client }) => {
    await ack(); // Confirma o recebimento da ação imediatamente

    const jobId = body.actions[0].value;
    const job = pendingJobs.get(jobId);
    const clickingUser = body.user.id;

    if (!job) {
        return; // Job já foi processado ou cancelado
    }
    
    // Medida de segurança: apenas o usuário que iniciou pode confirmar
    if (clickingUser !== job.userId) {
        await client.views.open({
            trigger_id: body.trigger_id,
            view: {
                type: 'modal',
                title: { type: 'plain_text', text: 'Acesso Negado' },
                close: { type: 'plain_text', text: 'Fechar' },
                blocks: [{
                    type: 'section',
                    text: { type: 'mrkdwn', text: 'Apenas o usuário que enviou o arquivo pode confirmar o envio.' }
                }]
            }
        });
        return;
    }

    try {
        // Atualiza a mensagem original para "Enviando..."
        await client.chat.update({
            channel: body.channel.id,
            ts: body.message.ts,
            text: `Enviando ${job.data.length} notificações... ⏳`,
            blocks: []
        });

        // Lógica de envio de mensagens
        let reportMessages = '';
        let successCount = 0;
        const failedUsers = [];

        for (const row of job.data) {
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
                    failedUsers.push(`${agentName} (dados numéricos inválidos)`);
                    continue;
                }

                const message = generateMessage(agentName, salary, faltas, feriadosTrabalhados);
                const result = await client.chat.postMessage({ channel: slackUserId, text: message });
                trackMessage(result.ts, { user: slackUserId, name: agentName });
                successCount++;
                reportMessages += `\n• *${agentName}*`;
            } catch (error) {
                failedUsers.push(agentName);
            }
        }
        
        // Cria o relatório final
        let reportText = `Relatório de Envio! ✅\n*${successCount} de ${job.data.length}* mensagens enviadas com sucesso.`;
        if (failedUsers.length > 0) {
            reportText += `\n\n❌ *Falha ao enviar para:* ${failedUsers.join(', ')}`;
        }

        // Atualiza a mensagem original com o relatório final
        await client.chat.update({
            channel: body.channel.id,
            ts: body.message.ts,
            text: reportText,
        });
        trackFile(jobId);

    } catch (error) {
        console.error('Erro ao enviar notificações:', error);
        await client.chat.update({
            channel: body.channel.id,
            ts: body.message.ts,
            text: `❌ Ocorreu um erro crítico durante o envio. Verifique os logs.`,
        });
    } finally {
        // Limpa o job e o arquivo temporário
        pendingJobs.delete(jobId);
        if (fs.existsSync(job.filePath)) fs.unlinkSync(job.filePath);
        console.log(`Job ${jobId} finalizado e arquivo limpo.`);
    }
});


// ETAPA 3: Listener para o botão de CANCELAR
slackApp.action('cancel_send_action', async ({ ack, body, client }) => {
    await ack();
    
    const jobId = body.actions[0].value;
    const job = pendingJobs.get(jobId);
    const clickingUser = body.user.id;
    
    if (!job) return;

    if (clickingUser !== job.userId) {
         await client.views.open({ /* ... (mesma mensagem de erro do 'confirm') ... */ });
        return;
    }

    // Atualiza a mensagem para "Cancelado"
    await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: `Operação cancelada por <@${clickingUser}>. O arquivo não será processado.`,
        blocks: []
    });

    // Limpa o job e o arquivo
    pendingJobs.delete(jobId);
    if (fs.existsSync(job.filePath)) fs.unlinkSync(job.filePath);
    console.log(`Job ${jobId} cancelado pelo usuário.`);
});

// Listener para reações (igual à versão anterior)
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

// Listener para DMs (igual à versão anterior)
slackApp.event('message', async ({ event, say }) => {
    if (event.channel_type === 'im' && !event.bot_id) {
        await say(`Olá! Sou um bot e não consigo responder conversas. Se precisar de ajuda, contate seu supervisor.`);
    }
});

// Rota de health check
app.get('/', (req, res) => res.status(200).send('Bot is running!'));

// --- INICIALIZAÇÃO DO SERVIDOR ---
(async () => {
    const port = config.server.port;
    await slackApp.start(port);
    console.log(`🚀 Slack Bolt app está rodando na porta ${port}!`);
})();
