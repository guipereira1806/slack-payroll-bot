require('dotenv').config();
const { App } = require('@slack/bolt');
const axios = require('axios');

// Inicializa o app do Slack
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// Função para detectar o idioma usando a API da DeepL
async function detectLanguage(text) {
  const response = await axios.post(
    'https://api-free.deepl.com/v2/translate',
    null,
    {
      params: {
        auth_key: process.env.DEEPL_API_KEY,
        text: text,
        target_lang: 'EN', // Usamos EN como padrão para detecção
      },
    }
  );
  return response.data.translations[0].detected_source_language;
}

// Função para traduzir texto usando a API da DeepL
async function translateText(text, targetLang) {
  const response = await axios.post(
    'https://api-free.deepl.com/v2/translate',
    null,
    {
      params: {
        auth_key: process.env.DEEPL_API_KEY,
        text: text,
        target_lang: targetLang,
      },
    }
  );
  return response.data.translations[0].text;
}

// Escuta mensagens no canal (ignora threads e mensagens sem texto)
app.message(async ({ message, say }) => {
  try {
    // Ignora mensagens em threads ou sem texto
    if (message.thread_ts || !message.text) {
      console.log('Mensagem ignorada: thread ou conteúdo não textual.');
      return;
    }

    const text = message.text;

    // Detecta o idioma da mensagem
    const sourceLang = await detectLanguage(text);
    console.log(`Idioma detectado: ${sourceLang}`);

    // Define os idiomas alvo com base no idioma original
    const targetLanguages = {
      PT: ['EN', 'ES'],
      EN: ['PT', 'ES'],
      ES: ['PT', 'EN'],
    };

    if (!targetLanguages[sourceLang]) {
      console.log(`Idioma não suportado: ${sourceLang}`);
      return;
    }

    // Traduz para os outros idiomas
    const translations = await Promise.all(
      targetLanguages[sourceLang].map(async (lang) => {
        const translatedText = await translateText(text, lang);
        return `${lang}: ${translatedText}`;
      })
    );

    console.log('Traduções geradas:', translations);

    // Envia as traduções como uma resposta na thread
    await say({
      thread_ts: message.ts, // Inicia uma thread com a mensagem original
      text: translations.join('\n'),
    });

    console.log('Resposta enviada com sucesso.');
  } catch (error) {
    console.error('Erro ao processar mensagem:', error);
  }
});

// Inicia o bot
(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('Bot está online!');
})();
