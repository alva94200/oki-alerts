// ============================================================
// OKI ALERTS V3.2 — TradingView → Filtre Dur + Claude AI → Telegram
// V3.2 : TP/SL adaptatif selon OB Freshness (backteste 1 mois)
// Compatible OKI Fusion v1.0 (scoring 7/7, Bias, OPR)
// Corrections post-diagnostic + Fusion upgrade
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
// DETECTER TYPE D'ALERTE
// ============================================================
function getAlertType(data) {
    const sig = (data.signal || '').toUpperCase();
    const t = (data.alert_type || data.type || '').toLowerCase();

    // Fusion envoie signal:"SURVEILLANCE" + type:"HTF_FLIP" ou type:"BIAS_FORT"
    if (sig === 'SURVEILLANCE') {
        if (t === 'htf_flip') return 'htf_flip';
        if (t === 'bias_fort') return 'bias_fort';
        return 'surveillance';
    }
    if (t === 'htf_flip') return 'htf_flip';
    if (t === 'bias_fort') return 'bias_fort';
    if (t === 'surveillance') return 'surveillance';
    return 'signal';
}

// ============================================================
// FILTRE DUR — Rejet AVANT Claude (économise des tokens)
// Compatible Fusion v1.0 : scoring dynamique 5 ou 7
// ============================================================
function hardFilter(data) {
    const signal = (data.signal || data.dir || '').toUpperCase();
    const bias = (data.bias || '').toUpperCase();
    const zone = (data.zone || '').toUpperCase();
    const score = parseInt(data.score) || 0;
    const maxscore = parseInt(data.maxscore) || 5;
    const struct = (data.struct || '').toUpperCase();
    const pair = (data.pair || '').toUpperCase();
    const biasDir = (data.bias_dir || '').toUpperCase();

    // 1. Filtre paire — XAUUSD uniquement
    const pairAllowed = ALLOWED_PAIRS.some(p => pair.includes(p));
    if (!pairAllowed) {
        return { blocked: true, reason: `Paire ${pair} ignorée — XAUUSD uniquement` };
    }

    // 2. Score minimum dynamique : 3/5 (legacy) ou 4/7 (Fusion)
    const minScore = maxscore >= 7 ? 4 : 3;
    if (score < minScore) {
        return { blocked: true, reason: `Score ${score}/${maxscore} insuffisant (minimum ${minScore}/${maxscore})` };
    }

    // 3. HTF Bias opposé au signal = NO GO
    if (signal === 'BUY' && (bias.includes('BEAR') || bias === 'BEARISH')) {
        return { blocked: true, reason: `BUY bloqué — HTF Bias BEARISH (conflit direct)` };
    }
    if (signal === 'SELL' && (bias.includes('BULL') || bias === 'BULLISH')) {
        return { blocked: true, reason: `SELL bloqué — HTF Bias BULLISH (conflit direct)` };
    }

    // 4. Bias directionnel Fusion opposé = NO GO
    if (biasDir && biasDir !== '?' && biasDir !== 'NEUTRAL') {
        if (signal === 'BUY' && biasDir === 'BEAR') {
            return { blocked: true, reason: `BUY bloqué — Bias directionnel BEAR` };
        }
        if (signal === 'SELL' && biasDir === 'BULL') {
            return { blocked: true, reason: `SELL bloqué — Bias directionnel BULL` };
        }
    }

    // 5. Zone inversée = NO GO
    if (signal === 'BUY' && zone === 'PREMIUM') {
        return { blocked: true, reason: `BUY bloqué — zone PREMIUM (acheter en discount)` };
    }
    if (signal === 'SELL' && zone === 'DISCOUNT') {
        return { blocked: true, reason: `SELL bloqué — zone DISCOUNT (vendre en premium)` };
    }

    // 6. Structure opposée au signal = NO GO
    if (signal === 'BUY' && struct === 'BEAR') {
        return { blocked: true, reason: `BUY bloqué — structure BEAR (trend opposé)` };
    }
    if (signal === 'SELL' && struct === 'BULL') {
        return { blocked: true, reason: `SELL bloqué — structure BULL (trend opposé)` };
    }

    return { blocked: false };
}

// ============================================================
// PROMPT SYSTEME POUR CLAUDE — V3.2 Fusion (TP/SL adaptatif)
// ============================================================
const SYSTEM_PROMPT = `Tu es Oki, un analyste trading SMC/ICT senior specialise sur le Gold (XAUUSD).

TON ROLE : analyser chaque signal OKI Fusion v1.0 et donner un verdict GO ou NO GO.

LE SIGNAL CONTIENT 7 CRITERES :
1-5. SMC classiques : CHoCH/BOS, OB, FVG, Zone Premium/Discount, Kill Zone
6. Bias directionnel (PDH/PDL, Weekly Open, DXY, Liquidity Sweep) — force 0 a 4
7. OPR Sweep (NY Opening Range sweep detecte)

REGLES ABSOLUES (aucune exception, aucun "malgre") :
1. Le biais HTF DOIT etre aligne avec le signal. HTF oppose = NO GO. PAS DE "malgre". Conflit = NO GO.
2. Le bias directionnel DOIT etre aligne ou neutre. Oppose = NO GO.
3. La structure (trend) DOIT etre alignee. Trend oppose = NO GO.
4. Zone Premium/Discount : BUY en discount UNIQUEMENT, SELL en premium UNIQUEMENT.
5. Kill Zone active (London/New York) renforce. Hors KZ = prudence accrue.
6. OPR Sweep actif = bonus fort en session NY.
7. Bias fort (3+/4) + OPR Sweep = setup A+ (confiance maximale).

=== OB FRESHNESS — REGLE CLE (backteste sur 1 mois) ===
L'OB Freshness est le facteur #1 de reussite du trade.
- OB 100% (vierge, 0 retests) = zone tres reactive, haute probabilite TP.
- OB 80-99% = zone encore forte, bonne probabilite.
- OB 50-79% = zone affaiblie, probabilite moyenne.
- OB < 50% = zone epuisee, faible probabilite → prudence maximale.

INTERDIT :
- Dire GO avec une reserve ("malgre", "cependant", "toutefois")
- Si tu hesites entre GO et NO GO = NO GO
- Recommander plus de 0.01 lot. TOUJOURS 0.01 lot.

FORMAT DE REPONSE (strict) :
VERDICT: GO ou NO GO
GRADE: A+, A, B, C ou D
CONFIANCE: 1 a 5 etoiles
RAISON: une phrase max, directe, sans reserve
ENTREE: prix exact du signal

=== CALCUL SL/TP ADAPTATIF (selon OB Freshness) ===

Le SL et les TP s'ajustent selon la freshness de l'OB :

Si OB Freshness = 100% (zone vierge) :
  SL = ATR x 1.2 (tight car reaction forte attendue)
  TP1 = 2.5R | TP2 = 4R (agressif)

Si OB Freshness = 80-99% :
  SL = ATR x 1.5 (standard)
  TP1 = 2R | TP2 = 3R (standard)

Si OB Freshness = 50-79% :
  SL = ATR x 1.8 (large, protection)
  TP1 = 1.5R | TP2 = 2R (conservateur)

Si OB Freshness < 50% :
  SL = ATR x 2.0 (tres large)
  TP1 = 1R seulement, PAS de TP2 (scalp rapide)

BUY : SL = prix - (ATR x multiplicateur). TP = prix + (distance SL x ratio R).
SELL : SL = prix + (ATR x multiplicateur). TP = prix - (distance SL x ratio R).
Affiche TOUJOURS les niveaux exacts.

RISQUE: 0.01 lot (toujours)

GRADING (large, Claude decide GO/NO GO selon le contexte) :
- A+ : Score 7/7, bias fort (3+/4), OPR sweep, OB 80%+ — trade parfait, GO
- A  : Score 6/7, bias aligne, KZ active, OB 80%+ — tres bon setup, GO
- B  : Score 5/7, conditions correctes, OB 60%+ — bon setup, GO
- C  : Score 4/7, OB fresh 80%+ ET (KZ active OU bias aligne) — acceptable, GO ou NO GO selon analyse.
- D  : Score 4/7 sans OB 80% ou sans confluences — setup faible, NO GO

BONUS FRESHNESS :
- Un OB 100% peut UPGRADER un grade d'un cran (C → B, B → A).
- Un OB < 50% DOWNGRADE d'un cran (B → C, A → B) et exige TP conservateurs.

Reponds UNIQUEMENT dans ce format.`;

// ============================================================
// APPELER CLAUDE API
// ============================================================
function callClaude(signalData) {
    const maxscore = signalData.maxscore || '7';

    const userMessage = `Signal OKI Fusion v1.0 recu :
- Direction : ${signalData.signal || signalData.dir || '?'}
- Paire : ${signalData.pair || '?'}
- Timeframe : ${signalData.tf || '?'}
- Prix actuel : ${signalData.price || signalData.entry || '?'}
- Biais HTF : ${signalData.bias || '?'}
- Zone : ${signalData.zone || '?'}
- Score : ${signalData.score || '?'}/${maxscore}
- Structure (Trend) : ${signalData.struct || '?'}
- Kill Zone : ${signalData.kz || '?'}
- RSI : ${signalData.rsi || '?'}
- OB actifs : ${signalData.ob_actifs || '?'}
- OB testes : ${signalData.ob_testes || '?'}
- OB freshness : ${signalData.ob_fresh || '?'}%
- OB retests : ${signalData.ob_retests || '?'}
- Bias direction : ${signalData.bias_dir || '?'}
- Bias force : ${signalData.bias_str || '?'}/4
- OPR Sweep : ${signalData.opr_sweep && signalData.opr_sweep !== 'NONE' && signalData.opr_sweep !== 'non' ? signalData.opr_sweep : 'non'}
- ATR(14) : ${signalData.atr || '?'}

- SL pre-calcule : ${signalData.sl || '?'}
- TP1 pre-calcule : ${signalData.tp1 || '?'}
- TP2 pre-calcule : ${signalData.tp2 || '?'}
- Mode TP : ${signalData.tp_mode || '?'}

Analyse ce signal. Les niveaux SL/TP sont deja calcules par l'indicateur selon la freshness OB.
Confirme ou ajuste si necessaire. Donne ton verdict.`;

    const payload = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
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

// Signal avec verdict Claude
function formatVerdict(analysis, data) {
    const dir = data.signal || data.dir || '?';
    const pair = data.pair || '?';
    const tf = data.tf || '?';
    const maxscore = data.maxscore || '7';
    const score = data.score || '?';
    const biasStr = data.bias_str || '?';
    const oprSweep = data.opr_sweep && data.opr_sweep !== 'NONE' && data.opr_sweep !== 'non' && data.opr_sweep !== 'false';

    const isGO = analysis.includes('VERDICT: GO') && !analysis.includes('NO GO');
    const verdictEmoji = isGO ? '✅' : '❌';
    const verdictText = isGO ? 'GO' : 'NO GO';

    // Detect grade
    let grade = '';
    const gradeMatch = analysis.match(/GRADE:\s*(A\+|A|B|C|D)/i);
    if (gradeMatch) grade = ` [${gradeMatch[1]}]`;

    const oprBadge = oprSweep ? ' \u{1F534}OPR' : '';

    // OB Freshness badge + TP mode
    const obFresh = parseInt(data.ob_fresh) || 0;
    let freshBadge = '';
    if (obFresh >= 100) freshBadge = ' 💎OB100%';
    else if (obFresh >= 80) freshBadge = ' 🟢OB' + obFresh + '%';
    else if (obFresh >= 50) freshBadge = ' 🟡OB' + obFresh + '%';
    else if (obFresh > 0) freshBadge = ' 🔴OB' + obFresh + '%';

    return `${verdictEmoji} *OKI VERDICT: ${verdictText}${grade}*${oprBadge}${freshBadge}

${analysis}

_Signal: ${dir} ${pair} ${tf} | Score ${score}/${maxscore} | Bias ${biasStr}/4_`;
}

// Signal bloqué par filtre dur
function formatBlocked(reason, data) {
    const dir = data.signal || data.dir || '?';
    const pair = data.pair || '?';
    const tf = data.tf || '?';
    const score = data.score || '?';
    const maxscore = data.maxscore || '7';

    return `\u{1F6AB} *SIGNAL BLOQUÉ*

${reason}

_Signal: ${dir} ${pair} ${tf} — Score ${score}/${maxscore}_
_Filtre V3.2 actif — signal rejeté avant analyse Claude_`;
}

// Signal sans Claude (fallback)
function formatFallback(data) {
    const dir = data.signal || data.dir || '?';
    const emoji = dir === 'BUY' ? '\u{1F7E2}' : '\u{1F534}';
    const pair = data.pair || '?';
    const tf = data.tf || '?';
    const price = data.price || data.entry || '?';
    const bias = data.bias || '?';
    const zone = data.zone || '?';
    const score = data.score || '?';
    const maxscore = data.maxscore || '7';
    const biasDir = data.bias_dir || '?';
    const biasStr = data.bias_str || '?';
    const oprSweep = data.opr_sweep && data.opr_sweep !== 'NONE' && data.opr_sweep !== 'non' && data.opr_sweep !== 'false';

    let msg = `${emoji} *${dir} ${pair} ${tf}* — Score ${score}/${maxscore}

Prix: \`${price}\`
Biais HTF: ${bias}
Zone: ${zone}
Bias: ${biasDir} (${biasStr}/4)`;

    if (oprSweep) {
        msg += `\n\u{1F534} OPR Sweep actif`;
    }

    msg += `\n\n⚠️ _Analyse Claude indisponible — signal brut_`;
    return msg;
}

// Surveillance : HTF Flip
function formatHTFFlip(data) {
    const pair = data.pair || '?';
    const newDir = data.new_dir || data.direction || data.bias || '?';
    const price = data.price || '?';
    const tf = data.tf || '?';

    return `\u{1F504} *SURVEILLANCE — HTF FLIP*

Paire: *${pair}* (${tf})
Nouveau biais: *${newDir}*
Prix: \`${price}\`

_Changement de direction HTF détecté — vérifier les setups_`;
}

// Surveillance : Bias Fort
function formatBiasFort(data) {
    const pair = data.pair || '?';
    const biasDir = data.bias_dir || data.direction || '?';
    const biasStr = data.bias_str || data.strength || '?';
    const price = data.price || '?';

    return `\u{1F525} *SURVEILLANCE — BIAS FORT*

Paire: *${pair}*
Direction: *${biasDir}*
Force: *${biasStr}/4* confluences
Prix: \`${price}\`

_Bias fort détecté — chercher entrée alignée_`;
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
            status: 'Oki Alerts V3.2 actif — Fusion compatible',
            version: '3.2',
            scoring: '7/7 (Fusion) — min 4/7, grading A+ A B C D, TP/SL adaptatif OB freshness',
            filtres: 'HTF/Bias/BiasDir/Struct/Zone/Score(4+) + XAUUSD only',
            surveillance: 'HTF Flip + Bias Fort',
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
                const alertType = getAlertType(data);
                const dir = data.signal || data.dir || '?';
                const pair = data.pair || '?';
                const score = data.score || '?';
                const maxscore = data.maxscore || '7';

                console.log(`[${new Date().toISOString()}] Type: ${alertType} | ${dir} ${pair} Score ${score}/${maxscore}`);

                // ── ALERTES SURVEILLANCE (pas de filtre, pas de Claude, envoi direct) ──
                if (alertType === 'htf_flip') {
                    const msg = formatHTFFlip(data);
                    await sendTelegram(msg);
                    console.log('Surveillance HTF Flip envoyee');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, type: 'htf_flip' }));
                    return;
                }

                if (alertType === 'bias_fort') {
                    const msg = formatBiasFort(data);
                    await sendTelegram(msg);
                    console.log('Surveillance Bias Fort envoyee');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, type: 'bias_fort' }));
                    return;
                }

                // ── FILTRE DUR V3.2 ──
                const filter = hardFilter(data);
                if (filter.blocked) {
                    console.log(`[BLOQUÉ] ${filter.reason}`);

                    if (filter.reason.includes('ignorée')) {
                        console.log('Paire ignorée — pas de notification Telegram');
                    } else {
                        await sendTelegram(formatBlocked(filter.reason, data));
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, version: 'v3.2', blocked: true, reason: filter.reason }));
                    return;
                }

                // ── ANALYSE CLAUDE (signal a passé le filtre dur) ──
                if (ANTHROPIC_API_KEY) {
                    console.log(`Signal validé par filtre dur (${score}/${maxscore}) — analyse Claude en cours...`);
                    const analysis = await callClaude(data);

                    if (analysis) {
                        const verdictMsg = formatVerdict(analysis, data);
                        await sendTelegram(verdictMsg);
                        const isGO = analysis.includes('VERDICT: GO') && !analysis.includes('NO GO');
                        console.log('Verdict envoyé:', isGO ? 'GO' : 'NO GO');
                    } else {
                        const fallbackMsg = formatFallback(data);
                        await sendTelegram(fallbackMsg);
                        console.log('Fallback envoyé (Claude indisponible)');
                    }
                } else {
                    const rawMsg = formatFallback(data);
                    await sendTelegram(rawMsg);
                    console.log('Mode brut (pas de clé Claude)');
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, version: 'v3.2' }));
            } catch (err) {
                console.error('Erreur:', err.message);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: err.message }));
            }
        });
        return;
    }

    // Test signal Fusion
    if (req.method === 'GET' && req.url === '/test') {
        const testData = {
            signal: 'BUY',
            pair: 'XAUUSD',
            tf: '15',
            price: '2650.50',
            bias: 'BULLISH',
            zone: 'DISCOUNT',
            score: '6',
            maxscore: '7',
            struct: 'BULL',
            kz: 'NEW_YORK',
            rsi: '42',
            ob_actifs: '3',
            ob_testes: '1',
            ob_fresh: '85',
            ob_retests: '0',
            bias_dir: 'BULL',
            bias_str: '3',
            opr_sweep: 'LOW',
            atr: '12.50',
            sl: '2635.50',
            tp1: '2688.00',
            tp2: '2706.50',
            tp_mode: 'STANDARD'
        };

        console.log('[TEST] Simulation signal Fusion BUY XAUUSD 6/7...');

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

    // Test surveillance
    if (req.method === 'GET' && req.url === '/test-surv') {
        console.log('[TEST] Simulation alertes surveillance...');
        try {
            // Test format Fusion (direction au lieu de new_dir/bias_dir)
            await sendTelegram(formatHTFFlip({
                signal: 'SURVEILLANCE', type: 'HTF_FLIP',
                pair: 'XAUUSD', direction: 'BEAR', price: '2600.00', tf: 'H1'
            }));
            await sendTelegram(formatBiasFort({
                signal: 'SURVEILLANCE', type: 'BIAS_FORT',
                pair: 'XAUUSD', direction: 'BULL', strength: '3/4', price: '2580.00'
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, test: 'surveillance' }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
    }

    // Test filtre seul
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
    console.log('  OKI ALERTS V3.2 — Fusion Compatible (TP/SL adaptatif)');
    console.log('========================================');
    console.log(`Port: ${PORT}`);
    console.log(`Scoring: 7/7 (Fusion) — min 4/7, grading A+/A/B/C/D`);
    console.log(`Claude API: ${ANTHROPIC_API_KEY ? 'OK' : 'PAS CONFIGURE'}`);
    console.log(`Telegram: ${TELEGRAM_BOT_TOKEN !== 'TON_TOKEN_ICI' ? 'OK' : 'PAS CONFIGURE'}`);
    console.log(`Paires: ${ALLOWED_PAIRS.join(', ')}`);
    console.log('Filtres:');
    console.log('  - Paire autorisée uniquement');
    console.log('  - Score minimum 4/7 (Fusion) ou 3/5 (legacy)');
    console.log('  - HTF Bias + Bias Dir alignés');
    console.log('  - Structure/Trend alignée');
    console.log('  - Zone Premium/Discount correcte');
    console.log('Surveillance:');
    console.log('  - HTF Flip (changement direction)');
    console.log('  - Bias Fort (3+/4 confluences)');
    console.log('Endpoints:');
    console.log('  GET  /           -> Health check');
    console.log('  POST /webhook    -> Signal TradingView');
    console.log('  GET  /test       -> Test signal Fusion');
    console.log('  GET  /test-surv  -> Test surveillance');
    console.log('  POST /test-filter -> Test filtre seul');
    console.log('========================================');
});
