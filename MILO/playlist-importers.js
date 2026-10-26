'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const SpotifyWebApi = require('spotify-web-api-node');
const { Innertube } = require('youtubei.js');

let puppeteer;
try { puppeteer = require('puppeteer'); } catch (_) {}

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function findSystemChromeExecutable() {
    const candidates = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        process.env.CHROME_PATH,
        process.env.CHROMIUM_PATH,
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    ].filter(Boolean);
    return candidates.find(candidate => {
        try { return fs.existsSync(candidate) && fs.statSync(candidate).isFile(); } catch (_) { return false; }
    }) || '';
}

function spotifyBrowserLaunchOptions() {
    const options = {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    };
    const systemChrome = findSystemChromeExecutable();
    if (systemChrome) options.executablePath = systemChrome;
    return { options, executable: systemChrome || 'Puppeteer-managed Chrome' };
}

function extractPlaylistId(url, provider) {
    if (!url) return '';
    let match;
    if (provider === 'spotify') {
        match = url.match(/playlist\/([a-zA-Z0-9]+)/);
        return match ? match[1] : url.split('?')[0].trim();
    } else if (provider === 'youtube') {
        match = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
        return match ? match[1] : url.trim();
    } else if (provider === 'apple') {
        match = url.match(/(pl\.[a-zA-Z0-9-]+)/);
        return match ? match[1] : url.trim();
    }
    return url.trim();
}

function cleanTrackText(value) {
    return String(value == null ? '' : value)
        .replace(/<[^>]*>/g, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#0*39;|&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&#(\d+);/g, (_, code) => {
            const number = Number(code);
            return number > 0 && number <= 0x10FFFF ? String.fromCodePoint(number) : ' ';
        })
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
            const number = parseInt(code, 16);
            return number > 0 && number <= 0x10FFFF ? String.fromCodePoint(number) : ' ';
        })
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeTrackQuery(value) {
    return cleanTrackText(value).normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .toLowerCase();
}

function providerText(value) {
    if (value == null) return '';
    if (Array.isArray(value)) return value.map(item => providerText(item)).filter(Boolean).join(' ');
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (typeof value.text === 'string') return value.text;
    if (typeof value.simpleText === 'string') return value.simpleText;
    if (Array.isArray(value.runs)) return value.runs.map(run => providerText(run?.text || run)).filter(Boolean).join('');
    if (Array.isArray(value.items)) return value.items.map(item => providerText(item)).filter(Boolean).join(' ');
    if (typeof value.toString === 'function' && value.toString !== Object.prototype.toString) {
        const text = String(value);
        return text === '[object Object]' ? '' : text;
    }
    return '';
}

function makeTrackQuery(artist, title) {
    const cleanArtist = cleanTrackText(providerText(artist));
    const cleanTitle = cleanTrackText(providerText(title));
    return cleanArtist && cleanTitle ? `${cleanArtist} - ${cleanTitle}` : (cleanArtist || cleanTitle).trim();
}

function dedupeTrackQueries(queries) {
    const output = [];
    const seen = new Set();
    for (const value of queries || []) {
        const query = cleanTrackText(value);
        const key = normalizeTrackQuery(query);
        if (!query || !key || seen.has(key)) continue;
        seen.add(key);
        output.push(query);
    }
    return output;
}

function spotifyArtistNames(track) {
    const artists = track?.artists;
    if (Array.isArray(artists)) {
        return artists.map(artist => typeof artist === 'string' ? artist : (artist?.name || artist?.profile?.name || ''))
            .filter(Boolean).join(', ');
    }
    if (Array.isArray(artists?.items)) {
        return artists.items.map(artist => artist?.profile?.name || artist?.name || '')
            .filter(Boolean).join(', ');
    }
    return cleanTrackText(track?.subtitle || track?.artist || track?.author || '');
}

function spotifyItemToQuery(entry) {
    if (!entry || typeof entry !== 'object') return '';
    const track = entry.itemV2?.data || entry.item || entry.track || entry.data?.track || entry;
    if (!track || typeof track !== 'object') return '';
    if (track.type === 'episode' || String(track.uri || '').startsWith('spotify:episode:')) return '';
    const title = track.name || track.title || track.track?.name || '';
    if (!title) return '';
    return makeTrackQuery(spotifyArtistNames(track), title);
}

function spotifyQueriesFromItems(items) {
    if (!Array.isArray(items)) return [];
    return items.map(spotifyItemToQuery).filter(Boolean);
}

function absoluteSpotifyNextUrl(next, currentUrl) {
    if (!next) return null;
    try {
        const parsed = new URL(next, currentUrl || 'https://api.spotify.com');
        if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.spotify.com') return null;
        return parsed.toString();
    } catch (_) {
        return null;
    }
}

async function fetchSpotifyPlaylistItems(playlistId, token, defaultUA) {

    const endpoints = [
        { name: 'tracks', limit: 100, market: false },
        { name: 'items', limit: 50, market: true }
    ];
    const headers = {
        Authorization: `Bearer ${token}`,
        'User-Agent': defaultUA,
        Origin: 'https://open.spotify.com',
        Referer: 'https://open.spotify.com/'
    };

    for (const endpoint of endpoints) {
        let url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/${endpoint.name}?limit=${endpoint.limit}&offset=0`;
        if (endpoint.market) url += '&market=US';
        const visitedUrls = new Set();
        const queries = [];
        let fetchedItemCount = 0;
        let reportedTotal = null;
        let complete = false;
        let pageCount = 0;
        let sawItemsArray = false;

        while (url && pageCount < 1000) {
            const currentUrl = url;
            if (visitedUrls.has(currentUrl)) break;
            visitedUrls.add(currentUrl);

            try {
                const response = await axios.get(currentUrl, { headers, timeout: 15000 });
                const data = response.data || {};
                const items = Array.isArray(data.items) ? data.items
                    : (Array.isArray(data.tracks?.items) ? data.tracks.items : null);
                if (!items) break;

                sawItemsArray = true;
                fetchedItemCount += items.length;
                if (data.total !== undefined && data.total !== null && Number.isFinite(Number(data.total))) {
                    reportedTotal = Number(data.total);
                }
                queries.push(...spotifyQueriesFromItems(items));

                const nextFromApi = absoluteSpotifyNextUrl(data.next, currentUrl);
                if (nextFromApi && !visitedUrls.has(nextFromApi)) {
                    url = nextFromApi;
                    pageCount++;
                    continue;
                }

                if (reportedTotal !== null && fetchedItemCount < reportedTotal && items.length > 0) {
                    const nextUrl = new URL(currentUrl);
                    nextUrl.pathname = `/v1/playlists/${encodeURIComponent(playlistId)}/${endpoint.name}`;
                    nextUrl.searchParams.set('limit', String(endpoint.limit));
                    nextUrl.searchParams.set('offset', String(fetchedItemCount));
                    if (endpoint.market && !nextUrl.searchParams.has('market')) nextUrl.searchParams.set('market', 'US');
                    url = nextUrl.toString();
                    pageCount++;
                    continue;
                }

                complete = reportedTotal !== null
                    ? fetchedItemCount >= reportedTotal
                    : items.length < endpoint.limit;
                url = null;
                pageCount++;
            } catch (_) {
                break;
            }
        }

        const result = {
            queries: dedupeTrackQueries(queries),
            complete,
            fetchedItemCount,
            reportedTotal
        };

        if (fetchedItemCount > 0 || (sawItemsArray && reportedTotal === 0)) return result;
    }

    return { queries: [], complete: false, fetchedItemCount: 0, reportedTotal: null };
}

function spotifyEmbedQueries(html) {
    const queries = [];
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
    if (nextDataMatch) {
        try {
            const json = JSON.parse(nextDataMatch[1]);
            const trackList = json?.props?.pageProps?.state?.data?.entity?.trackList
                || json?.props?.pageProps?.trackList || [];
            for (const track of trackList) {
                const title = track.title || track.name || '';
                const artist = track.subtitle || spotifyArtistNames(track);
                if (title) queries.push(makeTrackQuery(artist, title));
            }
        } catch (_) {}
    }

    if (!queries.length) {
        const matches = [...html.matchAll(/class=["'][^"']*TrackListRow__title[^"']*["']>([^<]+)<\/div>[\s\S]*?class=["'][^"']*TrackListRow__artists[^"']*["'][^>]*>([^<]+)/gi)];
        for (const match of matches) {
            const title = cleanTrackText(match[1]);
            const artist = cleanTrackText(match[2]);
            if (title) queries.push(makeTrackQuery(artist, title));
        }
    }
    return dedupeTrackQueries(queries);
}

function spotifyPlaylistContentInfo(json) {
    const candidates = [
        json?.data?.playlistV2?.content,
        json?.data?.data?.playlistV2?.content,
        json?.playlistV2?.content,
        json?.data?.fetchPlaylist?.data?.playlistV2?.content,
        json?.data?.playlist?.tracks,
        json?.playlist?.tracks,
        json?.data?.playlistV2,
        json?.data?.items ? json.data : null,
        Array.isArray(json?.items) ? json : null
    ].filter(Boolean);

    for (const content of candidates) {
        const items = Array.isArray(content.items) ? content.items
            : (Array.isArray(content.items?.items) ? content.items.items : null);
        const totalValue = content.totalCount ?? content.total ?? content.items?.totalCount;
        const total = Number(totalValue);
        if (items) {
            return {
                items,
                total: Number.isFinite(total) && total >= 0 ? total : null
            };
        }
    }
    return { items: [], total: null };
}

function readSpotifyRequestVariables(url, postData) {
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch (_) { return {}; }

    let body = null;
    if (postData) {
        try { body = JSON.parse(postData); } catch (_) {}
    }

    let variables = body?.variables || null;
    const rawVariables = parsedUrl.searchParams.get('variables');
    if (!variables && rawVariables) {
        try { variables = JSON.parse(rawVariables); } catch (_) {}
    }
    return {
        operationName: parsedUrl.searchParams.get('operationName') || body?.operationName || '',
        variables: variables && typeof variables === 'object' ? variables : {},
        body
    };
}

async function fetchSpotifyPartnerPlaylistPageInBrowser(page, requestInfo, offset) {
    return page.evaluate(async ({ url, method, headers, postData, offset }) => {
        const requestUrl = new URL(url);
        const reqMethod = String(method || 'GET').toUpperCase();
        let payload = null;
        let variables = null;

        if (reqMethod === 'GET') {
            const raw = requestUrl.searchParams.get('variables');
            if (raw) {
                try { variables = JSON.parse(raw); } catch (_) {}
            }
            if (variables) {
                variables.offset = offset;
                if (!Number(variables.limit)) variables.limit = 50;
                requestUrl.searchParams.set('variables', JSON.stringify(variables));
            } else {
                requestUrl.searchParams.set('offset', String(offset));
            }
        } else {
            try { payload = JSON.parse(postData || '{}'); } catch (_) { payload = {}; }
            if (payload.variables && typeof payload.variables === 'object') {
                payload.variables.offset = offset;
                if (!Number(payload.variables.limit)) payload.variables.limit = 50;
            }
        }

        const allowedHeaders = new Set([
            'accept', 'authorization', 'client-token', 'content-type',
            'spotify-app-version', 'spotify-app-platform', 'app-platform',
            'spotify-app-device-id', 'spotify-app-language', 'x-spotify-connection-id',
            'x-spotify-client-id', 'spotify-app-build-version', 'spotify-app-web-wg-id'
        ]);
        const requestHeaders = {};
        for (const [name, value] of Object.entries(headers || {})) {
            if (allowedHeaders.has(name.toLowerCase()) && value) requestHeaders[name] = value;
        }
        if (!Object.keys(requestHeaders).some(name => name.toLowerCase() === 'authorization')) {
            return { status: 0, error: 'The playlist request did not include an authorization header.' };
        }

        const init = { method: reqMethod, headers: requestHeaders, credentials: 'include' };
        if (reqMethod !== 'GET' && reqMethod !== 'HEAD') init.body = JSON.stringify(payload || {});
        try {
            const response = await fetch(requestUrl.toString(), init);
            let data = null;
            try { data = await response.json(); } catch (_) {}
            return { status: response.status, data };
        } catch (error) {
            return { status: 0, error: String(error?.message || error) };
        }
    }, {
        url: requestInfo.url,
        method: requestInfo.method,
        headers: requestInfo.headers,
        postData: requestInfo.postData,
        offset
    });
}

function spotifyQueriesFromNetworkJson(json, url) {
    const queries = [];
    const isPathfinder = String(url || '').includes('pathfinder/v1/query');
    if (isPathfinder) {
        const content = spotifyPlaylistContentInfo(json);
        queries.push(...spotifyQueriesFromItems(content.items));
    } else {
        queries.push(...spotifyQueriesFromItems(json?.items));
        queries.push(...spotifyQueriesFromItems(json?.data?.items));
        const content = spotifyPlaylistContentInfo(json);
        queries.push(...spotifyQueriesFromItems(content.items));
    }
    return dedupeTrackQueries(queries);
}

async function fetchProviderPlaylistTracks(source_type, playlistInput, options = {}) {
    const input_data = extractPlaylistId(playlistInput, source_type);
    let raw_queries = [];
    const defaultUA = DEFAULT_USER_AGENT;
    const sClientId = options.spotifyClientId || '';
    const sClientSecret = options.spotifyClientSecret || '';
    const aDevToken = options.appleDeveloperToken || '';

    if (source_type === 'spotify') {
        const hasSpotifyCredentials = Boolean(sClientId && sClientSecret);
        const uniqueCount = list => dedupeTrackQueries(list).length;
        let accessToken = '';
        let apiResult = { queries: [], complete: false, fetchedItemCount: 0, reportedTotal: null };

        if (sClientId && sClientSecret) {
            try {
                const spotifyApi = new SpotifyWebApi({ clientId: sClientId, clientSecret: sClientSecret });
                const auth = await spotifyApi.clientCredentialsGrant();
                accessToken = auth.body?.access_token || '';
            } catch (_) {}
        } else {
            try {
                const tokenRes = await axios.get(
                    'https://open.spotify.com/get_access_token?reason=transport&productType=web_player',
                    { headers: { 'User-Agent': defaultUA }, timeout: 10000 }
                );
                accessToken = tokenRes.data?.accessToken || '';

                if (!accessToken) {
                    const pageRes = await axios.get(`https://open.spotify.com/playlist/${input_data}`, {
                        headers: { 'User-Agent': defaultUA }, timeout: 10000
                    });
                    const sessionMatch = pageRes.data.match(/"accessToken"\s*:\s*"([^"]+)"/);
                    if (sessionMatch) accessToken = sessionMatch[1];
                }
            } catch (_) {}
        }

        if (accessToken) {
            apiResult = await fetchSpotifyPlaylistItems(input_data, accessToken, defaultUA);
            raw_queries.push(...apiResult.queries);
        }

        try {
            const embedRes = await axios.get(`https://open.spotify.com/embed/playlist/${input_data}`, {
                headers: { 'User-Agent': defaultUA }, timeout: 15000
            });
            raw_queries.push(...spotifyEmbedQueries(embedRes.data || ''));
        } catch (_) {}

        try {
            const spotifyUrlInfo = require('spotify-url-info');
            const fetchImplementation = typeof fetch === 'function' ? fetch : require('node-fetch');
            const suInfo = spotifyUrlInfo(fetchImplementation);
            const tracks = await suInfo.getTracks(`https://open.spotify.com/playlist/${input_data}`);
            const urlInfoQueries = [];
            if (Array.isArray(tracks)) {
                for (const track of tracks) {
                    const artist = Array.isArray(track.artists)
                        ? track.artists.map(item => typeof item === 'string' ? item : item?.name || '').filter(Boolean).join(', ')
                        : '';
                    if (track.name) urlInfoQueries.push(makeTrackQuery(artist, track.name));
                }
            }
            raw_queries.push(...urlInfoQueries);
        } catch (_) {}

        const needsBrowserExtraction = Boolean(puppeteer) && (
            !hasSpotifyCredentials || !apiResult.complete || apiResult.fetchedItemCount < 300 || uniqueCount(raw_queries) < 300
        );
        if (needsBrowserExtraction && puppeteer) {
            try {
                const browserLaunch = spotifyBrowserLaunchOptions();
                const browser = await puppeteer.launch(browserLaunch.options);
                try {
                    const page = await browser.newPage();
                    await page.setViewport({ width: 1280, height: 920 });
                    const capturedTracks = new Map();
                    const capturedPlaylistRequests = [];
                    let spotifyReportedTotal = null;
                    const addCaptured = queries => {
                        let added = 0;
                        for (const query of queries || []) {
                            const cleaned = cleanTrackText(query);
                            const key = normalizeTrackQuery(cleaned);
                            if (key && !capturedTracks.has(key)) { capturedTracks.set(key, cleaned); added++; }
                        }
                        return added;
                    };
                    addCaptured(raw_queries);

                    page.on('request', request => {
                        try {
                            const url = request.url();
                            if (!/api-partner\.spotify\.com\/pathfinder\/v1\/query/i.test(url)) return;
                            const postData = request.postData() || '';
                            const requestInfo = readSpotifyRequestVariables(url, postData);
                            const varsText = JSON.stringify(requestInfo.variables || {});
                            if (!varsText.includes(input_data) && !url.includes(input_data) && !postData.includes(input_data)) return;
                            if (!/(fetchPlaylist|playlist)/i.test(requestInfo.operationName + ' ' + url) && !varsText.includes('spotify:playlist:')) return;
                            capturedPlaylistRequests.push({
                                url,
                                method: request.method(),
                                headers: request.headers(),
                                postData,
                                variables: requestInfo.variables,
                                operationName: requestInfo.operationName
                            });
                            if (capturedPlaylistRequests.length > 20) capturedPlaylistRequests.shift();
                        } catch (_) {}
                    });

                    const pendingNetworkReads = new Set();
                    page.on('response', response => {
                        const task = (async () => {
                            try {
                                const url = response.url();
                                const relevantUrl = /playlist|pathfinder\/v1\/query|\/items(?:\?|\/|$)|\/tracks(?:\?|\/|$)/i.test(url);
                                if (!relevantUrl || response.status() !== 200) return;
                                const contentType = response.headers()['content-type'] || '';
                                if (!contentType.includes('application/json')) return;
                                const json = await response.json();
                                addCaptured(spotifyQueriesFromNetworkJson(json, url));
                                const contentInfo = spotifyPlaylistContentInfo(json);
                                if (contentInfo.total !== null) {
                                    spotifyReportedTotal = Math.max(spotifyReportedTotal || 0, contentInfo.total);
                                }
                            } catch (_) {}
                        })();
                        pendingNetworkReads.add(task);
                        task.finally(() => pendingNetworkReads.delete(task));
                    });

                    try {
                        await page.goto(`https://open.spotify.com/playlist/${input_data}`, {
                            waitUntil: 'domcontentloaded', timeout: 45000
                        });
                    } catch (_) {}
                    await new Promise(resolve => setTimeout(resolve, 2200));
                    try {
                        await page.evaluate(() => {
                            const button = document.querySelector('#onetrust-accept-btn-handler');
                            if (button) button.click();
                        });
                    } catch (_) {}

                    await new Promise(resolve => setTimeout(resolve, 600));
                    if (pendingNetworkReads.size) {
                        await Promise.allSettled([...pendingNetworkReads]);
                    }
                    const matchingRequests = capturedPlaylistRequests.filter(item => {
                        const variables = item.variables || {};
                        const uri = String(variables.uri || variables.playlistUri || '');
                        return uri === `spotify:playlist:${input_data}`
                            || uri.endsWith(`:${input_data}`)
                            || JSON.stringify(variables).includes(input_data);
                    }).sort((a, b) => {
                        const score = item => {
                            const operation = String(item.operationName || '');
                            const vars = item.variables || {};
                            let value = 0;
                            if (/^fetchPlaylist$/i.test(operation)) value += 100;
                            else if (/fetchPlaylist/i.test(operation)) value += 60;
                            if (Number.isFinite(Number(vars.offset))) value += 10;
                            if (Number.isFinite(Number(vars.limit)) && Number(vars.limit) > 0) value += 10;
                            if (vars.uri === `spotify:playlist:${input_data}`) value += 10;
                            return value;
                        };
                        return score(b) - score(a);
                    });

                    let playlistRequest = null;
                    let firstPartnerPage = null;
                    let browserPaginationComplete = false;
                    for (const candidate of matchingRequests) {
                        const testPage = await fetchSpotifyPartnerPlaylistPageInBrowser(page, candidate, 0);
                        const testInfo = testPage?.data ? spotifyPlaylistContentInfo(testPage.data) : { items: [], total: null };
                        if (testPage?.status === 200 && testInfo.items.length > 0) {
                            playlistRequest = candidate;
                            firstPartnerPage = testPage;
                            if (testInfo.total !== null) {
                                spotifyReportedTotal = Math.max(spotifyReportedTotal || 0, testInfo.total);
                            }
                            break;
                        }
                    }

                    if (playlistRequest) {
                        const variableLimit = Number(playlistRequest.variables?.limit);
                        const pageSize = Number.isFinite(variableLimit) && variableLimit > 0
                            ? Math.min(variableLimit, 100) : 50;
                        let offset = 0;
                        let priorPageSignature = '';
                        let partnerPages = 0;
                        while (partnerPages < 100) {
                            const pageResult = partnerPages === 0
                                ? firstPartnerPage
                                : await fetchSpotifyPartnerPlaylistPageInBrowser(page, playlistRequest, offset);
                            if (!pageResult || pageResult.status !== 200 || !pageResult.data) {
                                break;
                            }
                            const contentInfo = spotifyPlaylistContentInfo(pageResult.data);
                            const pageItems = contentInfo.items;
                            if (contentInfo.total !== null) {
                                spotifyReportedTotal = Math.max(spotifyReportedTotal || 0, contentInfo.total);
                            }
                            if (!pageItems.length) {
                                break;
                            }
                            const signature = pageItems.map(item => item?.uid || item?.itemV2?.data?.uri || item?.itemV2?.data?.id || item?.item?.uri || item?.uri || '').join('|');
                            if (partnerPages > 0 && signature && signature === priorPageSignature) {
                                break;
                            }
                            priorPageSignature = signature;
                            addCaptured(spotifyQueriesFromItems(pageItems));
                            partnerPages++;
                            offset += pageItems.length;

                            if (spotifyReportedTotal !== null && offset >= spotifyReportedTotal) {
                                browserPaginationComplete = true;
                                break;
                            }

                            if (pageItems.length < pageSize && (spotifyReportedTotal === null || offset >= spotifyReportedTotal)) {
                                break;
                            }
                        }
                    }

                    let scrollAttempts = 0;
                    let lastSize = capturedTracks.size;
                    let noNewCount = 0;
                    const maxScrollAttempts = spotifyReportedTotal && spotifyReportedTotal > 500 ? 260 : 180;
                    const maxStagnantScrolls = spotifyReportedTotal && capturedTracks.size < spotifyReportedTotal ? 40 : 22;
                    while (!browserPaginationComplete && scrollAttempts < maxScrollAttempts && noNewCount < maxStagnantScrolls) {
                        const domTracks = await page.evaluate(() => {
                            const candidates = Array.from(document.querySelectorAll(
                                '[data-testid="tracklist-row"], [data-testid="playlist-track"], [role="row"]'
                            ));
                            const rows = candidates.filter(row => row.querySelector(
                                'a[data-testid="internal-track-link"], [data-testid="track-name"] a, a[href*="/track/"]'
                            ));
                            const extracted = [];
                            rows.forEach(row => {
                                const titleNode = row.querySelector('a[data-testid="internal-track-link"]')
                                    || row.querySelector('[data-testid="track-name"] a')
                                    || row.querySelector('a[href*="/track/"]')
                                    || row.querySelector('[data-testid="track-name"]');
                                if (!titleNode) return;
                                const title = (titleNode.innerText || titleNode.textContent || '').trim();
                                const artistNodes = row.querySelectorAll(
                                    'a[data-testid="creator-link"], span[data-testid="creator-link"], a[href*="/artist/"]'
                                );
                                const artist = Array.from(artistNodes)
                                    .map(node => (node.innerText || node.textContent || '').trim())
                                    .filter(Boolean).join(', ');
                                if (title) extracted.push(`${artist ? `${artist} - ` : ''}${title}`.trim());
                            });
                            return extracted;
                        });
                        addCaptured(domTracks);

                        if (capturedTracks.size === lastSize) noNewCount++;
                        else {
                            noNewCount = 0;
                            lastSize = capturedTracks.size;
                        }

                        await page.evaluate((stagnantCount) => {

                            const main = document.querySelector('[role="main"]')
                                || document.querySelector('.os-viewport')
                                || document.querySelector('[data-testid="playlist-page"]')?.parentElement;
                            if (main && main.scrollHeight > main.clientHeight) {
                                main.scrollTop = Math.min(main.scrollTop + 1000, main.scrollHeight);
                            }
                            const candidates = Array.from(document.querySelectorAll(
                                '[data-testid="tracklist-row"], [data-testid="playlist-track"], [role="row"]'
                            ));
                            const rows = candidates.filter(row => row.querySelector(
                                'a[data-testid="internal-track-link"], [data-testid="track-name"] a, a[href*="/track/"]'
                            ));
                            const lastRow = rows[rows.length - 1];
                            const scrollables = Array.from(document.querySelectorAll('*')).filter(element => {
                                const style = window.getComputedStyle(element);
                                return element.clientHeight > 100
                                    && element.scrollHeight > element.clientHeight + 80
                                    && /(auto|scroll|overlay)/.test(style.overflowY + ' ' + style.overflow);
                            }).sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));

                            for (const element of scrollables.slice(0, 4)) {
                                element.scrollTop = Math.min(
                                    element.scrollTop + Math.max(900, Math.floor(element.clientHeight * 0.9)),
                                    element.scrollHeight
                                );
                            }
                            if (lastRow) lastRow.scrollIntoView({ block: 'end', behavior: 'instant' });
                            window.scrollBy(0, Math.max(900, Math.floor(window.innerHeight * 0.85)));
                            if (stagnantCount > 0 && stagnantCount % 5 === 0) {
                                const active = scrollables[0] || main;
                                if (active) active.scrollTop = active.scrollHeight;
                                window.scrollTo(0, document.body.scrollHeight);
                            }
                        }, noNewCount);
                        try { await page.mouse.wheel({ deltaY: 1200 }); } catch (_) {}
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        scrollAttempts++;
                    }

                    if (pendingNetworkReads.size) {
                        await Promise.allSettled([...pendingNetworkReads]);
                    }
                    raw_queries.push(...capturedTracks.values());
                } finally {
                    await browser.close();
                }
            } catch (error) {
                console.warn(`[Playlist Import] Spotify browser fallback failed: ${error.message}`);
            }
        }

        raw_queries = dedupeTrackQueries(raw_queries);
        if (!raw_queries.length) {
            throw new Error('Could not extract tracks from Spotify. Check the playlist URL, Spotify availability, or API credentials.');
        }
    } else if (source_type === 'youtube') {
        const yt = await Innertube.create();
        let playlist;
        let initialPlaylistError = null;
        try {
            playlist = await yt.music.getPlaylist(input_data);
        } catch (error) {
            initialPlaylistError = error;
            if (!puppeteer) throw error;
            console.warn(`[Playlist Import] YouTube Music library parsing failed; trying browser extraction: ${error.message}`);
            playlist = { items: [], has_continuation: false };
        }
        const seenContinuationKeys = new Set();
        const collected = new Map();
        const addVideoItems = items => {
            if (!Array.isArray(items)) return 0;
            let added = 0;
            for (const entry of items) {
                if (!entry || typeof entry !== 'object') continue;
                const track = entry.track || entry;
                const title = providerText(track.title || track.name || track.flex_columns?.[0]?.title
                    || entry.title || entry.name || entry.overlayMetadata?.title || '');
                const artistCandidates = Array.isArray(track.artists) ? track.artists
                    : (Array.isArray(track.authors) ? track.authors
                    : (Array.isArray(track.author) ? track.author : []));
                const artists = artistCandidates.map(item => providerText(item?.name || item?.title || item?.text || item))
                    .filter(Boolean).join(', ');
                const artist = artists || providerText(track.subtitle || track.author || track.artist || entry.subtitle || '');
                const query = makeTrackQuery(artist, title);
                if (!query) continue;

                const videoId = providerText(track.video_id || track.videoId || entry.video_id || entry.videoId
                    || track.endpoint?.payload?.videoId || entry.endpoint?.payload?.videoId
                    || track.navigation_endpoint?.payload?.videoId || entry.navigation_endpoint?.payload?.videoId
                    || track.overlayMetadata?.contentId || entry.overlayMetadata?.contentId || '');
                const normalizedQuery = normalizeTrackQuery(query);
                const key = videoId ? `video:${videoId}` : `query:${normalizedQuery}`;
                if (!collected.has(key)) {
                    collected.set(key, query);
                    added++;
                }
            }
            return added;
        };

        const initialItems = Array.isArray(playlist.items) ? playlist.items
            : (Array.isArray(playlist.videos) ? playlist.videos : []);
        addVideoItems(initialItems);
        const countCandidates = [playlist.item_count, playlist.itemCount, playlist.estimated_item_count,
            playlist.estimatedItemCount, playlist.total_items, playlist.totalItems];
        let expectedCount = null;
        for (const candidate of countCandidates) {
            const value = Number(providerText(candidate));
            if (Number.isFinite(value) && value > 0) {
                expectedCount = value;
                break;
            }
        }

        let pageCount = 0;
        let stagnantPages = 0;
        while (playlist?.has_continuation && pageCount < 1000) {
            const continuationKey = providerText(playlist.continuation
                || playlist.continuation_endpoint?.payload?.token
                || playlist.continuation_endpoint?.continuation
                || '');
            if (continuationKey && seenContinuationKeys.has(continuationKey)) break;
            if (continuationKey) seenContinuationKeys.add(continuationKey);

            try {
                const nextPage = await playlist.getContinuation();
                if (!nextPage) break;
                const nextItems = Array.isArray(nextPage.items) ? nextPage.items
                    : (Array.isArray(nextPage.videos) ? nextPage.videos : []);
                const added = addVideoItems(nextItems);
                stagnantPages = added === 0 ? stagnantPages + 1 : 0;
                playlist = nextPage;
                pageCount++;
                if (stagnantPages >= 5) {
                    console.warn(`[Playlist Import] YouTube Music pagination stopped after ${pageCount} pages without new unique tracks.`);
                    break;
                }
            } catch (error) {
                console.warn(`[Playlist Import] YouTube Music continuation stopped after ${collected.size} unique tracks: ${error.message}`);
                break;
            }
        }

        let libraryQueries = dedupeTrackQueries(Array.from(collected.values()));
        const countLooksWrong = !!initialPlaylistError
            || (expectedCount !== null && Math.abs(libraryQueries.length - expectedCount) > 2)
            || (initialItems.length >= 50 && !playlist?.has_continuation && libraryQueries.length <= initialItems.length + 2)
            || (playlist?.has_continuation === true)
            || (expectedCount === null && initialItems.length >= 100 && libraryQueries.length < initialItems.length - 2);

        if (puppeteer && countLooksWrong) {
            let browserQueries = [];
            try {
                const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
                try {
                    const page = await browser.newPage();
                    await page.setViewport({ width: 1280, height: 920 });
                    page.setDefaultNavigationTimeout(45000);
                    try {
                        await page.goto(`https://music.youtube.com/playlist?list=${encodeURIComponent(input_data)}`, {
                            waitUntil: 'domcontentloaded', timeout: 45000
                        });
                    } catch (navigationError) {
                        console.warn('[Playlist Import] YouTube Music page navigation was incomplete; continuing with any loaded rows:', navigationError.message);
                    }
                    await new Promise(resolve => setTimeout(resolve, 1800));

                    const browserTracks = new Map();
                    const readRows = async () => await page.evaluate(() => {
                        const rows = Array.from(document.querySelectorAll('ytmusic-responsive-list-item-renderer, ytmusic-playlist-panel-video-renderer'));
                        return rows.map(row => {
                            const titleNode = row.querySelector('a[href*="watch?v="], yt-formatted-string.title, #video-title, [class*="title"] a');
                            const title = (titleNode?.innerText || titleNode?.textContent || '').trim();
                            const titleHref = titleNode?.getAttribute('href') || '';
                            const idMatch = titleHref.match(/[?&]v=([^&]+)/) || titleHref.match(/\/watch\/([^/?]+)/);
                            const artistNodes = Array.from(row.querySelectorAll('yt-formatted-string[title], a[href*="/channel/"], a[href*="/browse/"]'));
                            const artists = artistNodes.map(node => (node.innerText || node.textContent || '').trim())
                                .filter(Boolean).filter(text => text !== title);
                            const primaryArtist = artists[0] || '';
                            return { id: idMatch ? decodeURIComponent(idMatch[1]) : '', title, artist: primaryArtist };
                        }).filter(item => item.title);
                    });

                    let noNewCount = 0;
                    let previousSize = 0;
                    for (let attempt = 0; attempt < 160 && noNewCount < 10; attempt++) {
                        const rows = await readRows();
                        for (const row of rows) {
                            const query = makeTrackQuery(row.artist, row.title);
                            const key = row.id ? `video:${row.id}` : `query:${normalizeTrackQuery(query)}`;
                            if (query && !browserTracks.has(key)) browserTracks.set(key, query);
                        }
                        if (browserTracks.size === previousSize) noNewCount++;
                        else {
                            previousSize = browserTracks.size;
                            noNewCount = 0;
                        }
                        await page.evaluate(() => {
                            const rows = Array.from(document.querySelectorAll('ytmusic-responsive-list-item-renderer, ytmusic-playlist-panel-video-renderer'));
                            const lastRow = rows[rows.length - 1];
                            if (lastRow) lastRow.scrollIntoView({ block: 'end', behavior: 'instant' });
                            window.scrollBy(0, Math.max(700, Math.floor(window.innerHeight * 0.75)));
                            const list = document.querySelector('ytmusic-playlist-section-renderer #contents, ytmusic-section-list-renderer #contents');
                            if (list) list.scrollTop = list.scrollHeight;
                        });
                        await new Promise(resolve => setTimeout(resolve, 650));
                    }
                    browserQueries = dedupeTrackQueries(Array.from(browserTracks.values()));
                } finally {
                    await browser.close();
                }
            } catch (error) {
                console.warn(`[Playlist Import] YouTube Music browser fallback failed: ${error.message}`);
            }

            if (browserQueries.length && (expectedCount === null || Math.abs(browserQueries.length - expectedCount) <= 2
                || libraryQueries.length > browserQueries.length + 20)) {
                libraryQueries = browserQueries;
            } else if (browserQueries.length > libraryQueries.length) {

                libraryQueries = dedupeTrackQueries([...libraryQueries, ...browserQueries]);
            }
        }
        raw_queries = libraryQueries;
        if (!raw_queries.length && initialPlaylistError) {
            throw new Error(`Could not extract tracks from YouTube Music playlist "${input_data}". The playlist may be unavailable or the YouTube Music parser failed: ${initialPlaylistError.message}`);
        }
        if (!raw_queries.length) {
            throw new Error(`Could not extract tracks from YouTube Music playlist "${input_data}". Check the playlist URL and make sure the playlist is publicly accessible.`);
        }
    } else if (source_type === 'apple') {
        let activeToken = aDevToken;

        if (!activeToken && puppeteer) {
            try {
                const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
                try {
                    const page = await browser.newPage();
                    await page.goto(`https://music.apple.com/us/playlist/${input_data}`, { waitUntil: 'domcontentloaded' });
                    await new Promise(resolve => setTimeout(resolve, 2000));

                    const mkToken = await page.evaluate(() => {
                        try {
                            if (window.MusicKit && window.MusicKit.getInstance) {
                                const inst = window.MusicKit.getInstance();
                                if (inst && inst.developerToken) return inst.developerToken;
                            }
                        } catch(e) {}

                        try {
                            const meta = document.querySelector('meta[name="apple:client-data"]');
                            if (meta) {
                                const data = JSON.parse(meta.content);
                                if (data && data.mediaApiToken) return data.mediaApiToken;
                                if (data && data.token) return data.token;
                            }
                        } catch(e) {}

                        return null;
                    });

                    if (mkToken) activeToken = mkToken;
                } finally {
                    await browser.close();
                }
            } catch (e) {
                console.error("Puppeteer Apple token extraction error:", e);
            }
        }

        if (!activeToken) {
            try {
                const response = await axios.get(`https://music.apple.com/us/playlist/${input_data}`, { headers: { 'User-Agent': defaultUA }, timeout: 10000 });

                const webStateMatch = response.data.match(/<script[^>]+id="web-navigation-state"[^>]*>([\s\S]*?)<\/script>/i);
                if (webStateMatch) {
                    try {
                        const state = JSON.parse(webStateMatch[1]);
                        if (state?.storefronts?.token) activeToken = state.storefronts.token;
                    } catch(e) {}
                }

                if (!activeToken) {
                    const metaMatch = response.data.match(/<meta\s+name="[^"]*config\/environment"\s+content="([^"]+)"/i);
                    if (metaMatch) {
                        try {
                            const config = JSON.parse(decodeURIComponent(metaMatch[1]));
                            activeToken = config?.MEDIA_API?.token || config?.musicweb?.token || config?.token;
                        } catch (e) {}
                    }
                }

                if (!activeToken) {
                    const jwtMatches = response.data.match(/eyJhbGciOiJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g);
                    if (jwtMatches) {
                        const validMatch = jwtMatches.find(t => t.length > 150);
                        if (validMatch) activeToken = validMatch;
                    }
                }
            } catch (err) {}
        }

        let apiComplete = false;
        if (activeToken) {
            let url = `https://api.music.apple.com/v1/catalog/us/playlists/${input_data}/tracks?limit=100`;
            const visitedUrls = new Set();
            let pageCount = 0;

            while (url && pageCount < 500) {
                if (visitedUrls.has(url)) break;
                visitedUrls.add(url);
                pageCount++;

                try {
                    const response = await axios.get(url, {
                        headers: {
                            'Authorization': `Bearer ${activeToken}`,
                            'Origin': 'https://music.apple.com'
                        },
                        timeout: 10000
                    });

                    const items = response.data?.data || [];
                    if (!Array.isArray(items)) break;
                    if (items.length === 0) {
                        apiComplete = !response.data?.next;
                        break;
                    }

                    for (const item of items) {
                        if (item.attributes) {
                            const trackName = item.attributes.name || '';
                            const artistName = item.attributes.artistName || '';
                            if (trackName) raw_queries.push(`${artistName ? `${artistName} - ` : ''}${trackName}`.trim());
                        }
                    }

                    let nextPath = response.data?.next;
                    if (nextPath) {
                        let nextUrl = nextPath.startsWith('http') ? nextPath : `https://api.music.apple.com${nextPath}`;
                        if (!nextUrl.includes('limit=')) {
                            nextUrl += (nextUrl.includes('?') ? '&' : '?') + 'limit=100';
                        }
                        url = (nextUrl !== url) ? nextUrl : null;
                    } else {
                        url = null;
                        apiComplete = true;
                    }
                } catch (err) {
                    break;
                }
            }
        }

        const shouldSupplementApple = true;
        if (shouldSupplementApple) {
            const targetUrls = [`https://embed.music.apple.com/us/playlist/${input_data}`, `https://music.apple.com/us/playlist/${input_data}`];
            for (const targetUrl of targetUrls) {
                try {
                    const response = await axios.get(targetUrl, { headers: { 'User-Agent': defaultUA }, timeout: 12000 });
                    const html = typeof response.data === 'string' ? response.data : '';
                    const scrapedSet = new Map();
                    for (const existing of raw_queries) {
                        const key = normalizeTrackQuery(existing);
                        if (key && !scrapedSet.has(key)) scrapedSet.set(key, existing);
                    }
                    let foundOnPage = 0;
                    const addAppleTrack = (artist, title) => {
                        const query = makeTrackQuery(artist, title);
                        const key = normalizeTrackQuery(query);
                        if (query && key && !scrapedSet.has(key)) {
                            scrapedSet.set(key, query);
                            foundOnPage++;
                        }
                    };

                    const ldMatches = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
                    for (const match of ldMatches) {
                        try {
                            const ld = JSON.parse(match[1]);
                            const resources = Array.isArray(ld) ? ld : [ld];
                            for (const resource of resources) {
                                const rawTracks = resource?.track || resource?.tracks || resource?.itemListElement || [];
                                const tracks = Array.isArray(rawTracks) ? rawTracks : [rawTracks];
                                for (const wrapper of tracks) {
                                    const item = wrapper?.item || wrapper;
                                    const title = providerText(item?.name || item?.title || '');
                                    const artist = providerText(item?.byArtist?.name
                                        || (Array.isArray(item?.byArtist) ? item.byArtist[0]?.name : '')
                                        || item?.author?.name || item?.author || '');
                                    addAppleTrack(artist, title);
                                }
                            }
                        } catch (_) {}
                    }

                    const fallbackMatches = [...html.matchAll(/<div[^>]*class=["'][^"']*songs-list-row__song-name[^"']*["'][^>]*>([^<]+)<\/div>[\s\S]*?<a[^>]*class=["'][^"']*songs-list-row__link[^"']*["'][^>]*>([^<]+)<\/a>/gi)];
                    for (const match of fallbackMatches) addAppleTrack(cleanTrackText(match[2]), cleanTrackText(match[1]));

                    if (scrapedSet.size > raw_queries.length) {
                        raw_queries = Array.from(scrapedSet.values());
                    }
                    if (foundOnPage > 0) break;
                } catch (_) {}
            }

            if (puppeteer) {
                try {
                    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
                    try {
                        const page = await browser.newPage();
                        await page.setViewport({ width: 1280, height: 920 });
                        try {
                            await page.goto(`https://music.apple.com/us/playlist/${input_data}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
                        } catch (navigationError) {
                            console.warn('[Playlist Import] Apple Music page navigation was incomplete; continuing with any loaded rows:', navigationError.message);
                        }
                        await new Promise(resolve => setTimeout(resolve, 1800));

                        const trackSet = new Map();
                        for (const existing of raw_queries) {
                            const key = normalizeTrackQuery(existing);
                            if (key && !trackSet.has(key)) trackSet.set(key, existing);
                        }
                        let scrollAttempts = 0;
                        let lastSize = trackSet.size;
                        let noNewCount = 0;

                        while (scrollAttempts < 60 && noNewCount < 5) {
                            const tracks = await page.evaluate(() => {
                                const rows = document.querySelectorAll('.songs-list-row, [data-testid="tracklist-row"], [role="row"]');
                                const extracted = [];
                                rows.forEach(row => {
                                    const titleNode = row.querySelector('.songs-list-row__song-name, [data-testid="track-name"], a[href*="/song/"]');
                                    const artistNode = row.querySelector('.songs-list-row__by-line, .songs-list-row__link, [data-testid="track-artist"]');
                                    if (titleNode) {
                                        const title = (titleNode.innerText || titleNode.textContent || '').trim();
                                        const artist = artistNode ? (artistNode.innerText || artistNode.textContent || '').trim() : '';
                                        if (title) extracted.push({ artist, title });
                                    }
                                });
                                return extracted;
                            });

                            for (const track of tracks) {
                                const query = makeTrackQuery(track.artist, track.title);
                                const key = normalizeTrackQuery(query);
                                if (query && key && !trackSet.has(key)) trackSet.set(key, query);
                            }

                            if (trackSet.size === lastSize) {
                                noNewCount++;
                            } else {
                                noNewCount = 0;
                                lastSize = trackSet.size;
                            }

                            await page.evaluate(() => {
                                const rows = document.querySelectorAll('.songs-list-row, [data-testid="tracklist-row"], [role="row"]');
                                const lastRow = rows[rows.length - 1];
                                if (lastRow) lastRow.scrollIntoView({ block: 'end', behavior: 'instant' });
                                window.scrollBy(0, 900);
                                const container = document.querySelector('.songs-list, [data-testid="tracklist"]');
                                if (container) container.scrollTop = container.scrollHeight;
                            });
                            await new Promise(resolve => setTimeout(resolve, 700));
                            scrollAttempts++;
                        }

                        if (trackSet.size > raw_queries.length) {
                            raw_queries = Array.from(trackSet.values());
                            }
                    } finally {
                        await browser.close();
                    }
                } catch (e) {
                    console.error("Puppeteer Apple fallback error:", e);
                }
            }

        }

        raw_queries = dedupeTrackQueries(raw_queries);
        if (!raw_queries.length) {
            throw new Error(`Could not extract tracks from Apple Music playlist "${input_data}". The playlist may be invalid, unavailable, or inaccessible without a valid Apple Music API Developer Token.`);
        }
    }

    return dedupeTrackQueries(raw_queries);
}

module.exports = {
    extractPlaylistId,
    fetchProviderPlaylistTracks
};
