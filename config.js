// config.js
require('dotenv').config();

const config = {
    slack: {
        signingSecret: process.env.SLACK_SIGNING_SECRET,
        botToken: process.env.SLACK_BOT_TOKEN,
        adminChannelId: process.env.ADMIN_CHANNEL_ID,
    },
    server: {
        port: process.env.PORT || 3000,
    },
    app: {
        // 7 dias em milissegundos
        messageExpirationMs: 7 * 24 * 60 * 60 * 1000,
    }
};

// Validação crítica: Garante que o aplicativo não inicie sem as chaves essenciais.
if (!config.slack.signingSecret || !config.slack.botToken || !config.slack.adminChannelId) {
    throw new Error("FATAL ERROR: Variáveis de ambiente essenciais do Slack (SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, ADMIN_CHANNEL_ID) não foram definidas!");
}

module.exports = config;
