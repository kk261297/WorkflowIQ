const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SUMMARIES_FILE = path.join(__dirname, '..', 'downloads', 'summaries.json');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Summarize a single case using OpenAI
 */
async function summarizeCase(text, filename) {
    // Truncate very long texts to avoid token limits (keep first ~12K chars)
    const truncated = text.length > 12000 ? text.substring(0, 12000) + '\n...[truncated]' : text;

    const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            {
                role: 'system',
                content: `You are a legal analyst. Summarize the following Indian legal case in exactly 150-200 words. Include:
1. Case name and citation
2. Court and date
3. Key legal issue(s)
4. Facts in brief
5. Decision/Held
6. Key legal principle established

Be precise and factual. Focus on the legal substance.`
            },
            {
                role: 'user',
                content: truncated
            }
        ],
        temperature: 0.2,
        max_tokens: 400
    });

    return response.choices[0].message.content;
}

/**
 * Load cached summaries from disk
 */
function loadSummaries() {
    try {
        if (fs.existsSync(SUMMARIES_FILE)) {
            return JSON.parse(fs.readFileSync(SUMMARIES_FILE, 'utf-8'));
        }
    } catch { /* ignore */ }
    return {};
}

/**
 * Save summaries cache to disk
 */
function saveSummaries(summaries) {
    fs.writeFileSync(SUMMARIES_FILE, JSON.stringify(summaries, null, 2));
}

/**
 * Summarize all cases, using cache where available
 *
 * @param {Array<{filename, id, text}>} cases - Extracted PDF texts
 * @returns {Object} Map of id -> {filename, summary}
 */
async function summarizeAll(cases) {
    const cached = loadSummaries();
    let newCount = 0;

    console.log('🧠 Generating case summaries via OpenAI...\n');

    for (const c of cases) {
        if (cached[c.id]) {
            console.log(`  ⏭️  ${c.filename} (cached)`);
            continue;
        }

        try {
            console.log(`  🔄 Summarizing ${c.filename}...`);
            const summary = await summarizeCase(c.text, c.filename);
            cached[c.id] = { filename: c.filename, summary };
            newCount++;

            // Save after each to avoid losing progress
            saveSummaries(cached);

            // Brief delay to respect rate limits
            await new Promise(r => setTimeout(r, 500));
        } catch (err) {
            console.log(`  ❌ ${c.filename}: ${err.message}`);
        }
    }

    console.log(`\n✅ Summaries ready: ${Object.keys(cached).length} total (${newCount} new)\n`);
    return cached;
}

/**
 * Rank cases by relevance to user's described situation
 *
 * @param {Object} summaries - Map of id -> {filename, summary}
 * @param {string} userContext - User's case description
 * @returns {Array<{id, filename, score, reason}>} Ranked results
 */
async function rankByRelevance(summaries, userContext) {
    const ids = Object.keys(summaries);

    // Build the summaries block
    const summaryBlock = ids.map((id, i) => {
        const s = summaries[id];
        return `[Case ${i + 1}] ID: ${id}\nFile: ${s.filename}\n${s.summary}`;
    }).join('\n\n---\n\n');

    const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            {
                role: 'system',
                content: `You are an expert Indian legal research assistant. The user will describe their legal case or situation. You have summaries of multiple legal cases. Your task is to:

1. Analyze which cases are most relevant to the user's situation
2. Assign a relevancy score (0-100) to each case
3. Explain WHY each case is relevant or not relevant

Respond in this exact JSON format (no markdown, just raw JSON):
{
  "rankings": [
    {
      "case_number": 1,
      "id": "case_id",
      "filename": "filename.pdf",
      "score": 85,
      "reason": "Brief explanation of relevance"
    }
  ],
  "recommendation": "Brief overall recommendation for the user's case"
}

Sort rankings by score descending (most relevant first). Return ONLY the top 20 most relevant cases. Skip cases with score below 10.`
            },
            {
                role: 'user',
                content: `## My Legal Situation\n${userContext}\n\n## Available Cases\n${summaryBlock}`
            }
        ],
        temperature: 0.3,
        max_tokens: 8000
    });

    const content = response.choices[0].message.content;

    try {
        // Parse JSON (handle possible markdown wrapping)
        const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(jsonStr);
        return parsed;
    } catch {
        // If JSON parsing fails, return raw text
        return { raw: content, rankings: [] };
    }
}

/**
 * Chat with the analyzer (follow-up questions)
 *
 * @param {Object} summaries - Case summaries
 * @param {Array} history - Chat history
 * @param {string} userMessage - New user message
 */
async function chat(summaries, history, userMessage) {
    const ids = Object.keys(summaries);
    const summaryBlock = ids.map((id, i) => {
        const s = summaries[id];
        return `[Case ${i + 1}] ID: ${id} | ${s.filename}\n${s.summary}`;
    }).join('\n---\n');

    const systemMsg = {
        role: 'system',
        content: `You are an expert Indian legal research assistant. You have access to summaries of ${ids.length} legal cases. Help the user find the most relevant cases for their situation. Always provide relevancy scores (0-100) when ranking cases.

## Available Cases:
${summaryBlock}`
    };

    const messages = [systemMsg, ...history, { role: 'user', content: userMessage }];

    const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        temperature: 0.4,
        max_tokens: 2000
    });

    return response.choices[0].message.content;
}

module.exports = { summarizeCase, summarizeAll, rankByRelevance, chat };
