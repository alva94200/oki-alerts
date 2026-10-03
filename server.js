// ============================================================
// OKI ALERTS V4.0 — TradingView → Filtre + Claude AI → Telegram + Journal
// V4.0 : Trade Journal auto + Compatibilité OKI Fusion v2.0 (scoring /10)
// Nouveaux champs : fvg_conf, eql_sweep, delta, maxscore dynamique
// Endpoints : /journal (historique), /stats (win rate, sessions)
// Deploy sur Render.com (free tier)
// ============================================================

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================================
// CONFIG
// ============================================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'TON_TOKEN_ICI';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || 'TON_CHAT_ID_ICI';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const PORT = process.env.PORT || 3000;

const ALLOWED_PAIRS = ['XAUUSD', 'GOLD'];

// Journal file path (persiste sur Render dans /opt/render/project/src/)
const JOURNAL_FILE = process.env.JOURNAL_FILE || path.join(__dirname, 'trade-journal.json');

// ============================================================
// TRADE JOURNAL — Lecture / Écriture
// ============================================================
function readJournal() {
    try {
        if (fs.existsSync(JOURNAL_FILE)) {
            const raw = fs.readFileSync(JOURNAL_FILE, 'utf8');
            return JSON.parse(raw);
        }
    } catch (e) {
        console.error('Journal read error:', e.message);
    }
    return [];
}

function writeJournal(entries) {
    try {
        fs.writeFileSync(JOURNAL_FILE, JSON.stringify(entries, null, 2), 'utf8');
    } catch (e) {
        console.error('Journal write error:', e.message);
    }
}

function logTrade(data, verdict, blocked, blockReason) {
    const entries = readJournal();
    const entry = {
        id: entries.length + 1,
        timestamp: new Date().toISOString(),
        pair: data.pair || '?',
        tf: data.tf || '?',
        direction: (data.signal || data.dir || '?').toUpperCase(),
        price: parseFloat(data.price || data.entry) || 0,
        score: parseInt(data.score) || 0,
        maxscore: parseInt(data.maxscore) || 7,
        bias_htf: data.bias || '?',
        trend: data.struct || '?',
        zone: data.zone || '?',
        kz: data.kz || 'OFF',
        ob_fresh: parseInt(data.ob_fresh) || 0,
        bias_dir: data.bias_dir || '?',
        bias_str: parseInt(data.bias_str) || 0,
        opr_sweep: data.opr_sweep || 'non',
        atr: parseFloat(data.atr) || 0,
        // V2.0 fields
        fvg_conf: data.fvg_conf || '?',
        eql_sweep: data.eql_sweep || 'non',
        delta: data.delta || '?',
        // Levels
        sl: data.sl || '?',
        tp1: data.tp1 || '?',
        tp2: data.tp2 || '?',
        rr: data.rr || '?',
        // Verdict
        verdict: verdict || 'N/A',
        blocked: blocked || false,
        block_reason: blockReason || '',
        // Result — rempli manuellement via /result
        result: 'PENDING',
        pnl: 0,
        notes: ''
    };
    entries.push(entry);
    writeJournal(entries);
    console.log(`[JOURNAL] Trade #${entry.id} logged: ${entry.direction} ${entry.pair} ${entry.score}/${entry.maxscore} — ${entry.verdict}`);
    return entry;
}

// ============================================================
// DETECTER TYPE D'ALERTE
// ============================================================
function getAlertType(data) {
    const sig = (data.signal || '').toUpperCase();
    const t = (data.alert_type || data.type || '').toLowerCase();

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
// FILTRE DUR V4.0 — Compatible v1.x (maxscore 7) et v2.0 (maxscore 10)
// ============================================================
function hardFilter(data) {
    const signal = (data.signal || data.dir || '').toUpperCase();
    const bias = (data.bias || '').toUpperCase();
    const zone = (data.zone || '').toUpperCase();
    const score = parseInt(data.score) || 0;
    const maxscore = parseInt(data.maxscore) || 7;
    const struct = (data.struct || '').toUpperCase();
    const pair = (data.pair || '').toUpperCase();
    const biasDir = (data.bias_dir || '').toUpperCase();

    // 1. Filtre paire
    const pairAllowed = ALLOWED_PAIRS.some(p => pair.includes(p));
    if (!pairAllowed) {
        return { blocked: true, reason: `Paire ${pair} ignorée — XAUUSD uniquement` };
    }

    // 2. Score minimum dynamique
    //    v1.x (max 5): min 3 | v1.1 (max 7): min 4 | v2.0 (max 8-10): min 60%
    let minScore;
    if (maxscore <= 5) {
        minScore = 3;
    } else if (maxscore <= 7) {
        minScore = 4;
    } else {
        minScore = Math.ceil(maxscore * 0.6); // 60% du max — 6/10, 5/8, etc.
    }
    if (score < minScore) {
        return { blocked: true, reason: `Score ${score}/${maxscore} insuffisant (minimum ${minScore}/${maxscore})` };
    }

    // 3. HTF Bias opposé = NO GO
    if (signal === 'BUY' && (bias.includes('BEAR') || bias === 'BEARISH')) {
        return { blocked: true, reason: `BUY bloqué — HTF Bias BEARISH` };
    }
    if (signal === 'SELL' && (bias.includes('BULL') || bias === 'BULLISH')) {
        return { blocked: true, reason: `SELL bloqué — HTF Bias BULLISH` };
    }

    // 4. Bias directionnel opposé = NO GO
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
        return { blocked: true, reason: `BUY bloqué — zone PREMIUM` };
    }
    if (signal === 'SELL' && zone === 'DISCOUNT') {
        return { blocked: true, reason: `SELL bloqué — zone DISCOUNT` };
    }

    // 6. Structure opposée = NO GO
    if (signal === 'BUY' && struct === 'BEAR') {
        return { blocked: true, reason: `BUY bloqué — structure BEAR` };
    }
    if (signal === 'SELL' && struct === 'BULL') {
        return { blocked: true, reason: `SELL bloqué — structure BULL` };
    }

    return { blocked: false };
}

// ============================================================
// PROMPT SYSTEME V4.0 — Compatible OKI Fusion v2.0
// ============================================================
const SYSTEM_PROMPT = `Tu es Oki, un analyste trading SMC/ICT senior specialise sur le Gold (XAUUSD).

TON ROLE : analyser chaque signal OKI Fusion et donner un verdict GO ou NO GO.

LE SIGNAL PEUT CONTENIR JUSQU'A 10 CRITERES :
=== BASE (7 points) ===
1-5. SMC classiques : CHoCH/BOS, OB, FVG, Zone Premium/Discount, Kill Zone
6. Bias directionnel (PDH/PDL, Weekly Open, DXY, Liquidity Sweep) — force 0 a 4
7. OPR Sweep (NY Opening Range sweep detecte)

=== V2.0 MODULES (3 points bonus) ===
8. FVG Confluence — prix proche d'un FVG non rempli dans la direction du signal (+1)
9. EQL Pool — sweep de liquidite sur Equal Highs/Lows detecte (+1)
10. Delta Volume — pression directionnelle confirmee par le CVD approxime (+1)

Le maxscore est dynamique (7, 8, 9 ou 10 selon les modules actifs).

REGLES ABSOLUES :
1. HTF Bias DOIT etre aligne. Oppose = NO GO.
2. Bias directionnel DOIT etre aligne ou neutre. Oppose = NO GO.
3. Structure (trend) DOIT etre alignee. Oppose = NO GO.
4. BUY en discount UNIQUEMENT, SELL en premium UNIQUEMENT.
5. Kill Zone active = bonus. Hors KZ = prudence.
6. OPR Sweep actif = bonus fort en session NY.
7. FVG Confluence alignee = confluence supplementaire forte.
8. EQL Sweep = liquidite prise, mouvement probable.
9. Delta Volume aligne = confirmation de pression.

=== OB FRESHNESS ===
- OB 100% = zone vierge, haute probabilite.
- OB 80-99% = zone forte.
- OB 50-79% = zone affaiblie.
- OB < 50% = zone epuisee, prudence.

SL adaptatif selon OB Freshness :
  OB 100% : SL = ATR x 1.2
  OB 80-99% : SL = ATR x 1.5
  OB 50-79% : SL = ATR x 1.8
  OB < 50% : SL = ATR x 2.0

TP adaptatif selon le SCORE (normalise sur le maxscore) :
  Score < 60% : TP1 = 1.5R | TP2 = 2.1R
  Score 60-70% : TP1 = 2.0R | TP2 = 3.1R
  Score 70-85% : TP1 = 2.5R | TP2 = 4.1R
  Score 85%+ : TP1 = 3.0R | TP2 = 5.1R

INTERDIT :
- GO avec reserve ("malgre", "cependant")
- Si tu hesites = NO GO
- Plus de 0.01 lot. TOUJOURS 0.01.

FORMAT (strict) :
VERDICT: GO ou NO GO
GRADE: A+, A, B, C ou D
CONFIANCE: 1 a 5 etoiles
RAISON: une phrase max
ENTREE: prix exact
SL: prix
TP1: prix
TP2: prix
R:R: ratio

GRADING :
- A+ : Score 85%+, bias fort, OPR, OB 80%+, modules v2.0 alignes
- A  : Score 70-85%, bias aligne, KZ active, OB 80%+
- B  : Score 60-70%, conditions correctes, OB 60%+
- C  : Score ~60%, OB 80%+ ET (KZ ou bias aligne)
- D  : Score bas ou confluences manquantes — NO GO

Reponds UNIQUEMENT dans ce format.`;

// ============================================================
// APPELER CLAUDE API
// ============================================================
function callClaude(signalData) {
    const maxscore = signalData.maxscore || '7';
    const scorePct = Math.round((parseInt(signalData.score) / parseInt(maxscore)) * 100);

    let v2Info = '';
    if (parseInt(maxscore) > 7) {
        v2Info = `\n--- MODULES V2.0 ---
- FVG Confluence : ${signalData.fvg_conf || 'N/A'}
- EQL Sweep : ${signalData.eql_sweep || 'non'}
- Delta Volume : ${signalData.delta || 'N/A'}`;
    }

    const userMessage = `Signal OKI Fusion recu :
- Direction : ${signalData.signal || signalData.dir || '?'}
- Paire : ${signalData.pair || '?'}
- Timeframe : ${signalData.tf || '?'}
- Prix actuel : ${signalData.price || signalData.entry || '?'}
- Biais HTF : ${signalData.bias || '?'}
- Zone : ${signalData.zone || '?'}
- Score : ${signalData.score || '?'}/${maxscore} (${scorePct}%)
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
${v2Info}
- SL pre-calcule : ${signalData.sl || '?'}
- TP1 pre-calcule : ${signalData.tp1 || '?'}
- TP2 pre-calcule : ${signalData.tp2 || '?'}
- R:R max : ${signalData.rr || '?'}

Analyse ce signal. Donne ton verdict.`;

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
// FORMATER MESSAGES TELEGRAM
// ============================================================
function formatVerdict(analysis, data) {
    const dir = data.signal || data.dir || '?';
    const pair = data.pair || '?';
    const tf = data.tf || '?';
    const maxscore = data.maxscore || '7';
    const score = data.score || '?';
    const biasStr = data.bias_str || '?';

    const isGO = analysis.includes('VERDICT: GO') && !analysis.includes('NO GO');
    const verdictEmoji = isGO ? '✅' : '❌';
    const verdictText = isGO ? 'GO' : 'NO GO';

    let grade = '';
    const gradeMatch = analysis.match(/GRADE:\s*(A\+|A|B|C|D)/i);
    if (gradeMatch) grade = ` [${gradeMatch[1]}]`;

    const oprSweep = data.opr_sweep && data.opr_sweep !== 'NONE' && data.opr_sweep !== 'non' && data.opr_sweep !== 'false';
    const oprBadge = oprSweep ? ' 🔴OPR' : '';

    const obFresh = parseInt(data.ob_fresh) || 0;
    let freshBadge = '';
    if (obFresh >= 100) freshBadge = ' 💎OB100%';
    else if (obFresh >= 80) freshBadge = ' 🟢OB' + obFresh + '%';
    else if (obFresh >= 50) freshBadge = ' 🟡OB' + obFresh + '%';
    else if (obFresh > 0) freshBadge = ' 🔴OB' + obFresh + '%';

    const rr = data.rr || '';
    const rrBadge = rr ? ` | ${rr}R` : '';

    // V2.0 badges
    let v2Badges = '';
    if (parseInt(maxscore) > 7) {
        const fvg = (data.fvg_conf || '').toUpperCase();
        const eql = (data.eql_sweep || '').toLowerCase();
        const delta = (data.delta || '').toUpperCase();
        if (fvg === 'BULL' || fvg === 'BEAR') v2Badges += ' 📐FVG';
        if (eql !== 'non' && eql !== '' && eql !== '?') v2Badges += ' 💰EQL';
        if (delta.includes('BULL') || delta.includes('BEAR')) v2Badges += ' 📊ΔV';
    }

    return `${verdictEmoji} *OKI VERDICT: ${verdictText}${grade}*${oprBadge}${freshBadge}${v2Badges}${rrBadge}

${analysis}

_Signal: ${dir} ${pair} ${tf} | Score ${score}/${maxscore} | Bias ${biasStr}/4_`;
}

function formatBlocked(reason, data) {
    const dir = data.signal || data.dir || '?';
    const pair = data.pair || '?';
    const tf = data.tf || '?';
    const score = data.score || '?';
    const maxscore = data.maxscore || '7';

    return `🚫 *SIGNAL BLOQUÉ*

${reason}

_Signal: ${dir} ${pair} ${tf} — Score ${score}/${maxscore}_
_Filtre V4.0 actif — signal rejeté avant analyse Claude_`;
}

function formatFallback(data) {
    const dir = data.signal || data.dir || '?';
    const emoji = dir === 'BUY' ? '🟢' : '🔴';
    const pair = data.pair || '?';
    const tf = data.tf || '?';
    const price = data.price || data.entry || '?';
    const bias = data.bias || '?';
    const zone = data.zone || '?';
    const score = data.score || '?';
    const maxscore = data.maxscore || '7';

    return `${emoji} *${dir} ${pair} ${tf}* — Score ${score}/${maxscore}

Prix: \`${price}\`
Biais HTF: ${bias}
Zone: ${zone}

⚠️ _Analyse Claude indisponible — signal brut_`;
}

function formatHTFFlip(data) {
    const pair = data.pair || '?';
    const newDir = data.new_dir || data.direction || data.bias || '?';
    const price = data.price || '?';
    const tf = data.tf || '?';

    return `🔄 *SURVEILLANCE — HTF FLIP*

Paire: *${pair}* (${tf})
Nouveau biais: *${newDir}*
Prix: \`${price}\`

_Changement de direction HTF détecté_`;
}

function formatBiasFort(data) {
    const pair = data.pair || '?';
    const biasDir = data.bias_dir || data.direction || '?';
    const biasStr = data.bias_str || data.strength || '?';
    const price = data.price || '?';

    return `🔥 *SURVEILLANCE — BIAS FORT*

Paire: *${pair}*
Direction: *${biasDir}*
Force: *${biasStr}/4*
Prix: \`${price}\`

_Bias fort détecté — chercher entrée alignée_`;
}

// ============================================================
// ENVOYER TELEGRAM
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
// CALCUL STATS
// ============================================================
function computeStats(entries) {
    const total = entries.length;
    const signals = entries.filter(e => !e.blocked);
    const blocked = entries.filter(e => e.blocked);
    const go = signals.filter(e => e.verdict.includes('GO') && !e.verdict.includes('NO GO'));
    const noGo = signals.filter(e => e.verdict.includes('NO GO'));

    const wins = entries.filter(e => e.result === 'WIN');
    const losses = entries.filter(e => e.result === 'LOSS');
    const be = entries.filter(e => e.result === 'BE');
    const pending = entries.filter(e => e.result === 'PENDING');

    const winRate = (wins.length + losses.length) > 0
        ? Math.round(wins.length / (wins.length + losses.length) * 100) : 0;

    const totalPnl = entries.reduce((sum, e) => sum + (e.pnl || 0), 0);

    // Stats par session (KZ)
    const byKZ = {};
    entries.forEach(e => {
        const kz = e.kz || 'UNKNOWN';
        if (!byKZ[kz]) byKZ[kz] = { total: 0, wins: 0, losses: 0 };
        byKZ[kz].total++;
        if (e.result === 'WIN') byKZ[kz].wins++;
        if (e.result === 'LOSS') byKZ[kz].losses++;
    });

    // Stats par direction
    const byDir = {};
    entries.forEach(e => {
        const dir = e.direction || '?';
        if (!byDir[dir]) byDir[dir] = { total: 0, wins: 0, losses: 0 };
        byDir[dir].total++;
        if (e.result === 'WIN') byDir[dir].wins++;
        if (e.result === 'LOSS') byDir[dir].losses++;
    });

    // Stats par jour de semaine
    const byDay = {};
    entries.forEach(e => {
        const d = new Date(e.timestamp);
        const day = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'][d.getDay()];
        if (!byDay[day]) byDay[day] = { total: 0, wins: 0, losses: 0 };
        byDay[day].total++;
        if (e.result === 'WIN') byDay[day].wins++;
        if (e.result === 'LOSS') byDay[day].losses++;
    });

    // Score moyen winners vs losers
    const avgScoreWin = wins.length > 0
        ? Math.round(wins.reduce((s, e) => s + (e.score / e.maxscore * 100), 0) / wins.length) : 0;
    const avgScoreLoss = losses.length > 0
        ? Math.round(losses.reduce((s, e) => s + (e.score / e.maxscore * 100), 0) / losses.length) : 0;

    return {
        total,
        blocked: blocked.length,
        signals: signals.length,
        go: go.length,
        noGo: noGo.length,
        wins: wins.length,
        losses: losses.length,
        be: be.length,
        pending: pending.length,
        winRate,
        totalPnl: Math.round(totalPnl * 100) / 100,
        avgScoreWin,
        avgScoreLoss,
        byKZ,
        byDir,
        byDay
    };
}

// ============================================================
// SERVEUR HTTP
// ============================================================
const server = http.createServer(async (req, res) => {

    // ── Health check ──
    if (req.method === 'GET' && req.url === '/') {
        const journal = readJournal();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'Oki Alerts V4.0 actif — Fusion v2.0 + Trade Journal',
            version: '4.0',
            scoring: 'Dynamique /7 /8 /9 /10 — min 60%',
            modules_v2: 'FVG Confluence, EQL Pool, Delta Volume',
            journal_entries: journal.length,
            claude: ANTHROPIC_API_KEY ? 'configuré' : 'PAS CONFIGURE',
            telegram: TELEGRAM_BOT_TOKEN !== 'TON_TOKEN_ICI' ? 'configuré' : 'PAS CONFIGURE'
        }));
        return;
    }

    // ── JOURNAL — Consulter l'historique ──
    if (req.method === 'GET' && req.url.startsWith('/journal')) {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        const last = parseInt(url.searchParams.get('last')) || 20;
        const dir = (url.searchParams.get('dir') || '').toUpperCase();
        const result = (url.searchParams.get('result') || '').toUpperCase();

        let entries = readJournal();

        // Filtres optionnels
        if (dir) entries = entries.filter(e => e.direction === dir);
        if (result) entries = entries.filter(e => e.result === result);

        // Derniers N
        entries = entries.slice(-last);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ok: true,
            total: readJournal().length,
            showing: entries.length,
            filters: { last, dir: dir || 'all', result: result || 'all' },
            entries
        }, null, 2));
        return;
    }

    // ── STATS — Win rate, sessions, etc. ──
    if (req.method === 'GET' && req.url.startsWith('/stats')) {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        const days = parseInt(url.searchParams.get('days')) || 0; // 0 = tout

        let entries = readJournal();

        if (days > 0) {
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - days);
            entries = entries.filter(e => new Date(e.timestamp) >= cutoff);
        }

        const stats = computeStats(entries);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ok: true,
            period: days > 0 ? `${days} derniers jours` : 'tout',
            stats
        }, null, 2));
        return;
    }

    // ── RESULT — Enregistrer le résultat d'un trade ──
    if (req.method === 'POST' && req.url === '/result') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { id, result, pnl, notes } = JSON.parse(body);
                if (!id || !result) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'id et result requis (WIN/LOSS/BE)' }));
                    return;
                }

                const entries = readJournal();
                const entry = entries.find(e => e.id === id);
                if (!entry) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: `Trade #${id} non trouvé` }));
                    return;
                }

                entry.result = result.toUpperCase();
                if (pnl !== undefined) entry.pnl = parseFloat(pnl) || 0;
                if (notes) entry.notes = notes;

                writeJournal(entries);
                console.log(`[JOURNAL] Trade #${id} → ${entry.result} (${entry.pnl}€)`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, updated: entry }));
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: err.message }));
            }
        });
        return;
    }

    // ── RAPPORT TELEGRAM — Envoie les stats sur Telegram ──
    if (req.method === 'GET' && req.url.startsWith('/report')) {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        const days = parseInt(url.searchParams.get('days')) || 7;

        let entries = readJournal();
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        entries = entries.filter(e => new Date(e.timestamp) >= cutoff);

        const stats = computeStats(entries);

        const msg = `📊 *OKI RAPPORT — ${days} derniers jours*

Signaux totaux: *${stats.total}*
├ Bloqués par filtre: ${stats.blocked}
├ Analysés: ${stats.signals}
├ GO: ${stats.go} | NO GO: ${stats.noGo}

*Résultats:*
├ ✅ Wins: ${stats.wins}
├ ❌ Losses: ${stats.losses}
├ ➖ BE: ${stats.be}
├ ⏳ Pending: ${stats.pending}
├ 📈 Win Rate: *${stats.winRate}%*
├ 💰 P&L: *${stats.totalPnl}€*

*Score moyen:*
├ Winners: ${stats.avgScoreWin}%
├ Losers: ${stats.avgScoreLoss}%

_Rapport OKI V4.0 — ${new Date().toISOString().split('T')[0]}_`;

        try {
            await sendTelegram(msg);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, report: 'sent', days, stats }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
    }

    // ── Webhook TradingView ──
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

                // ── Surveillance ──
                if (alertType === 'htf_flip') {
                    await sendTelegram(formatHTFFlip(data));
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, type: 'htf_flip' }));
                    return;
                }
                if (alertType === 'bias_fort') {
                    await sendTelegram(formatBiasFort(data));
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, type: 'bias_fort' }));
                    return;
                }

                // ── Filtre dur V4.0 ──
                const filter = hardFilter(data);
                if (filter.blocked) {
                    console.log(`[BLOQUÉ] ${filter.reason}`);

                    // Log dans journal même si bloqué
                    logTrade(data, 'BLOCKED', true, filter.reason);

                    if (!filter.reason.includes('ignorée')) {
                        await sendTelegram(formatBlocked(filter.reason, data));
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, version: 'v4.0', blocked: true, reason: filter.reason }));
                    return;
                }

                // ── Analyse Claude ──
                let verdict = 'FALLBACK';
                if (ANTHROPIC_API_KEY) {
                    console.log(`Signal validé (${score}/${maxscore}) — analyse Claude...`);
                    const analysis = await callClaude(data);

                    if (analysis) {
                        const isGO = analysis.includes('VERDICT: GO') && !analysis.includes('NO GO');
                        verdict = isGO ? 'GO' : 'NO GO';
                        await sendTelegram(formatVerdict(analysis, data));
                        console.log('Verdict:', verdict);
                    } else {
                        await sendTelegram(formatFallback(data));
                        console.log('Fallback (Claude indisponible)');
                    }
                } else {
                    await sendTelegram(formatFallback(data));
                    console.log('Mode brut (pas de clé Claude)');
                }

                // Log dans journal
                logTrade(data, verdict, false, '');

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, version: 'v4.0', verdict }));
            } catch (err) {
                console.error('Erreur:', err.message);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: err.message }));
            }
        });
        return;
    }

    // ── Test signal ──
    if (req.method === 'GET' && req.url === '/test') {
        const testData = {
            signal: 'BUY', pair: 'XAUUSD', tf: '15', price: '2650.50',
            bias: 'BULLISH', zone: 'DISCOUNT', score: '8', maxscore: '10',
            struct: 'BULL', kz: 'NEW_YORK', rsi: '42',
            ob_actifs: '3', ob_testes: '1', ob_fresh: '85', ob_retests: '0',
            bias_dir: 'BULL', bias_str: '3', opr_sweep: 'LOW', atr: '12.50',
            fvg_conf: 'BULL', eql_sweep: 'HIGH', delta: 'BULL 15.2K',
            sl: '2635.50', tp1: '2688.00', tp2: '2706.50', rr: '4.1'
        };

        console.log('[TEST] Simulation signal Fusion v2.0 BUY XAUUSD 8/10...');
        const filter = hardFilter(testData);
        if (filter.blocked) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, test: true, blocked: true, reason: filter.reason }));
            return;
        }

        try {
            if (ANTHROPIC_API_KEY) {
                const analysis = await callClaude(testData);
                if (analysis) {
                    logTrade(testData, analysis.includes('NO GO') ? 'NO GO' : 'GO', false, '');
                    await sendTelegram(formatVerdict(analysis, testData));
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, test: true, analysis }));
                    return;
                }
            }
            logTrade(testData, 'FALLBACK', false, '');
            await sendTelegram(formatFallback(testData));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, test: true, fallback: true }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
    }

    // ── Test surveillance ──
    if (req.method === 'GET' && req.url === '/test-surv') {
        try {
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

    // ── Test filtre seul ──
    if (req.method === 'POST' && req.url === '/test-filter') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const filter = hardFilter(data);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, ...filter }));
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
    const journal = readJournal();
    console.log('========================================');
    console.log('  OKI ALERTS V4.0 — Fusion v2.0 + Trade Journal');
    console.log('========================================');
    console.log(`Port: ${PORT}`);
    console.log(`Scoring: Dynamique /7 /8 /9 /10 — min 60%`);
    console.log(`Claude API: ${ANTHROPIC_API_KEY ? 'OK' : 'PAS CONFIGURE'}`);
    console.log(`Telegram: ${TELEGRAM_BOT_TOKEN !== 'TON_TOKEN_ICI' ? 'OK' : 'PAS CONFIGURE'}`);
    console.log(`Journal: ${journal.length} trades enregistrés`);
    console.log('Endpoints:');
    console.log('  GET  /           -> Health check');
    console.log('  POST /webhook    -> Signal TradingView');
    console.log('  GET  /journal    -> Historique (?last=20&dir=BUY&result=WIN)');
    console.log('  GET  /stats      -> Statistiques (?days=7)');
    console.log('  POST /result     -> Résultat trade {id, result, pnl, notes}');
    console.log('  GET  /report     -> Rapport Telegram (?days=7)');
    console.log('  GET  /test       -> Test signal v2.0');
    console.log('  GET  /test-surv  -> Test surveillance');
    console.log('  POST /test-filter -> Test filtre seul');
    console.log('========================================');
});
