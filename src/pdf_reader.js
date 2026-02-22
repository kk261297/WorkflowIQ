const fs = require('fs');
const path = require('path');

const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');

/**
 * Extract text from a .txt file (saved alongside PDFs during download)
 * Falls back to stripping HTML from pdf if no .txt file exists
 */
function extractText(txtOrPdfPath) {
    // Try .txt version first
    const txtPath = txtOrPdfPath.replace('.pdf', '.txt');
    if (fs.existsSync(txtPath)) {
        return fs.readFileSync(txtPath, 'utf-8');
    }
    return null;
}

/**
 * Read all case texts from the downloads directory
 * Returns an array of {filename, id, text}
 */
async function extractAllTexts(dir) {
    const downloadsDir = dir || DOWNLOADS_DIR;
    const pdfFiles = fs.readdirSync(downloadsDir).filter(f => f.endsWith('.pdf'));

    if (pdfFiles.length === 0) {
        console.log('❌ No PDFs found in downloads/ directory');
        return [];
    }

    console.log(`📚 Reading ${pdfFiles.length} cases...\n`);
    const results = [];

    for (const file of pdfFiles) {
        const filePath = path.join(downloadsDir, file);
        const text = extractText(filePath);

        if (!text) {
            console.log(`  ⚠️  ${file}: No .txt file found (re-download to generate)`);
            continue;
        }

        // Extract case ID from filename (Case_<id>_...)
        const idMatch = file.match(/Case_(\d+)_/);
        const id = idMatch ? idMatch[1] : file;

        console.log(`  ✅ ${file} (${text.length} chars)`);
        results.push({ filename: file, id, text });
    }

    console.log(`\n📖 Loaded ${results.length}/${pdfFiles.length} cases\n`);
    return results;
}

module.exports = { extractText, extractAllTexts, DOWNLOADS_DIR };
