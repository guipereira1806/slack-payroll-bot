require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');

// Create upload directory if it doesn't exist
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Import fetch for Node.js < 18.x
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv') {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  }
});

// Create the ExpressReceiver
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true
});

// Access the Express app
const app = receiver.app;
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Slack app with the ExpressReceiver
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: receiver
});

// Store sent messages for tracking reactions
const sentMessages = new Map();

// Utility functions
const logger = {
  info: (message, data = {}) => {
    console.log(`[INFO] ${message}`, data);
  },
  error: (message, error) => {
    console.error(`[ERROR] ${message}`, error);
  },
  debug: (message, data = {}) => {
    if (process.env.DEBUG === 'true') {
      console.debug(`[DEBUG] ${message}`, data);
    }
  }
};

/**
 * Read CSV file and parse its contents
 * @param {string} filePath - Path to the CSV file
 * @returns {Promise<Array>} - Parsed CSV data
 */
function readCsvFile(filePath) {
  return new Promise((resolve, reject) => {
    const data = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => data.push(row))
      .on('end', () => {
        logger.info(`CSV file successfully processed: ${filePath}`, { rowCount: data.length });
        resolve(data);
      })
      .on('error', (error) => {
        logger.error(`Error reading CSV file: ${filePath}`, error);
        reject(error);
      });
  });
}

/**
 * Generate personalized message for a user
 * @param {string} name - User's name
 * @param {number} salary - User's salary
 * @param {number} faltas - Number of absences
 * @param {number} feriadosTrabalhados - Number of holidays worked
 * @returns {string} - Formatted message
 */
function generateMessage(name, salary, faltas = 0, feriadosTrabalhados = 0) {
  // Format absence text based on count
  const faltasText = faltas === 1 
    ? `houve *${faltas} falta*` 
    : faltas > 1 
      ? `houve *${faltas} faltas*` 
      : '*não houve faltas*';
  
  // Format holidays worked text based on count
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

*Caso não haja pendências*, você pode emitir a nota com os valores acima até o último dia útil do mês.

Por favor, confirme que recebeu esta mensagem e concorda com os valores acima reagindo com um ✅ (*check*).

Agradecemos sua atenção e desejamos um ótimo trabalho!
_Atenciosamente,_  
*Supervisão Corefone BR*
`;
}

/**
 * Process CSV data and send notifications to users
 * @param {Array} data - Parsed CSV data
 * @param {string} channelId - Channel ID for confirmation messages
 * @returns {Promise<number>} - Number of messages sent
 */
async function processCSVData(data, channelId) {
  let messagesSent = 0;
  
  try {
    for (const row of data) {
      const slackUserId = row['Slack User']; 
      const salary = row['Salary']; 
      const agentName = row['Name'];
      const faltas = parseInt(row['Faltas'] || 0);
      const feriadosTrabalhados = parseInt(row['Feriados Trabalhados'] || 0);

      if (!slackUserId || !salary) {
        logger.info('Skipping row with missing Slack User ID or salary', { row });
        continue;
      }

      try {
        // Send DM to the agent
        const message = generateMessage(agentName, salary, faltas, feriadosTrabalhados);
        const result = await slackApp.client.chat.postMessage({
          channel: slackUserId,
          text: message,
        });
        
        logger.info(`Message sent to ${agentName}`, { userId: slackUserId });
        messagesSent++;

        // Store the message info for tracking reactions
        sentMessages.set(result.ts, {
          user: slackUserId,
          name: agentName,
        });
      } catch (error) {
        logger.error(`Failed to send message to ${agentName} (${slackUserId})`, error);
      }
    }

    // Send confirmation to channel
    if (channelId) {
      await slackApp.client.chat.postMessage({
        channel: channelId,
        text: `Planilha processada! ✅ Mensagens enviadas: ${messagesSent}/${data.length}`,
      });
    }
    
    return messagesSent;
  } catch (error) {
    logger.error('Error processing CSV data', error);
    throw error;
  }
}

// Route for slash command to upload CSV file
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    // Check if file was uploaded
    if (!req.file) {
      logger.info('No file uploaded');
      return res.status(400).send('Nenhum arquivo foi enviado.');
    }
    
    const filePath = req.file.path;
    logger.info(`Processing uploaded file: ${filePath}`);
    
    const data = await readCsvFile(filePath);
    const channelId = req.body.channel_id;
    
    await processCSVData(data, channelId);
    
    // Clean up - remove the file after processing
    fs.unlink(filePath, (err) => {
      if (err) logger.error(`Error deleting file: ${filePath}`, err);
    });
    
    res.status(200).send('Planilha processada com sucesso!');
  } catch (error) {
    logger.error('Error handling file upload', error);
    res.status(500).send(`Erro ao processar a planilha: ${error.message}`);
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.status(200).send({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// HEAD request handler for ping checks
app.head('/', (req, res) => {
  res.status(200).end();
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Express error', err);
  res.status(500).send({
    error: err.message || 'Internal Server Error'
  });
});

// Slack event listeners

// Listen for reactions to track confirmations
slackApp.event('reaction_added', async ({ event, context }) => {
  try {
    const { reaction, item, user } = event;

    if (reaction === 'white_check_mark' && sentMessages.has(item.ts)) {
      const { user: slackUserId, name } = sentMessages.get(item.ts);
      
      // Verify the user reacting is the same one the message was sent to
      if (slackUserId === user) {
        logger.info(`Confirmation received from ${name}`, { userId: slackUserId });
        
        // Send confirmation to the admin channel
        await slackApp.client.chat.postMessage({
          channel: process.env.ADMIN_CHANNEL_ID || process.env.CHANNEL_ID,
          text: `Agente ${name} (<@${slackUserId}>) confirmou o recebimento do salário e está de acordo com os valores.`,
        });
      }
    }
  } catch (error) {
    logger.error('Error handling reaction', error);
  }
});

// Listen for messages in DMs
slackApp.event('message', async ({ event, context, say }) => {
  try {
    // Skip if it's a bot message or doesn't have text
    if (event.bot_id || !event.text) return;
    
    // Check if the message is in a DM
    if (event.channel_type === 'im') {
      logger.info(`DM received from user`, { userId: event.user, text: event.text.substring(0, 50) });
      
      // Respond to the user
      await say({
        text: `Olá! Recebi sua mensagem. Se tiver dúvidas sobre seu pagamento, por favor entre em contato com a supervisão.`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "Olá! Recebi sua mensagem. Se tiver dúvidas sobre seu pagamento, por favor entre em contato com a supervisão."
            }
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: "Este é um sistema automatizado. Mensagens enviadas aqui não são monitoradas por pessoas."
              }
            ]
          }
        ]
      });
      
      // Forward the message to admins if configured
      if (process.env.FORWARD_DMS === 'true' && process.env.ADMIN_CHANNEL_ID) {
        await slackApp.client.chat.postMessage({
          channel: process.env.ADMIN_CHANNEL_ID,
          text: `Mensagem recebida de <@${event.user}>: "${event.text}"`,
        });
      }
    }
  } catch (error) {
    logger.error('Error handling message event', error);
  }
});

// Listen for file uploads
slackApp.event('file_shared', async ({ event, context }) => {
  try {
    const { file_id, channel_id } = event;
    logger.info(`File shared`, { fileId: file_id, channelId: channel_id });

    // Get file info
    const fileInfo = await slackApp.client.files.info({ file: file_id });
    const file = fileInfo.file;
    
    // Process only CSV files
    if (file.filetype !== 'csv') {
      logger.info('Ignoring non-CSV file', { fileType: file.filetype });
      return;
    }
    
    // Download the file
    const fileUrl = file.url_private_download;
    const fileName = `${Date.now()}-${file.name}`;
    const filePath = path.join(uploadDir, fileName);
    
    logger.info(`Downloading file`, { url: fileUrl, path: filePath });
    
    const response = await fetch(fileUrl, {
      headers: {
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      },
    });
    
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
    }
    
    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
    
    // Process the CSV file
    const data = await readCsvFile(filePath);
    await processCSVData(data, channel_id);
    
    // Clean up
    fs.unlinkSync(filePath);
    
  } catch (error) {
    logger.error('Error processing shared file', error);
    
    // Notify about the error
    if (event.channel_id) {
      try {
        await slackApp.client.chat.postMessage({
          channel: event.channel_id,
          text: `❌ Erro ao processar o arquivo: ${error.message}`,
        });
      } catch (notifyError) {
        logger.error('Failed to send error notification', notifyError);
      }
    }
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
(async () => {
  try {
    // Start the server
    await slackApp.start(PORT);
    logger.info(`⚡️ Slack Bolt app is running on port ${PORT}!`);
    logger.info('Server is ready to receive requests');
  } catch (error) {
    logger.error('Failed to start server', error);
    process.exit(1);
  }
})();
