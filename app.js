require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const multer = require('multer');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');

// Importa o fetch
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// Criar um ExpressReceiver
const receiver = new ExpressReceiver({ signingSecret: process.env.SLACK_SIGNING_SECRET });

// Inicializa o app do Slack com o receiver
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: receiver
});

// Use receiver.app para configurar o middleware e as rotas
const upload = multer({ dest: 'uploads/' });
const app = receiver.app;

// Armazena as mensagens enviadas para rastrear reações
const sentMessages = {};
const processedFiles = new Set();

// Rota para receber arquivos via Slash Command
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send('Nenhum arquivo foi enviado.');
    }
    const filePath = req.file.path;
    const data = await readCsvFile(filePath);
    console.log('Dados lidos do CSV:', data);

    let reportMessages = '';

    for (const row of data) {
      const slackUserId = row['Slack User'];
      const salary = row['Salary'];
      const agentName = row['Name'];
      const faltas = parseInt(row['Faltas'] || 0, 10);
      const feriadosTrabalhados = parseInt(row['Feriados Trabalhados'] || 0, 10);

      if (slackUserId && salary) {
        const message = generateMessage(agentName, salary, faltas, feriadosTrabalhados);
        const result = await slackApp.client.chat.postMessage({
          channel: slackUserId,
          text: message,
        });
        console.log(`Mensagem enviada para ${agentName} (ID: ${slackUserId}):`, message);

        sentMessages[result.ts] = { user: slackUserId, name: agentName };
        reportMessages += `\n*${agentName}:* Salário: US$${salary}, Faltas: ${faltas}, Feriados Trabalhados: ${feriadosTrabalhados}`;
      }
    }

    const channelId = req.body.channel_id;
    await slackApp.client.chat.postMessage({
      channel: channelId,
      text: `Planilha processada! ✅\n\n*Detalhes enviados:*${reportMessages}`,
    });

    fs.unlinkSync(filePath);
    res.status(200).send('Planilha processada com sucesso!');
  } catch (error) {
    console.error('Erro ao processar a planilha:', error);
    res.status(500).send('Erro ao processar a planilha.');
  }
});

// Função para ler o arquivo CSV
function readCsvFile(filePath) {
  return new Promise((resolve, reject) => {
    const data = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => data.push(row))
      .on('end', () => resolve(data))
      .on('error', (error) => reject(error));
  });
}

// Função para gerar a mensagem personalizada
function generateMessage(name, salary, faltas, feriadosTrabalhados) {
    const faltasText = faltas === 1
        ? `houve *${faltas} falta*`
        : faltas > 1
            ? `houve *${faltas} faltas*`
            : '*não houve faltas*';
    const feriadosText = feriadosTrabalhados === 1
        ? `trabalhou em *${feriadosTrabalhados} feriado*`
        : feriadosTrabalhados > 1
            ? `trabalhou em *${feriadosTrabalhados} feriados*`
            : '*não trabalhou em nenhum feriado*';

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
• Faltas: ${faltasText}.
• Feriados trabalhados: ${feriadosText}.

*Caso não haja pendências*, você pode emitir a nota com os valores acima até o último dia útil do mês. Por favor, envie a nota fiscal para *corefone@domus.global* com cópia para *administracion@corefone.us*, *gilda.romero@corefone.us*, e os supervisores.

Por favor, confirme que recebeu esta mensagem e concorda com os valores acima reagindo com um ✅ (*check*).

Agradecemos sua atenção e desejamos um ótimo trabalho!
_Atenciosamente,_  
*Supervisão Corefone BR*
`;
}

// Monitora reações às mensagens
slackApp.event('reaction_added', async ({ event }) => {
    const { reaction, item, user } = event;

    if (reaction === 'white_check_mark' && sentMessages[item.ts]) {
        const { user: slackUserId, name } = sentMessages[item.ts];
        await slackApp.client.chat.postMessage({
            channel: process.env.CHANNEL_ID,
            text: `Agente ${name} (@${slackUserId}) confirmou o recebimento do salário e está de acordo com os valores.`,
        });
    }
});

// Listener para mensagens em DMs
slackApp.event('message', async ({ event, say }) => {
    const { channel, text, user } = event;

    const conversationType = await slackApp.client.conversations.info({ channel });
    if (conversationType.channel.is_im) {
        console.log(`Mensagem recebida de ${user} na DM: ${text}`);
        await say(`Olá! Recebi sua mensagem: "${text}". Se precisar de algo, estou aqui!`);
    }
});

// Listener para uploads de arquivos
slackApp.event('file_shared', async ({ event }) => {
    try {
        const { file_id, channel_id } = event;

        if (processedFiles.has(file_id)) {
            console.log(`Arquivo ${file_id} já foi processado, ignorando duplicata.`);
            return;
        }
        processedFiles.add(file_id);

        const fileInfo = await slackApp.client.files.info({ file: file_id });
        console.log('Arquivo compartilhado:', fileInfo.file);

        if (fileInfo.file.filetype === 'csv') {
            const fileUrl = fileInfo.file.url_private_download;
            const filePath = path.join(__dirname, 'uploads', fileInfo.file.name);
            const response = await fetch(fileUrl, {
                headers: {
                    Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
                },
            });
            const arrayBuffer = await response.arrayBuffer();
            fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
            console.log(`Arquivo baixado: ${filePath}`);

            const data = await readCsvFile(filePath);
            console.log('Dados lidos do CSV:', data);

            let reportMessages = '';

            for (const row of data) {
                const slackUserId = row['Slack User'];
                const salary = row['Salary'];
                const agentName = row['Name'];
                const faltas = parseInt(row['Faltas'] || 0, 10);
                const feriadosTrabalhados = parseInt(row['Feriados Trabalhados'] || 0, 10);

                if (slackUserId && salary) {
                    const message = generateMessage(agentName, salary, faltas, feriadosTrabalhados);
                    const result = await slackApp.client.chat.postMessage({
                        channel: slackUserId,
                        text: message,
                    });
                    console.log(`Mensagem enviada para ${agentName} (ID: ${slackUserId}):`, message);

                    sentMessages[result.ts] = {
                        user: slackUserId,
                        name: agentName,
                    };
                    reportMessages += `\n*${agentName}:* Salário: US$${salary}, Faltas: ${faltas}, Feriados Trabalhados: ${feriadosTrabalhados}`;
                }
            }

            await slackApp.client.chat.postMessage({
                channel: channel_id,
                text: `Planilha processada! ✅\n\n*Detalhes enviados:*${reportMessages}`,
            });

            fs.unlinkSync(filePath);
        } else {
            console.log('O arquivo compartilhado não é um CSV.');
        }
    } catch (error) {
        console.error('Erro ao processar o arquivo compartilhado:', error);
    }
});

// Rota para responder aos pings do UptimeRobot
app.get('/', (req, res) => {
  res.status(200).send('Bot is running!');
});

// Rota HEAD para evitar erros de requisições não tratadas
app.head('/', (req, res) => {
  res.status(200).end();
});

// Iniciar o servidor
(async () => {
  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`🚀 Express server com Slack Bolt app está rodando na porta ${port}!`);
})();
