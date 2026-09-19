// ============================================================
// OKI ALERTS — TradingView → Telegram
// Serveur webhook gratuit pour Alvaro
// Deployer sur Railway.app ou Render.com (free tier)
// ============================================================

const http = require('http');
const https = require('https');

// ============================================================
// CONFIG — remplis ces 2 valeurs
// ============================================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'TON_TOKEN_ICI';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || 'TON_CHAT_ID_ICI';
const PORT = process.env.PORT || 3000;

// ============================================================
// FORMATER LE MESSAGE TELEGRAM
// ============================================================
function formatMessage(data) {
    const dir = data.dir || '?';
    const emoji = dir === 'BUY' ? '🟢' : '🔴';
    const score = data.score || '?';
    const pair = data.pair || '?';
    const tf = data.tf || '?';
    const bias = data.bias || '?';
    const struct = data.struct || '?';
    const rsi = data.rsi || '?';
    const obActifs = data.ob_actifs ?? '?';
    const obTestes = data.ob_testes ?? '?';
    const entry = data.entry || '?';
    const sl = data.sl || '?';
    const tp1 = data.tp1 || '?';
    const tp2 = data.tp2 || '?';
    const rr1 = data.rr1 || '?';
    const rr2 = data.rr2 || '?';
    const kz = data.kz || '?';

    return `${emoji} *${dir} ${pair} ${tf}* — Score ${score}/5

*Contexte:*
Biais: ${bias}
Structure: ${struct}
Kill Zone: ${kz}
RSI: ${rsi}
OB: ${obActifs} actifs / ${obTestes} testes

*Niveaux:*
Entry: \`${entry}\`
SL: \`${sl}\`
TP1: \`${tp1}\` (${rr1}R)
TP2: \`${tp2}\` (${rr2}R)

_GO ou NO GO ?_`;
}

// ============================================================
// ENVOYER SUR TELEGRAM
// ============================================================
function sendTelegram(text) {
    const payload = JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: 'Markdown'
    });

    const options = {
        hostname: 'api.telegram.org',
        path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    console.log('Telegram OK');
                    resolve(true);
                } else {
                    console.error('Telegram error:', body);
                    reject(new Error(body));
                }
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

// ============================================================
// SERVEUR HTTP
// ============================================================
const server = http.createServer(async (req, res) => {
    // Health check
    if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Oki Alerts actif');
        return;
    }

    // Webhook TradingView
    if (req.method === 'POST' && req.url === '/webhook') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                console.log('Signal recu:', data.dir, data.pair, data.score + '/5');

                const message = formatMessage(data);
                await sendTelegram(message);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch (err) {
                console.error('Erreur:', err.message);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: err.message }));
            }
        });
        return;
    }

    res.writeHead(404);
    res.end('Not found');
});

server.listen(PORT, () => {
    console.log(`Oki Alerts demarre sur port ${PORT}`);
    console.log('Webhook URL: /webhook');
    console.log('Bot Telegram:', TELEGRAM_BOT_TOKEN !== 'TON_TOKEN_ICI' ? 'configure' : 'PAS CONFIGURE');
});
