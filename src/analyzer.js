const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SUMMARIES_FILE = path.join(__dirname, '..', 'downloads', 'summaries.json');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Summarize a single case using OpenAI
 */
async function summarizeCase(text, filename, keywords = '', context = '') {
    // Truncate very long texts to avoid token limits (keep first ~12K chars)
    const truncated = text.length > 12000 ? text.substring(0, 12000) + '\n...[truncated]' : text;

    const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            {
                role: 'system',
                content: `You are a senior Indian legal analyst specializing in tax and commercial litigation. You must remain neutral, objective, and precise. Do not assume facts not present in the judgment. Do not exaggerate the ratio. Focus strictly on the legal substance.`
            },
            {
                role: 'user',
                content: `Input Provided:
- Keywords: ${keywords}
- Research Narrative / Context: ${context}
- Case Text: ${truncated}

Task:
- Carefully read the full judgment text.
- Identify whether the case meaningfully relates to the keywords and research narrative.
- If relevant, summarize the case in EXACTLY 150–200 words in the following format:

Required Output Format:
- Case Name and Citation
- Court and Date
- Key Legal Issue(s)
- Facts in Brief
- Decision / Held
- Key Legal Principle Established

Be precise and factual. Focus on ratio decidendi, not obiter. Avoid commentary or personal opinions. If the case is not materially relevant, state:
"After review, this judgment is not materially relevant to the provided research narrative."`
            }
        ],
        temperature: 0.2,
        max_tokens: 500
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
 * @param {string} keywords - Search keywords for relevance filtering
 * @param {string} context - User's research narrative/context
 * @returns {Object} Map of id -> {filename, summary}
 */
async function summarizeAll(cases, keywords = '', context = '') {
    const cached = loadSummaries();
    const BATCH_SIZE = 5;

    // Filter out already-cached cases
    const uncached = cases.filter(c => {
        if (cached[c.id]) {
            console.log(`  ⏭️  ${c.filename} (cached)`);
            return false;
        }
        return true;
    });

    if (uncached.length === 0) {
        console.log('\n✅ All summaries cached, nothing new to generate.\n');
        return cached;
    }

    console.log(`🧠 Summarizing ${uncached.length} cases via OpenAI (${BATCH_SIZE} in parallel)...\n`);
    let completed = 0;

    // Process in batches of BATCH_SIZE
    for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
        const batch = uncached.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(uncached.length / BATCH_SIZE);
        console.log(`  📦 Batch ${batchNum}/${totalBatches} (${batch.length} cases)...`);

        const results = await Promise.allSettled(
            batch.map(c => summarizeCase(c.text, c.filename, keywords, context))
        );

        // Process results
        results.forEach((result, j) => {
            const c = batch[j];
            if (result.status === 'fulfilled') {
                cached[c.id] = { filename: c.filename, summary: result.value };
                completed++;
                console.log(`    ✅ ${c.filename}`);
            } else {
                console.log(`    ❌ ${c.filename}: ${result.reason?.message || 'Unknown error'}`);
            }
        });

        // Save cache after each batch
        saveSummaries(cached);

        // Brief pause between batches to be respectful to rate limits
        if (i + BATCH_SIZE < uncached.length) {
            await new Promise(r => setTimeout(r, 200));
        }
    }

    console.log(`\n✅ Summaries ready: ${Object.keys(cached).length} total (${completed} new)\n`);
    return cached;
}

/**
 * Rank cases by relevance to user's described situation
 *
 * @param {Object} summaries - Map of id -> {filename, summary}
 * @param {string} userContext - User's case description
 * @returns {Array<{id, filename, score, reason}>} Ranked results
 */
async function rankByRelevance(summaries, userContext, customSystemPrompt = null) {
    const ids = Object.keys(summaries);

    // Build the summaries block
    const summaryBlock = ids.map((id, i) => {
        const s = summaries[id];
        return `[Case ${i + 1}] ID: ${id}\nFile: ${s.filename}\n${s.summary}`;
    }).join('\n\n---\n\n');

    const DEFAULT_SYSTEM_PROMPT = `You are acting as an impartial constitutional court evaluating whether a precedent meaningfully supports a legal argument. You must be neutral, analytical, and independent. Do not favour the narrative. Assess legal alignment objectively.

You will receive a Research Narrative and multiple Case Summaries. For EACH case, perform the following analysis:
- Compare the legal issues in the case summary with the research narrative.
- Identify:
  - Legal issue overlap
  - Factual similarity
  - Statutory similarity
  - Contextual similarity (tax type, procedural stage, etc.)
- Determine whether the case:
  - Directly supports
  - Partially supports
  - Is distinguishable
  - Is adverse
- Assign a Relevancy Score from 0 to 100 based on:
  - 90–100: Direct precedent, highly similar facts & issue
  - 70–89: Strong persuasive support
  - 50–69: Moderate relevance, distinguishable facts
  - 30–49: Weak support
  - 0–29: Not relevant or adverse

Respond in this exact JSON format (no markdown, just raw JSON):
{
  "rankings": [
    {
      "case_number": 1,
      "id": "case_id",
      "filename": "filename.pdf",
      "score": 85,
      "category": "Direct / Strong / Moderate / Weak / Not Relevant / Adverse",
      "reason": "Brief judicial analysis: issue alignment, factual alignment, statutory alignment, distinguishing factors, and why it supports or does not support the narrative"
    }
  ],
  "recommendation": "Brief overall recommendation for the user's case"
}

Sort rankings by score descending (most relevant first). Return ALL cases. Do not inflate scores.`;

    const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            {
                role: 'system',
                content: customSystemPrompt || DEFAULT_SYSTEM_PROMPT
            },
            {
                role: 'user',
                content: `## Research Narrative\n${userContext}\n\n## Case Summaries\n${summaryBlock}`
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

/**
 * Get smart filter suggestions using LLM
 *
 * @param {string} keywords - Search keywords
 * @param {string} context - User's case context
 * @returns {Object} map of filter IDs to arrays of suggested values
 */
async function getFilterSuggestions(keywords, context) {
    const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            {
                role: 'system',
                content: `You are a legal research assistant for Indian tax law. The user wants to search for relevant cases.
Based on their keywords and case context, suggest the best filters to apply to narrow down the search.

AVAILABLE FILTERS & VALUES:
- "module": ["GST", "Excise & Service Tax", "Customs", "Foreign Trade Policy"]
- "docType": ["Case Laws", "Notifications", "Acts", "Rules"]
- "court": ["Supreme Court", "High Court", "Tribunal", "Advance Ruling"]
- "yearList": ["2026", "2025", "2024", "2023", "2022", "2021", "2020", "2019", "2018", "2017", "2016", "2015"]

RULES:
- Only select filter options that are strongly implied by the user's query. Stop the user from getting 0 results by being too restrictive. Less is more.
- Return a JSON object with a key "suggested_filters" containing the results.
- Keys must match the filter IDs above.
- Values MUST be ARRAYS of strings from the available values list above.
- If no specific filter applies for a category, omit it or use an empty array [].
- "docType" should ideally just be ["Case Laws"] unless they specify otherwise.

EXPECTED JSON FORMAT (Raw JSON only):
{
  "suggested_filters": {
    "module": ["GST"],
    "docType": ["Case Laws"],
    "court": ["High Court", "Supreme Court"]
  }
}`
            },
            {
                role: 'user',
                content: `Keywords: ${keywords}\nCase context: ${context}`
            }
        ],
        temperature: 0.1,
        max_tokens: 500
    });

    const content = response.choices[0].message.content;
    try {
        const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(jsonStr);
        return parsed.suggested_filters || {};
    } catch {
        console.error('Failed to parse filter suggestions:', content);
        return {};
    }
}

/**
 * Relevancy Scoring & Judicial Evaluation Agent (Prompt 2)
 *
 * Evaluates how strongly a single case summary aligns with the research narrative.
 * Acts as an impartial constitutional court — neutral, analytical, and independent.
 *
 * @param {string} narrative - The user's research narrative / legal argument
 * @param {string} caseSummary - Structured case summary (output from summarizeCase / Prompt 1)
 * @param {string} [caseId] - Optional case ID for reference
 * @returns {Object} { score, category, analysis, raw }
 */
async function scoreRelevancy(narrative, caseSummary, caseId = '') {
    const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            {
                role: 'system',
                content: `You are acting as an impartial constitutional court evaluating whether a precedent meaningfully supports a legal argument. You must be neutral, analytical, and independent. Do not favour the narrative. Assess legal alignment objectively.

Assign a Relevancy Score from 0 to 100 based on:
- 90–100: Direct precedent, highly similar facts & issue
- 70–89: Strong persuasive support
- 50–69: Moderate relevance, distinguishable facts
- 30–49: Weak support
- 0–29: Not relevant or adverse

Respond ONLY in the following JSON format (raw JSON, no markdown):
{
  "score": <number 0-100>,
  "category": "<Direct | Strong | Moderate | Weak | Not Relevant | Adverse>",
  "analysis": {
    "issue_alignment": "<assessment of legal issue overlap>",
    "factual_alignment": "<assessment of factual similarity>",
    "statutory_alignment": "<assessment of statutory similarity>",
    "distinguishing_factors": "<key factors that distinguish or limit the case>",
    "support_rationale": "<why this case supports, partially supports, or does not support the narrative>"
  }
}

Be analytical. If adverse, clearly explain why. Do not inflate the score.`
            },
            {
                role: 'user',
                content: `Research Narrative: ${narrative}\n\nCase Summary:\n${caseSummary}`
            }
        ],
        temperature: 0.2,
        max_tokens: 1000
    });

    const content = response.choices[0].message.content;

    try {
        const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(jsonStr);
        return {
            caseId,
            score: parsed.score,
            category: parsed.category,
            analysis: parsed.analysis,
            raw: null
        };
    } catch {
        // Fallback: return raw text if JSON parsing fails
        return {
            caseId,
            score: null,
            category: null,
            analysis: null,
            raw: content
        };
    }
}

/**
 * Generate Search Keywords from Narrative (Prompt 0 — Keyword Agent)
 *
 * Takes the user's research narrative and returns targeted search keywords
 * suitable for the Centax legal database search API.
 *
 * @param {string} narrative - The user's legal research narrative / argument
 * @returns {{ keywords: string, keywordList: string[] }}
 */
async function generateKeywords(narrative) {
    const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            {
                role: 'system',
                content: `You are a legal research assistant specializing in Indian tax law (GST, Customs, Excise, Service Tax).
Your task is to extract 4 to 8 precise, high-recall search keywords from a legal research narrative.
These keywords will be used to search the Centax legal database.

Rules:
- Use specific legal terms, not generic words
- Include relevant act/section references where clear (e.g. "section 54", "CGST Act")
- Include key legal concepts (e.g. "pre-deposit", "interest", "refund", "appeal")
- Do NOT include stop words or redundant terms
- Return ONLY a JSON object in this format:
{ "keywordList": ["keyword1", "keyword2", "keyword3", ...] }`
            },
            {
                role: 'user',
                content: `Research Narrative: ${narrative}`
            }
        ],
        temperature: 0.1,
        max_tokens: 200
    });

    const content = response.choices[0].message.content;
    try {
        const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(jsonStr);
        const keywordList = parsed.keywordList || [];
        return {
            keywords: keywordList.join(' '),
            keywordList
        };
    } catch {
        // Fallback: extract words from raw response
        const words = content.replace(/[^a-zA-Z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2).slice(0, 8);
        return { keywords: words.join(' '), keywordList: words };
    }
}

module.exports = { summarizeCase, summarizeAll, rankByRelevance, scoreRelevancy, generateKeywords, chat, getFilterSuggestions };

