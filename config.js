// config.js
require('dotenv').config();

module.exports = {
    slack: {
        signingSecret: process.env.SLACK_SIGNING_SECRET,
        botToken: process.env.SLACK_BOT_TOKEN,
        
        // CORRIGIDO: O fallback (C0123456789) foi removido.
        // O valor será obrigatoriamente lido da variável de ambiente SLACK_ADMIN_CHANNEL_ID.
        adminChannelId: process.env.SLACK_ADMIN_CHANNEL_ID,
    },
    server: {
        port: process.env.PORT || 3000,
    },
    app: {
        // Ex: 12 horas
        messageExpirationMs: parseInt(process.env.MESSAGE_EXPIRATION_MS, 10) || (12 * 60 * 60 * 1000)
    },
    invoice: {
        // OBTÉM A LISTA DE E-MAILS DO RENDER.
        // Se INVOICE_EMAILS não estiver definido, retorna um array vazio (seguro).
        emails: process.env.INVOICE_EMAILS 
            ? process.env.INVOICE_EMAILS.split(',').map(e => e.trim()) 
            : [] 
    }
};
