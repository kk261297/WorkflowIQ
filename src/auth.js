const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { machineIdSync } = require('node-machine-id');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SESSION_FILE = path.join(__dirname, '..', 'session.json');
const BASE_URL = 'https://api.centaxonline.com';

/**
 * Get client IP address from Centax API
 */
async function getClientIp() {
    try {
        const response = await axios.get(`${BASE_URL}/centax/getClientIp`);
        if (response.data && response.data.Data) {
            return response.data.Data.ipAddress || response.data.Data;
        }
        return '0.0.0.0';
    } catch (error) {
        console.log('⚠️  Could not get client IP, using fallback');
        return '0.0.0.0';
    }
}

/**
 * Get machine ID dynamically from the running device (or fallback to env)
 */
function getMachineId() {
    try {
        if (process.env.CENTAX_MACHINE_ID) return process.env.CENTAX_MACHINE_ID;
        // Generate a unique ID based on the host OS hardware (returns a 64-char hex string)
        const id = machineIdSync(true); // true = original machine id, false = HMAC SHA-256
        return id.substring(0, 32); // Centax seems to use 32-char hex strings based on HAR
    } catch (err) {
        console.log('⚠️  Could not get real hardware machine ID, using fallback');
        return '028ac7437a5b4cc1bea399674647a0de';
    }
}

/**
 * Login to Centax and get bearer token
 */
async function login() {
    const email = process.env.CENTAX_EMAIL;
    const password = process.env.CENTAX_PASSWORD;

    if (!email || !password) {
        throw new Error(
            'CENTAX_EMAIL and CENTAX_PASSWORD must be set in .env file.\n' +
            'Copy .env.example to .env and fill in your credentials.'
        );
    }

    console.log('🔐 Logging in to Centax...');

    const ipAddress = await getClientIp();
    const machineId = getMachineId();

    const loginPayload = {
        email,
        password,
        remember_me: false,
        ipAddress,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        device: 'Macintosh',
        os: 'Mac',
        osVersion: 'mac-os-x-15',
        browser: 'Chrome',
        browserVersion: '144.0.0.0',
        deviceType: 'DESKTOP'
    };

    try {
        const response = await axios.post(`${BASE_URL}/centax/login`, loginPayload, {
            headers: {
                'Content-Type': 'application/json',
                'appid': '2020',
                'machineid': machineId
            }
        });

        if (response.data && response.data.Data && response.data.Data.login_token) {
            const token = response.data.Data.login_token;
            console.log('✅ Login successful');

            const session = {
                token,
                machineId,
                ipAddress,
                timestamp: Date.now(),
                email
            };

            await fs.writeFile(SESSION_FILE, JSON.stringify(session, null, 2));
            return session;
        }

        throw new Error('Login failed: No token in response. Check credentials.');
    } catch (error) {
        if (error.response) {
            console.error('❌ Login error:', error.response.status, error.response.statusText);
            if (error.response.data) {
                console.error('   Response:', JSON.stringify(error.response.data, null, 2));
            }
        }
        throw error;
    }
}

/**
 * Check if current session is still active
 */
async function checkSession(token, ipAddress) {
    try {
        const response = await axios.post(
            `${BASE_URL}/centax/check_active_session`,
            { category: 'centax-gst', ipAddress },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'centaxauthorization': token,
                    'appid': '2020'
                }
            }
        );

        if (response.data && response.data.Data && response.data.Data.is_active_login_session_verified) {
            return true;
        }
        return response.status === 200;
    } catch {
        return false;
    }
}

/**
 * Check if a token is likely still valid by inspecting its JWT expiry
 */
function isTokenFresh(token) {
    try {
        // JWT format: header.payload.signature — decode the payload
        const rawToken = token.replace('Bearer', '').replace('Bearer ', '');
        const payload = JSON.parse(Buffer.from(rawToken.split('.')[1], 'base64').toString());
        if (payload.exp) {
            // Token is valid if expiry is more than 5 minutes in the future
            return (payload.exp * 1000) > (Date.now() + 5 * 60 * 1000);
        }
    } catch { /* ignore decode errors */ }
    return false;
}

/**
 * Get valid session (cached or fresh login)
 */
async function getSession() {
    // Try loading cached session
    try {
        const sessionData = await fs.readFile(SESSION_FILE, 'utf-8');
        const session = JSON.parse(sessionData);

        // Quick local check: is the JWT still within its expiry window?
        if (isTokenFresh(session.token)) {
            return session;
        }

        console.log('⚠️  Session expired, re-authenticating...');
    } catch {
        // No cached session
    }

    return await login();
}

/**
 * Build the standard API headers for authenticated requests
 */
function buildHeaders(session) {
    return {
        'Content-Type': 'application/json',
        'centaxauthorization': session.token,
        'appid': '2020',
        'machineid': session.machineId
    };
}

/**
 * Build headers specifically for the PDF API (different token format)
 * The PDF API at pdf.taxmann.com requires "Bearer" with NO space before the token
 */
function buildPdfHeaders(session) {
    // Ensure no space between "Bearer" and token
    const token = session.token.replace('Bearer ', 'Bearer');
    return {
        'Content-Type': 'application/json',
        'centaxauthorization': token,
        'appid': '2020',
        'machineid': session.machineId
    };
}

/**
 * Force re-login by clearing cached session
 */
async function forceRefresh() {
    try { await fs.unlink(SESSION_FILE); } catch { /* ignore */ }
    console.log('🔄 Forcing token refresh...');
    return await login();
}

/**
 * Make an authenticated API request with auto-retry on auth failures.
 * If a 401, 403, or 409 is received, it re-authenticates and retries once.
 *
 * @param {Function} requestFn - Async function(session) that makes the API call
 * @returns {*} The result of requestFn
 */
async function authenticatedRequest(requestFn) {
    let session = await getSession();
    try {
        return await requestFn(session);
    } catch (err) {
        const status = err.response?.status;
        if (status === 401 || status === 403 || status === 409) {
            console.log(`⚠️  Auth error (${status}), refreshing token and retrying...`);
            session = await forceRefresh();
            return await requestFn(session);
        }
        throw err;
    }
}

module.exports = {
    getSession,
    login,
    checkSession,
    getClientIp,
    getMachineId,
    buildHeaders,
    buildPdfHeaders,
    forceRefresh,
    authenticatedRequest
};
