// config.js
require('dotenv').config();

module.exports = {
    slack: {
        signingSecret: process.env.SLACK_SIGNING_SECRET,
        botToken: process.env.SLACK_BOT_TOKEN,
        adminChannelId: process.env.SLACK_ADMIN_CHANNEL_ID || 'C0123456789',
    },
    server: {
        port: process.env.PORT || 3000,
    },
    app: {
        messageExpirationMs: parseInt(process.env.MESSAGE_EXPIRATION_MS, 10) || (12 * 60 * 60 * 1000)
    },
    // OBTENDO A LISTA RESTRITA DIRETAMENTE DA VARIÁVEL DE AMBIENTE (RENDER)
    invoice: {
        // Se INVOICE_EMAILS não estiver definido, ele usará um array vazio ([]), 
        // evitando exposição no repositório.
        emails: process.env.INVOICE_EMAILS 
            ? process.env.INVOICE_EMAILS.split(',').map(e => e.trim()) 
            : [] 
    }
};
