#!/usr/bin/env node

/**
 * Centax Online - Case Downloader
 *
 * Usage:
 *   node index.js search "GST pre-deposit"
 *   node index.js download <caseId>
 *   node index.js help
 */

// The CLI module self-executes its main() function
require('./src/cli');
