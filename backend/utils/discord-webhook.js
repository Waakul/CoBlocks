import fetch from 'node-fetch';

const chatWebhookUrl = process.env.CHAT_WEBHOOK_URL;

export async function postText(text) {
    if (!chatWebhookUrl) return false;

    try {
        const response = await fetch(chatWebhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: String(text) }),
        });
        if (!response.ok) {
            console.warn(`Discord webhook returned HTTP ${response.status}.`);
            return false;
        }
        return true;
    } catch (error) {
        console.warn('Could not send the Discord webhook:', error.message);
        return false;
    }
}
