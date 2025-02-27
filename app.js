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

// Cache to track processed files
const processedFiles = new Set();

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

// Utility functions
const logger = {
  info: (message, data = {}) => {
    console.log(`[INFO] ${message}`, data);
  },
  error: (message, error) => {
    console.error(`[ERROR] ${message}`, error);
  }
};

// Listen for file uploads
slackApp.event('file_shared', async ({ event }) => {
  try {
    const { file_id, channel_id } = event;
    
    if (processedFiles.has(file_id)) {
      logger.info(`Skipping already processed file: ${file_id}`);
      return;
    }

    logger.info(`File shared`, { fileId: file_id, channelId: channel_id });

    const fileInfo = await slackApp.client.files.info({ file: file_id });
    if (!fileInfo || !fileInfo.file) {
      throw new Error('File information not found');
    }

    const file = fileInfo.file;
    if (file.filetype !== 'csv') {
      logger.info('Ignoring non-CSV file', { fileType: file.filetype });
      return;
    }

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

    processedFiles.add(file_id);

    logger.info(`File processed successfully: ${filePath}`);
  } catch (error) {
    logger.error('Error processing shared file', error);
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
(async () => {
  try {
    await slackApp.start(PORT);
    logger.info(`⚡️ Slack Bolt app is running on port ${PORT}!`);
  } catch (error) {
    logger.error('Failed to start server', error);
    process.exit(1);
  }
})();
