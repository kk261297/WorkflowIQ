const axios = require('axios');
const { authenticatedRequest, buildHeaders } = require('./auth');

const BASE_URL = 'https://api.centaxonline.com';

/**
 * Search for cases using the Centax API
 *
 * @param {string} query - Search keywords
 * @param {object} options - Search options
 * @param {number} options.page - Page number (default: 1)
 * @param {number} options.pageSize - Results per page (default: 20)
 * @param {string} options.sortby - Sort by 'relevance' or 'date' (default: 'relevance')
 * @param {string} options.sortorder - '1' ascending, '0' descending (default: '1')
 * @param {object} options.filter - Advanced filter object
 * @returns {Promise<{results: Array, totalCount: number, page: number, pageSize: number}>}
 */
async function searchCases(query, options = {}) {
    const {
        page = 1,
        pageSize = 20,
        sortby = 'relevance',
        sortorder = '1',
        filter = {},
        isheadnoteToggle = false
    } = options;

    const payload = {
        searchData: query,
        page,
        pageSize,
        filter: {
            subjectList: [],
            categoryList: [],
            actList: [],
            sectionList: [],
            courtList: [],
            benchList: [],
            yearOfPublicationList: [],
            decisionDateFrom: '',
            decisionDateTo: '',
            apealNo: [],
            nameOfParty: [],
            judgeName: [],
            journalList: [],
            volume: [],
            pageNo: [],
            laws: [],
            state: [],
            groupList: [],
            goodsServiceId: [],
            yearList: [],
            chapter: [],
            rule: [],
            regulation: [],
            author: [],
            ...filter
        },
        sortby,
        sortorder,
        advanceSearch: {
            anyOfSearch: '',
            exactSearch: '',
            notIncludeSearch: ''
        },
        isExcusSearch: false,
        subjectLabelArr: [],
        isAdvSearch: false,
        isheadnoteToggle
    };

    return await authenticatedRequest(async (session) => {
        const response = await axios.post(
            `${BASE_URL}/centax/getSearchResult`,
            payload,
            { headers: buildHeaders(session) }
        );

        if (response.data && response.data.Data) {
            const results = response.data.Data.itemarray || [];
            const totalCount = response.data.Data.totalCount || 0;

            return {
                results: results.map(r => ({
                    id: r.Id || r.id,
                    heading: r.heading1 || r.heading || '',
                    citation: r.citation || '',
                    court: r.courtName || r.court || '',
                    date: r.date || r.decisionDate || '',
                    summary: r.summary || r.headnote || '',
                    parties: r.partyName || r.parties || '',
                    act: r.actName || '',
                    raw: r
                })),
                totalCount,
                page,
                pageSize
            };
        }

        throw new Error('Invalid search response from Centax API');
    });
}

/**
 * Display search results in a readable format
 */
function displayResults(searchResult) {
    const { results, totalCount, page, pageSize } = searchResult;

    console.log(`\n${'━'.repeat(70)}`);
    console.log(`📊 Found ${totalCount} results (showing page ${page}, ${results.length} items)`);
    console.log(`${'━'.repeat(70)}\n`);

    results.forEach((r, i) => {
        const num = (page - 1) * pageSize + i + 1;
        console.log(`  ${num}. ${r.heading || r.citation || r.id}`);
        if (r.court) console.log(`     🏛  ${r.court}`);
        if (r.date) console.log(`     📅 ${r.date}`);
        if (r.parties) console.log(`     👤 ${r.parties}`);
        console.log(`     🆔 ${r.id}`);
        console.log();
    });

    const totalPages = Math.ceil(totalCount / pageSize);
    console.log(`  Page ${page}/${totalPages} | Use --page N to navigate\n`);
}

module.exports = {
    searchCases,
    displayResults
};
