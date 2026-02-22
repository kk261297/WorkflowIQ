const { searchCases, displayResults } = require('./search');
const { downloadCase, downloadMultipleCases } = require('./download');
const { getSession } = require('./auth');
const { extractAllTexts } = require('./pdf_reader');
const { summarizeAll, rankByRelevance, chat } = require('./analyzer');
const readline = require('readline');

// Store last search results for download-all
let lastSearchResults = null;

/**
 * Print usage instructions
 */
function printHelp() {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║          Centax Online - Case Downloader CLI             ║
╚══════════════════════════════════════════════════════════╝

Usage:
  node index.js <command> [arguments]

Commands:
  search <query>              Search for cases by keyword
    --page N                  Page number (default: 1)
    --size N                  Results per page (default: 20)
    --sort relevance|date     Sort order (default: relevance)

  search-download <query>     Search + download top 30 results as PDFs
                              Skips files that already exist

  chat                        Interactive chatbot to analyze downloaded PDFs
                              Ranks cases by relevance to your situation

  download <caseId>           Download a single case as PDF
    --title "Case Title"      Optional title for filename

  download-all                Download all cases from last search

  login                       Test login and display session info

  help                        Show this help message

Examples:
  node index.js search-download "customs duty exemption"
  node index.js chat
  node index.js download 101010000000353754
`);
}

/**
 * Parse command-line arguments
 */
function parseArgs(args) {
    const parsed = { command: null, args: [], options: {} };

    if (args.length === 0) {
        parsed.command = 'help';
        return parsed;
    }

    parsed.command = args[0];

    for (let i = 1; i < args.length; i++) {
        if (args[i].startsWith('--')) {
            const key = args[i].substring(2);
            const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
            parsed.options[key] = value;
            if (value !== true) i++;
        } else {
            parsed.args.push(args[i]);
        }
    }

    return parsed;
}

/**
 * Handle search command
 */
async function handleSearch(query, options) {
    if (!query) {
        console.error('❌ Please provide a search query. Example: node index.js search "GST fraud"');
        return;
    }

    console.log(`🔍 Searching for: "${query}"`);

    const searchOptions = {
        page: parseInt(options.page) || 1,
        pageSize: parseInt(options.size) || 20,
        sortby: options.sort || 'relevance'
    };

    const results = await searchCases(query, searchOptions);
    displayResults(results);

    // Cache for download-all
    lastSearchResults = results;

    return results;
}

/**
 * Handle download command
 */
async function handleDownload(caseId, options) {
    if (!caseId) {
        console.error('❌ Please provide a case ID. Example: node index.js download 101010000000353754');
        return;
    }

    console.log(`📥 Downloading case: ${caseId}`);
    const result = await downloadCase(caseId, options.title || caseId);

    if (result.success) {
        console.log(`\n✅ Done! PDF saved to: ${result.path}`);
    } else {
        console.log(`\n❌ Download failed: ${result.error}`);
    }

    return result;
}

/**
 * Handle download-all command
 */
async function handleDownloadAll() {
    if (!lastSearchResults || lastSearchResults.results.length === 0) {
        console.error('❌ No search results to download. Run a search first.');
        console.error('   Example: node index.js search "GST fraud"');
        return;
    }

    const cases = lastSearchResults.results.map(r => ({
        id: r.id,
        heading: r.heading || r.citation || r.id
    }));

    return await downloadMultipleCases(cases);
}

/**
 * Handle login test command
 */
async function handleLogin() {
    console.log('🔐 Testing login...');
    const session = await getSession();
    console.log(`\n✅ Authenticated successfully!`);
    console.log(`   Email: ${session.email}`);
    console.log(`   Machine ID: ${session.machineId}`);
    console.log(`   Token: ${session.token.substring(0, 30)}...`);
}

/**
 * Handle search-download command (MVP: search + download 30 PDFs)
 */
async function handleSearchDownload(query, options) {
    if (!query) {
        console.error('❌ Please provide a search query. Example: node index.js search-download "GST fraud"');
        return;
    }

    const count = parseInt(options.count) || 30;
    console.log(`🔍 Searching for: "${query}" (will download top ${count} results)\n`);

    // Search with pageSize = count
    const searchResult = await searchCases(query, {
        page: 1,
        pageSize: count,
        sortby: options.sort || 'relevance'
    });

    displayResults(searchResult);

    if (searchResult.results.length === 0) {
        console.log('❌ No results found');
        return;
    }

    // Download all results
    const cases = searchResult.results.map(r => ({
        id: r.id,
        heading: r.heading || r.citation || r.id
    }));

    return await downloadMultipleCases(cases);
}

/**
 * Handle interactive chat command
 */
async function handleChat() {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║        Centax Case Relevancy Analyzer (AI Chat)         ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    // 1. Extract text from all downloaded PDFs
    const cases = await extractAllTexts();
    if (cases.length === 0) {
        console.log('💡 Run "node index.js search-download <query>" first to download some PDFs.');
        return;
    }

    // 2. Summarize all cases (uses cache)
    const summaries = await summarizeAll(cases);
    const caseCount = Object.keys(summaries).length;

    if (caseCount === 0) {
        console.log('❌ No summaries generated. Check your OpenAI API key.');
        return;
    }

    // 3. Enter interactive chat loop
    console.log(`\n✅ ${caseCount} cases loaded and summarized.`);
    console.log('\n📝 Describe your legal case or situation below.');
    console.log('   I\'ll rank the downloaded cases by relevance.\n');
    console.log('   Type "quit" or "exit" to leave.\n');

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const chatHistory = [];
    let isFirstMessage = true;
    let closed = false;

    rl.on('close', () => { closed = true; });

    const askQuestion = () => {
        if (closed) return;

        const prompt = isFirstMessage
            ? '🧑 Describe your case: '
            : '🧑 Follow-up: ';

        rl.question(prompt, async (input) => {
            const userInput = input.trim();

            if (!userInput || userInput === 'quit' || userInput === 'exit') {
                console.log('\n👋 Goodbye!\n');
                rl.close();
                return;
            }

            try {
                if (isFirstMessage) {
                    // First message: do a full relevancy ranking
                    console.log('\n🔄 Analyzing relevance...\n');
                    const result = await rankByRelevance(summaries, userInput);

                    if (result.rankings && result.rankings.length > 0) {
                        console.log('\n📊 Relevancy Rankings:\n');
                        for (const r of result.rankings) {
                            const bar = '█'.repeat(Math.round(r.score / 5)) + '░'.repeat(20 - Math.round(r.score / 5));
                            console.log(`  ${bar} ${r.score}/100`);
                            console.log(`  📄 ${r.filename}`);
                            console.log(`  💡 ${r.reason}\n`);
                        }
                        if (result.recommendation) {
                            console.log(`\n🎯 Recommendation: ${result.recommendation}\n`);
                        }
                    } else if (result.raw) {
                        console.log(result.raw);
                    }

                    chatHistory.push({ role: 'user', content: userInput });
                    chatHistory.push({ role: 'assistant', content: JSON.stringify(result) });
                    isFirstMessage = false;
                } else {
                    // Follow-up: conversational chat
                    console.log('\n🔄 Thinking...\n');
                    const response = await chat(summaries, chatHistory, userInput);
                    console.log(`🤖 ${response}\n`);

                    chatHistory.push({ role: 'user', content: userInput });
                    chatHistory.push({ role: 'assistant', content: response });
                }
            } catch (err) {
                console.error(`\n❌ Error: ${err.message}\n`);
            }

            askQuestion();
        });
    };

    askQuestion();

    // Keep process alive while in chat
    await new Promise(resolve => rl.on('close', resolve));
}

/**
 * Main entry point
 */
async function main() {
    const { command, args, options } = parseArgs(process.argv.slice(2));

    try {
        switch (command) {
            case 'search':
                await handleSearch(args.join(' '), options);
                break;

            case 'search-download':
                await handleSearchDownload(args.join(' '), options);
                break;

            case 'download':
                await handleDownload(args[0], options);
                break;

            case 'download-all':
                await handleDownloadAll();
                break;

            case 'login':
                await handleLogin();
                break;

            case 'chat':
                await handleChat();
                break;

            case 'help':
            default:
                printHelp();
                break;
        }
    } catch (error) {
        console.error(`\n❌ Error: ${error.message}`);
        if (error.response) {
            console.error(`   Status: ${error.response.status}`);
            console.error(`   Data:`, JSON.stringify(error.response.data, null, 2));
        }
        process.exit(1);
    }
}

module.exports = { handleSearch, handleDownload, handleDownloadAll };

// Self-execute
main().catch(err => {
    console.error(`\n❌ Fatal error: ${err.message}`);
    process.exit(1);
});
