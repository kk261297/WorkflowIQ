const fs = require('fs');
const path = require('path');
const { getCaseHTML } = require('./src/download');

async function generateTxtFiles() {
    const dir = 'downloads';
    const pdfs = fs.readdirSync(dir).filter(f => f.endsWith('.pdf'));

    console.log(`Generating .txt files for ${pdfs.length} PDFs...\n`);

    for (const file of pdfs) {
        const txtPath = path.join(dir, file.replace('.pdf', '.txt'));
        if (fs.existsSync(txtPath)) {
            console.log(`  ⏭️  ${file} (already has .txt)`);
            continue;
        }

        const match = file.match(/Case_(\d+)_/);
        if (!match) {
            console.log(`  ⚠️  ${file}: no case ID in filename`);
            continue;
        }

        try {
            const doc = await getCaseHTML(match[1]);
            const text = doc.htmlContent.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
            fs.writeFileSync(txtPath, text);
            console.log(`  ✅ ${file} → ${text.length} chars`);
            await new Promise(r => setTimeout(r, 1000));
        } catch (e) {
            console.error(`  ❌ ${file}: ${e.message}`);
        }
    }
    console.log('\nDone!');
}

generateTxtFiles().catch(console.error);
