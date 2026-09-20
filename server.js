// ============================================================
// OKI ALERTS V2 — TradingView → Claude AI Filter → Telegram
// Webhook gratuit avec filtre intelligent
// Deploy sur Render.com (free tier)
// ============================================================

const http = require('http');
const https = require('https');

// ============================================================
// CONFIG
// ============================================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'TON_TOKEN_ICI';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || 'TON_CHAT_ID_ICI';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const PORT = process.env.PORT || 3000;

// ============================================================
// PROMPT SYSTEME POUR CLAUDE — Analyste SMC/ICT
// ============================================================
const SYSTEM_PROMPT = `Tu es Oki, un analyste trading SMC/ICT senior specialise sur le Gold (XAUUSD), Forex, Indices et Crypto.

TON ROLE : analyser chaque signal d'alerte TradingView et donner un verdict GO ou NO GO.

REGLES D'ANALYSE :
1. Score minimum 4/5 pour un GO. En dessous = NO GO automatique.
2. Le biais HTF (H1/H4) DOIT etre aligne avec la direction du signal. HTF oppose = NO GO.
3. Zone Premium/Discount : BUY en discount, SELL en premium. Inversion = NO GO.
4. Kill Zone active renforce le signal. Hors KZ (sauf crypto 24H) = prudence.
5. Un OB teste + FVG adjacent = setup haute probabilite.

FORMAT DE REPONSE (strict, pas de bavardage) :
VERDICT: GO ou NO GO
CONFIANCE: 1 a 5 etoiles
RAISON: une phrase max
ENTREE: prix suggere ou "selon OB"
SL: niveau ou "ATR x3"
TP1: niveau (1.5R minimum)
TP2: niveau (3R)
RISQUE: 0.01 ou 0.02 lot selon confiance

Si le signal est un NO GO, donne quand meme une raison claire et courte.
Reponds UNIQUEMENT dans ce format, rien d'autre.`;

// ============================================================
// APPELER CLAUDE API
// ============================================================
function callClaude(signalData) {
    const userMessage = `Signal TradingView recu :
- Direction : ${signalData.signal || signalData.dir || '?'}
- Paire : ${signalData.pair || '?'}
- Timeframe : ${signalData.tf || '?'}
- Prix actuel : ${signalData.price || signalData.entry || '?'}
- Biais HTF : ${signalData.bias || '?'}
- Zone : ${signalData.zone || '?'}
- Score : ${signalData.score || '?'}/5
- Structure : ${signalData.struct || '?'}
- Kill Zone : ${signalData.kz || '?'}
- RSI : ${signalData.rsi || '?'}
- OB actifs : ${signalData.ob_actifs || '?'}
- OB testes : ${signalData.ob_testes || '?'}

Analyse ce signal et donne ton verdict.`;

    const payload = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }]
    });

    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.anthropic.com',
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(body);
                    if (res.statusCode === 200 && result.content && result.content[0]) {
                        resolve(result.content[0].text);
                    } else {
                        console.error('Claude API error:', res.statusCode, body);
                        resolve(null);
                    }
                } catch (e) {
                    console.error('Claude parse error:', e.message);
                    resolve(null);
                }
            });
        });

        req.on('error', (err) => {
            console.error('Claude request error:', err.message);
            resolve(null);
        });

        req.setTimeout(15000, () => {
            req.destroy();
            console.error('Claude timeout 15s');
            resolve(null);
        });

        req.write(payload);
        req.end();
    });
}

// ============================================================
// FORMATER LE MESSAGE TELEGRAM
// ============================================================
function formatVerdict(analysis, data) {
    const dir = data.signal || data.dir || '?';
    const pair = data.pair || '?';
    const tf = data.tf || '?';

    const isGO = analysis.includes('VERDICT: GO') && !analysis.includes('NO GO');
    const verdictEmoji = isGO ? '✅' : '❌';
    const verdictText = isGO ? 'GO' : 'NO GO';

    return `${verdictEmoji} *OKI VERDICT: ${verdictText}*

${analysis}

_Signal: ${dir} ${pair} ${tf}_`;
}

function formatFallback(data) {
    const dir = data.signal || data.dir || '?';
    const emoji = dir === 'BUY' ? '\u{1F7E2}' : '\u{1F534}';
    const pair = data.pair || '?';
    const tf = data.tf || '?';
    const price = data.price || data.entry || '?';
    const bias = data.bias || '?';
    const zone = data.zone || '?';
    const score = data.score || '?';

    return `${emoji} *${dir} ${pair} ${tf}* -- Score ${score}/5

Prix: \`${price}\`
Biais: ${bias}
Zone: ${zone}

⚠️ _Analyse Claude indisponible -- signal brut_`;
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'Oki Alerts V2 actif',
            version: '2.0',
            claude: ANTHROPIC_API_KEY ? 'configure' : 'PAS CONFIGURE',
            telegram: TELEGRAM_BOT_TOKEN !== 'TON_TOKEN_ICI' ? 'configure' : 'PAS CONFIGURE'
        }));
        return;
    }

    // Webhook TradingView
    if (req.method === 'POST' && req.url === '/webhook') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const dir = data.signal || data.dir || '?';
                const pair = data.pair || '?';
                const score = data.score || '?';
                console.log(`[${new Date().toISOString()}] Signal: ${dir} ${pair} Score ${score}/5`);

                if (ANTHROPIC_API_KEY) {
                    console.log('Analyse Claude en cours...');
                    const analysis = await callClaude(data);

                    if (analysis) {
                        const verdictMsg = formatVerdict(analysis, data);
                        await sendTelegram(verdictMsg);
                        console.log('Verdict envoye:', analysis.includes('NO GO') ? 'NO GO' : 'GO');
                    } else {
                        const fallbackMsg = formatFallback(data);
                        await sendTelegram(fallbackMsg);
                        console.log('Fallback envoye (Claude indisponible)');
                    }
                } else {
                    const rawMsg = formatFallback(data);
                    await sendTelegram(rawMsg);
                    console.log('Mode V1 (pas de cle Claude)');
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, version: 'v2' }));
            } catch (err) {
                console.error('Erreur:', err.message);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: err.message }));
            }
        });
        return;
    }

    // Test endpoint
    if (req.method === 'GET' && req.url === '/test') {
        const testData = {
            signal: 'BUY',
            pair: 'XAUUSD',
            tf: '15',
            price: '2580.50',
            bias: 'BULLISH',
            zone: 'DISCOUNT',
            score: '4',
            struct: 'CHoCH Bull',
            kz: 'LONDON',
            rsi: '42',
            ob_actifs: '3',
            ob_testes: '1'
        };

        console.log('[TEST] Simulation signal BUY XAUUSD...');

        try {
            if (ANTHROPIC_API_KEY) {
                const analysis = await callClaude(testData);
                if (analysis) {
                    await sendTelegram(formatVerdict(analysis, testData));
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, test: true, analysis }));
                    return;
                }
            }
            await sendTelegram(formatFallback(testData));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, test: true, fallback: true }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
    }

    res.writeHead(404);
    res.end('Not found');
});

server.listen(PORT, () => {
    console.log('========================================');
    console.log('  OKI ALERTS V2 -- Claude AI Filter');
    console.log('========================================');
    console.log(`Port: ${PORT}`);
    console.log(`Claude API: ${ANTHROPIC_API_KEY ? 'OK' : 'PAS CONFIGURE'}`);
    console.log(`Telegram: ${TELEGRAM_BOT_TOKEN !== 'TON_TOKEN_ICI' ? 'OK' : 'PAS CONFIGURE'}`);
    console.log('Endpoints:');
    console.log('  GET  /         -> Health check');
    console.log('  POST /webhook  -> TradingView signal');
    console.log('  GET  /test     -> Test simulation');
    console.log('========================================');
});
