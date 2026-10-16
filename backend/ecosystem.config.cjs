const result = require('dotenv').config();
if (result.error) {
    console.error('No .env file found. Create one from .env.example.');
    process.exit(1);
}

module.exports = {
    apps: [
        {
            name: 'CoBlocks',
            script: './index.js',
            killTimeout: 60_000,
            node_args: '--max-old-space-size=5120',
            env: {
                PORT: process.env.PORT,
                PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
                CHAT_WEBHOOK_URL: process.env.CHAT_WEBHOOK_URL,
                ADMIN_USER: process.env.ADMIN_USER,
                ADMIN: process.env.ADMIN,
                TRUST_PROXY: process.env.TRUST_PROXY,
                API_RATE_LIMIT: process.env.API_RATE_LIMIT,
            },
        },
    ],
};
