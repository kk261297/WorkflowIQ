const axios = require('axios');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const https = require('https');
const http = require('http');
const { getSession, authenticatedRequest, buildHeaders, buildPdfHeaders } = require('./auth');

const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');
const BASE_URL = 'https://api.centaxonline.com';
const PDF_API_URL = 'https://pdf.taxmann.com/research/getFilehtmlTopdf';

// Ensure downloads directory exists
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

/**
 * Check if a PDF for this case ID already exists in the output directory
 */
function findExistingPdf(caseId, outputDir) {
    try {
        const files = fs.readdirSync(outputDir);
        const match = files.find(f => f.includes(caseId) && f.endsWith('.pdf'));
        return match ? path.join(outputDir, match) : null;
    } catch {
        return null;
    }
}

/**
 * Get case document HTML content via API
 *
 * @param {string} caseId - Case ID (e.g., '101010000000353754')
 * @param {string} searchText - Optional search text for highlighting
 * @returns {Promise<{id: string, htmlContent: string, metadata: object}>}
 */
async function getCaseHTML(caseId, searchText = '') {
    console.log(`   📄 Fetching document ${caseId}...`);

    return await authenticatedRequest(async (session) => {
        const response = await axios.post(
            `${BASE_URL}/centax/getFileText`,
            {
                fileID: caseId,
                catName: '',
                isExcus: false,
                searchText
            },
            { headers: buildHeaders(session) }
        );

        if (response.data && response.data.Data && response.data.Data.result) {
            const result = response.data.Data.result;
            const htmlContent = result.Text || (typeof result === 'string' ? result : '');

            if (!htmlContent || htmlContent.length < 50) {
                throw new Error(`Document ${caseId}: HTML content too short (${htmlContent?.length || 0} chars)`);
            }

            console.log(`   ✅ Retrieved HTML: ${htmlContent.length} characters`);
            return {
                id: caseId,
                htmlContent,
                metadata: response.data.Data
            };
        }

        throw new Error(`Failed to get document ${caseId}`);
    });
}

/**
 * Wrap raw HTML content with the full page template (header/styles)
 * This matches what the Centax website sends to the PDF API
 */
function wrapHtmlForPdf(htmlContent, citation = '') {
    return `<html>
    <head>
        <style>
            body { font-family: Verdana; margin: 0; padding: 0; }
            .tx { margin-top: -1pt; margin-bottom: 4pt; text-align: justify; font-size: 11pt; font-family: "Verdana"; }
            .h1 { display: block; text-indent: 0; margin-top: 4pt; margin-bottom: 0; font-size: 11pt; font-weight: 700; font-family: "Verdana"; text-align: left; }
            .indent1 { display: block; margin-left: 10mm; margin-bottom: 4pt; text-indent: -7mm; margin-top: -1pt; text-align: justify; font-size: 11pt; font-family: "Verdana"; }
            .indent2 { display: block; margin-left: 22mm; margin-bottom: 4pt; text-indent: -8mm; margin-top: -1pt; text-align: justify; font-size: 11pt; font-family: "Verdana"; }
            .quote { display: block; margin-left: 8mm; margin-bottom: 4pt; text-indent: 0; margin-top: -1pt; text-align: justify; font-size: 11pt; font-family: "Verdana"; }
            .allborder table { border: 1px solid #000; }
            .allborder td { border: 1px solid #000; }
            .allborder { margin-top: -1pt; margin-bottom: 4pt; text-align: justify; font-size: 11pt; font-family: "Verdana"; border-collapse: collapse; width: 100%; }
            .copy-citation-action { display: none; }
            a[href] { color: Blue; text-decoration: underline; }
            hr { margin-top: -1pt; }
        </style>
    </head>
    <body style="padding:15px; position:relative;">
        <div style="border-bottom:1px solid #ccc; margin-bottom:35px;">
            <table style="margin-bottom:10px; padding-top:25px;" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tbody>
                    <tr>
                        <td valign="top">
                            <div>
                                <img alt="header" src="https://cdn.centaxonline.com/taxmann-assets/images/centax/centax-logo-1.png" style="max-width:205px;">
                            </div>
                            <div style="margin-bottom:5px; font-size:12px; font-style:italic; padding-left:48px; color:#6c6c6c;">
                                <span>Centaxonline.com</span>: A Legal Research Platform on GST, Customs, Excise & Service Tax, Foreign Trade Policy
                            </div>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
        <center>
            <h3 style="border-bottom:0px solid black;padding-bottom:10px">${citation}</h3>
        </center>
        ${htmlContent}
    </body>
</html>`;
}

/**
 * Download a file from a URL to disk
 */
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        const file = fs.createWriteStream(dest);

        protocol.get(url, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                // Handle redirect
                downloadFile(response.headers.location, dest).then(resolve).catch(reject);
                return;
            }
            if (response.statusCode !== 200) {
                reject(new Error(`Download failed with status ${response.statusCode}`));
                return;
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => { });
            reject(err);
        });
    });
}

/**
 * Generate PDF from HTML content via the PDF API
 *
 * @param {string} htmlContent - Full HTML content
 * @param {string} fileName - Desired PDF filename
 * @returns {Promise<string>} S3 signed URL to download PDF
 */
async function generatePDF(htmlContent, fileName) {
    const session = await getSession();

    console.log(`   🔄 Generating PDF (${(htmlContent.length / 1024).toFixed(1)} KB HTML)...`);

    const payload = {
        html: htmlContent,
        fileName: `centax/${fileName}`,
        lastQCDate: new Date().toISOString().split('T')[0] + 'T00:00:00'
    };

    const response = await axios.post(PDF_API_URL, payload, {
        headers: buildPdfHeaders(session),
        maxContentLength: Infinity,
        maxBodyLength: Infinity
    });

    if (response.data && response.data.success && response.data.Data) {
        return response.data.Data; // S3 signed URL
    }

    const errorMsg = response.data?.StatusMsg || response.data?.ResponseType || 'Unknown error';
    throw new Error(`PDF generation failed: ${errorMsg}`);
}

/**
 * Download a single case as PDF (end-to-end)
 *
 * @param {string} caseId - Case ID
 * @param {string} title - Case title/citation for filename
 * @param {object} options
 * @param {string} options.outputDir - Custom output directory
 * @param {string} options.searchText - Search text for highlighting
 * @returns {Promise<{success: boolean, id: string, path?: string, size?: number, error?: string}>}
 */
async function downloadCase(caseId, title = '', options = {}) {
    const outputDir = options.outputDir || DOWNLOADS_DIR;
    fs.mkdirSync(outputDir, { recursive: true });

    // Skip if already downloaded
    const existing = findExistingPdf(caseId, outputDir);
    if (existing) {
        console.log(`   ⏭️  Already exists: ${path.basename(existing)}`);
        return {
            success: true,
            skipped: true,
            id: caseId,
            path: existing
        };
    }

    try {
        // 1. Get case HTML
        const doc = await getCaseHTML(caseId, options.searchText || '');

        // 2. Wrap HTML with page template
        const fullHtml = wrapHtmlForPdf(doc.htmlContent, title);

        // 3. Create safe filename
        const safeTitle = (title || caseId)
            .replace(/[^a-zA-Z0-9\s().-]/g, '')
            .replace(/\s+/g, '_')
            .substring(0, 120);
        const pdfFileName = `Case_${caseId}_${safeTitle}.pdf`;

        // 4. Generate PDF via API → get S3 URL
        const s3Url = await generatePDF(fullHtml, pdfFileName);
        console.log(`   ✅ PDF generated, downloading...`);

        // 5. Download PDF from S3 (URL expires in 30 seconds!)
        const outputPath = path.join(outputDir, pdfFileName);
        await downloadFile(s3Url, outputPath);

        // 6. Save raw text alongside PDF for analysis/chat
        const txtPath = outputPath.replace('.pdf', '.txt');
        await fsPromises.writeFile(txtPath, doc.htmlContent.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());

        const stats = await fsPromises.stat(outputPath);
        console.log(`   ✅ Saved: ${path.basename(outputPath)} (${(stats.size / 1024).toFixed(1)} KB)`);

        return {
            success: true,
            skipped: false,
            id: caseId,
            path: outputPath,
            size: stats.size
        };
    } catch (error) {
        console.error(`   ❌ Error: ${error.message}`);
        return {
            success: false,
            skipped: false,
            id: caseId,
            error: error.message
        };
    }
}

/**
 * Download multiple cases as PDFs with rate limiting
 *
 * @param {Array<{id: string, heading?: string, citation?: string}>} cases
 * @param {object} options
 * @param {number} options.delay - Delay between downloads in ms (default: 2000)
 * @param {string} options.outputDir - Custom output directory
 */
async function downloadMultipleCases(cases, options = {}) {
    const { delay = 2000, outputDir } = options;
    const results = [];
    let downloadedCount = 0;
    let skippedCount = 0;
    let failCount = 0;

    console.log(`\n📥 Downloading ${cases.length} cases as PDFs...\n`);

    for (let i = 0; i < cases.length; i++) {
        const c = cases[i];
        const title = c.heading || c.citation || c.id;

        console.log(`\n[${i + 1}/${cases.length}] ${title}`);

        const result = await downloadCase(c.id, title, { outputDir });
        results.push(result);

        if (result.success && result.skipped) skippedCount++;
        else if (result.success) downloadedCount++;
        else failCount++;

        // Rate limiting (skip delay for already-existing files)
        if (i < cases.length - 1 && !result.skipped) {
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    // Summary
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`📊 Download Summary:`);
    console.log(`   ✅ Downloaded: ${downloadedCount}`);
    console.log(`   ⏭️  Skipped (already exist): ${skippedCount}`);
    console.log(`   ❌ Failed: ${failCount}`);
    console.log(`   📁 Saved to: ${outputDir || DOWNLOADS_DIR}`);
    console.log(`${'═'.repeat(60)}\n`);

    return results;
}

module.exports = {
    getCaseHTML,
    generatePDF,
    downloadCase,
    downloadMultipleCases,
    downloadFile,
    wrapHtmlForPdf,
    DOWNLOADS_DIR
};
