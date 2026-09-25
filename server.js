// ============================================================
// OKI ALERTS V3 — TradingView → Filtre Dur + Claude AI → Telegram
// Corrections post-diagnostic 25/09/2026 :
//   1. Filtre dur HTF/Bias/Struct AVANT Claude
//   2. Prompt Claude strict (pas de "malgré")
//   3. SL ATR x4 (plus ATR x3)
//   4. TP conservateur (-10 pts)
//   5. Risque fixe 0.01 lot (jamais 0.02)
//   6. Filtre paire : XAUUSD uniquement
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

// Paires autorisées (tout le reste = ignoré)
const ALLOWED_PAIRS = ['XAUUSD', 'GOLD'];

// ============================================================
// FILTRE DUR — Rejet AVANT Claude (économise des tokens)
// ============================================================
function hardFilter(data) {
    const signal = (data.signal || data.dir || '').toUpperCase();
    const bias = (data.bias || '').toUpperCase();
    const zone = (data.zone || '').toUpperCase();
    const score = parseInt(data.score) || 0;
    const struct = (data.struct || '').toUpperCase();
    const pair = (data.pair || '').toUpperCase();

    // 1. Filtre paire — XAUUSD uniquement
    const pairAllowed = ALLOWED_PAIRS.some(p => pair.includes(p));
    if (!pairAllowed) {
        return { blocked: true, reason: `Paire ${pair} ignorée — XAUUSD uniquement` };
    }

    // 2. Score minimum 4/5
    if (score < 4) {
        return { blocked: true, reason: `Score ${score}/5 insuffisant (minimum 4/5)` };
    }

    // 3. HTF Bias opposé au signal = NO GO
    if (signal === 'BUY' && (bias.includes('BEAR') || bias === 'BEARISH')) {
        return { blocked: true, reason: `BUY bloqué — HTF Bias BEARISH (conflit direct)` };
    }
    if (signal === 'SELL' && (bias.includes('BULL') || bias === 'BULLISH')) {
        return { blocked: true, reason: `SELL bloqué — HTF Bias BULLISH (conflit direct)` };
    }

    // 4. Zone inversée = NO GO
    if (signal === 'BUY' && zone === 'PREMIUM') {
        return { blocked: true, reason: `BUY bloqué — zone PREMIUM (acheter en discount)` };
    }
    if (signal === 'SELL' && zone === 'DISCOUNT') {
        return { blocked: true, reason: `SELL bloqué — zone DISCOUNT (vendre en premium)` };
    }

    // 5. Structure opposée au signal = NO GO
    if (signal === 'BUY' && struct === 'BEAR') {
        return { blocked: true, reason: `BUY bloqué — structure BEAR (trend opposé)` };
    }
    if (signal === 'SELL' && struct === 'BULL') {
        return { blocked: true, reason: `SELL bloqué — structure BULL (trend opposé)` };
    }

    return { blocked: false };
}

// ============================================================
// PROMPT SYSTEME POUR CLAUDE — V3 strict
// ============================================================
const SYSTEM_PROMPT = `Tu es Oki, un analyste trading SMC/ICT senior specialise sur le Gold (XAUUSD).

TON ROLE : analyser chaque signal d'alerte TradingView et donner un verdict GO ou NO GO.

REGLES ABSOLUES (aucune exception, aucun "malgre") :
1. Score minimum 4/5. En dessous = NO GO automatique.
2. Le biais HTF DOIT etre aligne avec la direction du signal. HTF oppose = NO GO. PAS DE "malgre structure opposee". PAS DE "correction attendue". Conflit = NO GO.
3. La structure (trend) DOIT etre alignee avec le signal. Trend oppose = NO GO.
4. Zone Premium/Discount : BUY en discount UNIQUEMENT, SELL en premium UNIQUEMENT. Inversion = NO GO.
5. Kill Zone active (London ou New York) renforce le signal. Hors KZ = prudence accrue.
6. Un OB avec freshness > 50% renforce. OB < 25% = faiblesse.

INTERDIT :
- Dire GO avec une reserve ("malgre", "cependant", "toutefois")
- Si tu hesites entre GO et NO GO = NO GO
- Recommander 0.02 lot. TOUJOURS 0.01 lot.

FORMAT DE REPONSE (strict, pas de bavardage) :
VERDICT: GO ou NO GO
CONFIANCE: 1 a 5 etoiles
RAISON: une phrase max, directe, sans reserve
ENTREE: prix exact du signal
SL: ATR x4 (calcule le niveau exact)
TP1: niveau (2R minimum) puis RETIRER 10 points du niveau calcule
TP2: niveau (3R) puis RETIRER 10 points du niveau calcule
RISQUE: 0.01 lot (toujours)

Si le signal est un NO GO, donne la raison claire et courte.
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
- Structure (Trend) : ${signalData.struct || '?'}
- Kill Zone : ${signalData.kz || '?'}
- RSI : ${signalData.rsi || '?'}
- OB actifs : ${signalData.ob_actifs || '?'}
- OB testes : ${signalData.ob_testes || '?'}
- OB freshness : ${signalData.ob_fresh || '?'}%
- OB retests : ${signalData.ob_retests || '?'}

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
// FORMATER LES MESSAGES TELEGRAM
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

function formatBlocked(reason, data) {
    const dir = data.signal || data.dir || '?';
    const pair = data.pair || '?';
    const tf = data.tf || '?';
    const score = data.score || '?';

    return `🚫 *SIGNAL BLOQUÉ*

${reason}

_Signal: ${dir} ${pair} ${tf} — Score ${score}/5_
_Filtre V3 actif — signal rejeté avant analyse Claude_`;
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

    return `${emoji} *${dir} ${pair} ${tf}* — Score ${score}/5

Prix: \`${price}\`
Biais: ${bias}
Zone: ${zone}

⚠️ _Analyse Claude indisponible — signal brut_`;
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
            status: 'Oki Alerts V3 actif',
            version: '3.0',
            filtres: 'HTF/Bias/Struct/Zone/Score + paire XAUUSD only',
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
                console.log(`[${new Date().toISOString()}] Signal reçu: ${dir} ${pair} Score ${score}/5`);

                // ── FILTRE DUR V3 ──
                const filter = hardFilter(data);
                if (filter.blocked) {
                    console.log(`[BLOQUÉ] ${filter.reason}`);

                    // Notification silencieuse pour paires non-autorisées
                    if (filter.reason.includes('ignorée')) {
                        console.log('Paire ignorée — pas de notification Telegram');
                    } else {
                        // Notifier le blocage sur Telegram (pour transparence)
                        await sendTelegram(formatBlocked(filter.reason, data));
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, version: 'v3', blocked: true, reason: filter.reason }));
                    return;
                }

                // ── ANALYSE CLAUDE (signal a passé le filtre dur) ──
                if (ANTHROPIC_API_KEY) {
                    console.log('Signal validé par filtre dur — analyse Claude en cours...');
                    const analysis = await callClaude(data);

                    if (analysis) {
                        const verdictMsg = formatVerdict(analysis, data);
                        await sendTelegram(verdictMsg);
                        console.log('Verdict envoyé:', analysis.includes('NO GO') ? 'NO GO' : 'GO');
                    } else {
                        const fallbackMsg = formatFallback(data);
                        await sendTelegram(fallbackMsg);
                        console.log('Fallback envoyé (Claude indisponible)');
                    }
                } else {
                    const rawMsg = formatFallback(data);
                    await sendTelegram(rawMsg);
                    console.log('Mode V1 (pas de clé Claude)');
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, version: 'v3' }));
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
            price: '4280.50',
            bias: 'BULLISH',
            zone: 'DISCOUNT',
            score: '4',
            struct: 'BULL',
            kz: 'LONDON',
            rsi: '42',
            ob_actifs: '3',
            ob_testes: '1',
            ob_fresh: '100',
            ob_retests: '0'
        };

        console.log('[TEST] Simulation signal BUY XAUUSD...');

        // Test du filtre dur d'abord
        const filter = hardFilter(testData);
        if (filter.blocked) {
            console.log(`[TEST BLOQUÉ] ${filter.reason}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, test: true, blocked: true, reason: filter.reason }));
            return;
        }

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

    // Test filtre — pour vérifier les blocages sans envoyer sur Telegram
    if (req.method === 'POST' && req.url === '/test-filter') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const filter = hardFilter(data);
                console.log(`[TEST-FILTER] ${filter.blocked ? 'BLOQUÉ: ' + filter.reason : 'PASSÉ'}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, ...filter, data_received: data }));
            } catch (err) {
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
    console.log('========================================');
    console.log('  OKI ALERTS V3 — Filtre Dur + Claude');
    console.log('========================================');
    console.log(`Port: ${PORT}`);
    console.log(`Claude API: ${ANTHROPIC_API_KEY ? 'OK' : 'PAS CONFIGURE'}`);
    console.log(`Telegram: ${TELEGRAM_BOT_TOKEN !== 'TON_TOKEN_ICI' ? 'OK' : 'PAS CONFIGURE'}`);
    console.log(`Paires: ${ALLOWED_PAIRS.join(', ')}`);
    console.log('Filtres actifs:');
    console.log('  - Paire autorisée uniquement');
    console.log('  - Score minimum 4/5');
    console.log('  - HTF Bias aligné obligatoire');
    console.log('  - Structure/Trend alignée obligatoire');
    console.log('  - Zone Premium/Discount correcte');
    console.log('Endpoints:');
    console.log('  GET  /            -> Health check');
    console.log('  POST /webhook     -> TradingView signal');
    console.log('  GET  /test        -> Test simulation');
    console.log('  POST /test-filter -> Test filtre seul');
    console.log('========================================');
});
