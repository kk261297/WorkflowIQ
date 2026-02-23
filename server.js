const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const { searchCases } = require('./src/search');
const { getCaseHTML, downloadCase, downloadMultipleCases, DOWNLOADS_DIR } = require('./src/download');
const { summarizeAll, rankByRelevance, chat } = require('./src/analyzer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory state
let cachedSummaries = null;
let chatHistory = [];
let analyzedCases = [];

// ──────────────────────── Search API ────────────────────────

app.post('/api/search', async (req, res) => {
    try {
        const { query, page = 1, pageSize = 20, sortby = 'relevance', filter = {} } = req.body;
        if (!query) return res.status(400).json({ error: 'Search query is required' });

        const results = await searchCases(query, { page, pageSize, sortby, filter });
        res.json(results);
    } catch (err) {
        console.error('Search error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────── Case Preview ────────────────────────

app.get('/api/case/:id/preview', async (req, res) => {
    try {
        const doc = await getCaseHTML(req.params.id);
        res.json({
            id: req.params.id,
            html: doc.htmlContent,
            textLength: doc.htmlContent.replace(/<[^>]*>/g, '').length
        });
    } catch (err) {
        console.error('Preview error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────── Download ────────────────────────

app.post('/api/download', async (req, res) => {
    try {
        const { caseId, title } = req.body;
        if (!caseId) return res.status(400).json({ error: 'caseId is required' });

        const result = await downloadCase(caseId, title || caseId);
        res.json(result);
    } catch (err) {
        console.error('Download error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────── ANALYZE: Search → Fetch Text → Summarize → Rank ────────────────────────

app.post('/api/analyze', async (req, res) => {
    try {
        const { keywords, context, count = 100 } = req.body;
        if (!keywords) return res.status(400).json({ error: 'keywords is required' });
        if (!context) return res.status(400).json({ error: 'context is required' });

        // Stream updates via SSE-like newline-delimited JSON
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Transfer-Encoding', 'chunked');

        const send = (data) => res.write(JSON.stringify(data) + '\n');

        // Step 1: Search (Centax API caps at 20/page, so paginate)
        send({ step: 'search', message: `Searching for "${keywords}"...` });
        const PAGE_SIZE = 20;
        const totalPages = Math.ceil(count / PAGE_SIZE);
        let cases = [];
        let totalCount = 0;

        for (let p = 1; p <= totalPages; p++) {
            const searchResult = await searchCases(keywords, { page: p, pageSize: PAGE_SIZE, sortby: 'relevance' });
            totalCount = searchResult.totalCount;
            cases.push(...searchResult.results);
            send({ step: 'search', message: `Searching... page ${p}/${totalPages} (${cases.length} cases so far)` });
            if (cases.length >= count || cases.length >= totalCount) break;
            await new Promise(r => setTimeout(r, 300));
        }

        cases = cases.slice(0, count);
        send({ step: 'search_done', message: `Analyzing top ${cases.length} cases.`, total: cases.length });

        if (cases.length === 0) {
            send({ step: 'error', message: 'No results found. Try different keywords.' });
            return res.end();
        }

        // Step 2: Fetch case texts (directly via API — no PDF needed)
        send({ step: 'fetch', message: `Reading case texts (0/${cases.length})...` });
        const caseTexts = [];

        for (let i = 0; i < cases.length; i++) {
            try {
                const doc = await getCaseHTML(cases[i].id);
                const plainText = doc.htmlContent.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
                caseTexts.push({
                    id: cases[i].id,
                    filename: cases[i].heading || cases[i].id,
                    heading: cases[i].heading,
                    court: cases[i].court,
                    date: cases[i].date,
                    text: plainText,
                });
                if ((i + 1) % 5 === 0 || i === cases.length - 1) {
                    send({ step: 'fetch_progress', message: `Reading case texts (${i + 1}/${cases.length})...`, progress: i + 1 });
                }
            } catch (err) {
                console.error(`  Skip case ${cases[i].id}: ${err.message}`);
            }
            // Small delay to avoid rate limiting
            if (i < cases.length - 1) {
                await new Promise(r => setTimeout(r, 300));
            }
        }

        send({ step: 'fetch_done', message: `Read ${caseTexts.length} case texts. Summarizing...` });

        // Step 3: Summarize all cases via OpenAI (with caching)
        send({ step: 'summarize', message: `Summarizing ${caseTexts.length} cases via AI (cached summaries skip instantly)...` });
        const allSummaries = await summarizeAll(caseTexts);

        // Filter to only include summaries for THIS search's cases
        const currentIds = new Set(caseTexts.map(c => c.id));
        const currentSummaries = {};
        for (const [id, val] of Object.entries(allSummaries)) {
            if (currentIds.has(id)) {
                currentSummaries[id] = val;
            }
        }
        cachedSummaries = currentSummaries;
        const totalAnalyzed = Object.keys(currentSummaries).length;
        send({ step: 'summarize_done', message: `All ${totalAnalyzed} cases summarized.` });

        // Step 4: Rank by relevance
        send({ step: 'rank', message: `Ranking ${totalAnalyzed} cases by relevance to your situation...` });
        const rankResult = await rankByRelevance(currentSummaries, context);

        // Enrich rankings with case metadata
        if (rankResult.rankings) {
            rankResult.rankings = rankResult.rankings.map(r => {
                const caseData = caseTexts.find(c => c.id === r.id) || cases.find(c => c.id === r.id);
                return {
                    ...r,
                    heading: caseData?.heading || r.filename,
                    court: caseData?.court || '',
                    date: caseData?.date || '',
                };
            });
        }

        // Store for follow-up chat
        chatHistory = [];
        chatHistory.push({ role: 'user', content: context });
        chatHistory.push({ role: 'assistant', content: JSON.stringify(rankResult) });
        analyzedCases = caseTexts;

        send({ step: 'done', message: 'Analysis complete!', data: rankResult, totalAnalyzed });
        res.end();
    } catch (err) {
        console.error('Analyze error:', err.message);
        res.write(JSON.stringify({ step: 'error', message: err.message }) + '\n');
        res.end();
    }
});

// ──────────────────────── AI Chat Follow-up ────────────────────────

app.post('/api/chat/message', async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.status(400).json({ error: 'message is required' });
        if (!cachedSummaries) return res.status(400).json({ error: 'Run analysis first' });

        const response = await chat(cachedSummaries, chatHistory, message);
        chatHistory.push({ role: 'user', content: message });
        chatHistory.push({ role: 'assistant', content: response });
        res.json({ type: 'chat', data: response });
    } catch (err) {
        console.error('Chat error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────── Downloaded files list ────────────────────────

app.get('/api/files', (req, res) => {
    try {
        const files = fs.readdirSync(DOWNLOADS_DIR)
            .filter(f => f.endsWith('.pdf'))
            .map(f => {
                const stats = fs.statSync(path.join(DOWNLOADS_DIR, f));
                const idMatch = f.match(/Case_(\d+)_/);
                return { filename: f, id: idMatch?.[1], size: stats.size };
            });
        res.json(files);
    } catch {
        res.json([]);
    }
});

// ──────────────────────── Serve UI ────────────────────────

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`\n🚀 WorkflowIQ Casebot running at http://localhost:${PORT}\n`);
});
