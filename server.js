const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const { searchCases } = require('./src/search');
const { getCaseHTML, downloadCase, downloadMultipleCases, DOWNLOADS_DIR } = require('./src/download');
const { summarizeAll, rankByRelevance, chat, getFilterSuggestions } = require('./src/analyzer');

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

// ──────────────────────── REFINE: Generate smart filter questions ────────────────────────

app.post('/api/refine', async (req, res) => {
    try {
        const { keywords, context } = req.body;
        if (!keywords) return res.status(400).json({ error: 'keywords is required' });
        if (!context) return res.status(400).json({ error: 'context is required' });

        console.log(`🧠 Generating filter suggestions for: "${keywords}"`);
        const suggested = await getFilterSuggestions(keywords, context);
        console.log(`✅ Generated suggestions:`, suggested);
        res.json({ suggested });
    } catch (err) {
        console.error('Refine error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────── ANALYZE: Search → Fetch Text → Summarize → Rank ────────────────────────

app.post('/api/analyze', async (req, res) => {
    try {
        const { keywords, context, count = 100, filters = {} } = req.body;
        if (!keywords) return res.status(400).json({ error: 'keywords is required' });
        if (!context) return res.status(400).json({ error: 'context is required' });

        // Map user-selected filters to Centax API filter format
        // Centax uses internal numeric IDs for module/docType filters
        const MODULE_IDS = {
            'GST': '111050000000018400',
            'Customs': '111050000000018392',
            'Excise & Service Tax': '111050000000018393',
            'Foreign Trade Policy': '111050000000018795'
        };
        const DOCTYPE_IDS = {
            'Case Laws': '111050000000000060',
            'Notifications': '111050000000000110',
            'Acts': '111050000000000064',
            'Rules': '111050000000000026'
        };

        const COURT_IDS = {
            'Supreme Court': '111270000000000084',
            'High Court': '111270000000000083',
            'Tribunal': '111270000000000082',
            'Advance Ruling': '111270000000000085'
        };
        const ACT_IDS = {
            'Central Goods And Services Tax Act, 2017': '102010000000005574',
            'Integrated Goods and Services Tax Act, 2017': '102010000000005575',
            'Customs Act, 1962': '102010000000000032',
            'Central Excise Act, 1944': '102010000000000019',
            'Finance Act, 1994': '102010000000000037',
            'Uttar Pradesh Goods And Services Tax Act, 2017': '102010000000005638'
        };

        const apiFilter = {};

        if (filters.module && Array.isArray(filters.module) && filters.module.length > 0) {
            const mapped = filters.module.map(m => m === 'all' ? null : MODULE_IDS[m]).filter(Boolean);
            if (mapped.length > 0) apiFilter.categoryList = mapped;
        } else if (typeof filters.module === 'string' && filters.module !== 'all' && MODULE_IDS[filters.module]) {
            apiFilter.categoryList = [MODULE_IDS[filters.module]];
        }

        if (filters.docType && Array.isArray(filters.docType) && filters.docType.length > 0) {
            const mapped = filters.docType.map(d => d === 'all' ? null : DOCTYPE_IDS[d]).filter(Boolean);
            if (mapped.length > 0) apiFilter.groupList = mapped;
        } else if (typeof filters.docType === 'string' && filters.docType !== 'all' && DOCTYPE_IDS[filters.docType]) {
            apiFilter.groupList = [DOCTYPE_IDS[filters.docType]];
        }

        if (filters.court && Array.isArray(filters.court) && filters.court.length > 0) {
            const mapped = filters.court.map(c => c === 'all' ? null : COURT_IDS[c]).filter(Boolean);
            if (mapped.length > 0) apiFilter.courtList = mapped;
        } else if (typeof filters.court === 'string' && filters.court !== 'all' && COURT_IDS[filters.court]) {
            apiFilter.courtList = [COURT_IDS[filters.court]];
        }

        if (filters.act && Array.isArray(filters.act) && filters.act.length > 0) {
            const mapped = filters.act.map(a => (a === 'all' || a === 'not_sure') ? null : ACT_IDS[a]).filter(Boolean);
            if (mapped.length > 0) apiFilter.actList = mapped;
        } else if (typeof filters.act === 'string' && filters.act !== 'all' && filters.act !== 'not_sure' && ACT_IDS[filters.act]) {
            apiFilter.actList = [ACT_IDS[filters.act]];
        }

        // yearRange comes as array or string
        let yearRangeVal = Array.isArray(filters.yearRange) ? filters.yearRange[0] : filters.yearRange;
        if (yearRangeVal && yearRangeVal !== 'all_time') {
            const now = new Date();
            const yearsBack = yearRangeVal === 'last_1_year' ? 1 : yearRangeVal === 'last_3_years' ? 3 : 5;
            const fromDate = new Date(now.getFullYear() - yearsBack, now.getMonth(), now.getDate());
            apiFilter.decisionDateFrom = fromDate.toISOString().split('T')[0];
            apiFilter.decisionDateTo = now.toISOString().split('T')[0];
        }
        let headnoteOnlyVal = Array.isArray(filters.headnoteOnly) ? filters.headnoteOnly[0] : filters.headnoteOnly;
        const isHeadnoteOnly = headnoteOnlyVal === 'yes';

        const sortby = filters.sort || 'relevance';

        console.log('🔍 Filters received:', JSON.stringify(filters));
        console.log('🔍 API filter mapped:', JSON.stringify(apiFilter));
        console.log('🔍 Headnote only:', isHeadnoteOnly);

        // Stream updates via SSE-like newline-delimited JSON
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Transfer-Encoding', 'chunked');

        const send = (data) => res.write(JSON.stringify(data) + '\n');

        // Step 1: Search (Centax API caps at 20/page, so paginate)
        const hasFilters = Object.keys(apiFilter).length > 0 || isHeadnoteOnly;
        const appliedFilters = hasFilters ? ` with ${Object.keys(apiFilter).length + (isHeadnoteOnly ? 1 : 0)} filters` : '';
        send({ step: 'search', message: `Searching for "${keywords}"${appliedFilters}...` });
        const PAGE_SIZE = 20;
        let cases = [];
        let totalCount = 0;

        // Helper to run paginated search
        async function doSearch(filterObj, headnoteToggle) {
            const searchCases_ = [];
            const totalPgs = Math.ceil(count / PAGE_SIZE);
            let tc = 0;
            for (let p = 1; p <= totalPgs; p++) {
                const searchResult = await searchCases(keywords, {
                    page: p,
                    pageSize: PAGE_SIZE,
                    sortby,
                    filter: filterObj,
                    isheadnoteToggle: headnoteToggle
                });
                tc = searchResult.totalCount;
                searchCases_.push(...searchResult.results);
                send({ step: 'search', message: `Searching... page ${p}/${totalPgs} (${searchCases_.length} cases so far)` });
                if (searchCases_.length >= count || searchCases_.length >= tc) break;
                await new Promise(r => setTimeout(r, 300));
            }
            return { results: searchCases_, totalCount: tc };
        }

        // Run filtered search
        let searchData = await doSearch(apiFilter, isHeadnoteOnly);
        cases = searchData.results;
        totalCount = searchData.totalCount;

        // If filtered search returns 0 results, auto-retry without filters
        if (cases.length === 0 && hasFilters) {
            send({ step: 'search', message: '⚠️ Filters too restrictive — retrying without filters...' });
            searchData = await doSearch({}, false);
            cases = searchData.results;
            totalCount = searchData.totalCount;
        }

        cases = cases.slice(0, count);

        // Deduplicate cases by ID (API can return duplicates across pages)
        const seenIds = new Set();
        const uniqueCases = [];
        for (const c of cases) {
            if (!seenIds.has(c.id)) {
                seenIds.add(c.id);
                uniqueCases.push(c);
            }
        }
        if (uniqueCases.length < cases.length) {
            console.log(`⚠️ Removed ${cases.length - uniqueCases.length} duplicate case(s)`);
        }
        cases = uniqueCases;

        send({ step: 'search_done', message: `Analyzing top ${cases.length} cases.`, total: cases.length });

        if (cases.length === 0) {
            send({ step: 'error', message: 'No results found. Try different keywords.' });
            return res.end();
        }

        // Step 2: Fetch case texts (directly via API — no PDF needed)
        send({ step: 'fetch', message: `Reading case texts (0/${cases.length})...` });
        const caseTexts = [];
        let consecutiveFails = 0;

        for (let i = 0; i < cases.length; i++) {
            let success = false;
            let retries = 0;
            const MAX_RETRIES = 3;

            while (!success && retries < MAX_RETRIES) {
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
                    success = true;
                    consecutiveFails = 0;
                } catch (err) {
                    retries++;
                    const isRateLimit = err.message?.includes('409') || err.message?.includes('limit');
                    if (isRateLimit && retries < MAX_RETRIES) {
                        const backoff = Math.min(5000 * Math.pow(2, retries), 30000);
                        console.log(`  ⏳ Rate limited on case ${cases[i].id}, waiting ${backoff / 1000}s (retry ${retries}/${MAX_RETRIES})...`);
                        send({ step: 'fetch_progress', message: `Rate limited — pausing ${backoff / 1000}s, then retrying... (${caseTexts.length}/${cases.length} read)`, progress: caseTexts.length });
                        await new Promise(r => setTimeout(r, backoff));
                    } else {
                        console.error(`  Skip case ${cases[i].id}: ${err.message}`);
                        consecutiveFails++;
                        break;
                    }
                }
            }

            if ((caseTexts.length) % 5 === 0 || i === cases.length - 1) {
                send({ step: 'fetch_progress', message: `Reading case texts (${caseTexts.length}/${cases.length})...`, progress: caseTexts.length });
            }

            // If too many consecutive fails, the API is probably fully rate-limited — take a long break
            if (consecutiveFails >= 5) {
                console.log('  ⏳ Too many failures, pausing 30s to let rate limit reset...');
                send({ step: 'fetch_progress', message: `API rate limit hit — cooling down 30s... (${caseTexts.length} read so far)`, progress: caseTexts.length });
                await new Promise(r => setTimeout(r, 30000));
                consecutiveFails = 0;
            }

            // Base delay between requests (800ms to stay under rate limit)
            if (i < cases.length - 1) {
                await new Promise(r => setTimeout(r, 800));
            }

            // Extra cooldown pause every 30 cases
            if ((i + 1) % 30 === 0 && i < cases.length - 1) {
                console.log(`  ⏳ Cooldown pause after ${i + 1} cases (15s)...`);
                send({ step: 'fetch_progress', message: `Cooldown pause after ${i + 1} cases (15s)...`, progress: caseTexts.length });
                await new Promise(r => setTimeout(r, 15000));
            }
        }

        const skippedCount = cases.length - caseTexts.length;
        if (skippedCount > 0) {
            send({ step: 'fetch_done', message: `Read ${caseTexts.length} case texts (${skippedCount} case(s) could not be read). Summarizing...` });
            console.log(`⚠️ ${skippedCount} case(s) could not be fetched`);
        } else {
            send({ step: 'fetch_done', message: `Read ${caseTexts.length} case texts. Summarizing...` });
        }

        // Step 3: Summarize all cases via OpenAI (with caching)
        send({ step: 'summarize', message: `Summarizing ${caseTexts.length} cases via AI (cached summaries skip instantly)...` });
        const allSummaries = await summarizeAll(caseTexts, keywords, context);

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
                const summaryData = currentSummaries[r.id];
                return {
                    ...r,
                    heading: caseData?.heading || r.filename,
                    court: caseData?.court || '',
                    date: caseData?.date || '',
                    summary: summaryData?.summary || '',
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
