// ==UserScript==
// @name         Torn Mini Happy Jump Assistant
// @namespace    https://github.com/jascheri/Torn-Mini-Happy-Jump-Helper
// @version      9.10
// @description  Mini Happy Jump planner with inventory tracking, cooldown guidance, and multi-tab sync.
// @author       You
// @match        https://www.torn.com/*
// @updateURL    https://raw.githubusercontent.com/jascheri/Torn-Mini-Happy-Jump-Helper/main/torn-mini-happy-jump-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/jascheri/Torn-Mini-Happy-Jump-Helper/main/torn-mini-happy-jump-helper.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.torn.com
// ==/UserScript==

(function () {
	'use strict';

	// Names are only used to recognise candies in the inventory; happiness/cooldown values come from Torn's item data (see loadCandyInfo).
	const CANDY_TYPES = {
		'bag of candy': {},
		'chocolate bar': {},
		'love hearts': {},
		'pixie sticks': {},
		'bag of chocolate truffles': {},
		'white chocolate': {},
		jawbreaker: {},
		peppermint: {}
	};

	const DEFAULT_DATA = {
		insuranceStartTime: null,
		currentDay: 1,
		step: 1,
		preSetupXanaxUsed: false,
		isMinimized: true,
		iconX: null,
		iconY: null,
		winX: null,
		winY: null,
		stock: {
			xanax: 0,
			ecstasy: 0,
			candies: {}
		},
		lastScraped: null,
		itemMap: {},
		counters: null,
		pending: { xan: 0, ext: 0, candies: {} }
	};

	const JUMP_STEPS = [
		{
			title: 'D1 7am: Full Jump',
			candies: 48,
			xanax: 0,
			ecstasy: 1,
			instructions: ['Eat 48 candies, take Ecstasy, then train with 400E.', 'Use the point refill, then train with 150E.', 'Wait for Ecstasy cooldown (200–231 minutes) to clear before the next drug.']
		},
		{
			title: 'D1 8pm: Half Jump',
			candies: 17,
			xanax: 1,
			ecstasy: 1,
			instructions: ['Let energy refill to full before taking Xanax.', 'Check that the shared drug cooldown is clear, take Xanax, then wait for Xanax cooldown (360–480 minutes) to clear.', 'Eat 17 candies, take Ecstasy, then train.', 'Wait for Ecstasy cooldown (200–231 minutes) to clear before the next drug.']
		},
		{
			title: 'D2 3pm: Full Jump',
			candies: 48,
			xanax: 1,
			ecstasy: 1,
			instructions: ['Let energy refill to full before taking Xanax.', 'Check that the shared drug cooldown is clear, take Xanax, then wait for Xanax cooldown (360–480 minutes) to clear.', 'Eat 48 candies, take Ecstasy, then train.', 'Use the point refill, then train again.', 'Wait for Ecstasy cooldown (200–231 minutes) to clear before the next drug.']
		},
		{
			title: 'D3 7am: Full Jump',
			candies: 48,
			xanax: 1,
			ecstasy: 1,
			instructions: ['Let energy refill to full before taking Xanax.', 'Check that the shared drug cooldown is clear, take Xanax, then wait for Xanax cooldown (360–480 minutes) to clear.', 'Eat 48 candies, take Ecstasy, then train.', 'Use the point refill, then train again.', 'Wait for Ecstasy cooldown (200–231 minutes) to clear before the next drug.']
		},
		{
			title: 'D4 7am: Final Full Jump',
			candies: 48,
			xanax: 1,
			ecstasy: 1,
			instructions: ['Let energy refill to full before taking Xanax.', 'Check that the shared drug cooldown is clear, take Xanax, then wait for Xanax cooldown (360–480 minutes) to clear.', 'Eat 48 candies, take Ecstasy, then train.', 'Use the point refill, then train again.', 'Finish training before the OD insurance expires.', 'Wait for Ecstasy cooldown (200–231 minutes) to clear before the next drug.']
		}
	];

	function normalizeData(data) {
		const stored = data && typeof data === 'object' ? data : {};
		const stock = stored.stock && typeof stored.stock === 'object' ? stored.stock : {};
		const candies = stock.candies && typeof stock.candies === 'object' && !Array.isArray(stock.candies) ? stock.candies : {};

		const pending = stored.pending && typeof stored.pending === 'object' ? stored.pending : {};
		const counters = stored.counters && Number.isFinite(stored.counters.xan) && Number.isFinite(stored.counters.ext) && Number.isFinite(stored.counters.candy) ? { xan: stored.counters.xan, ext: stored.counters.ext, candy: stored.counters.candy } : null;

		return {
			...DEFAULT_DATA,
			...stored,
			itemMap: stored.itemMap && typeof stored.itemMap === 'object' && !Array.isArray(stored.itemMap) ? { ...stored.itemMap } : {},
			counters,
			pending: {
				xan: Number.isInteger(pending.xan) && pending.xan >= 0 ? pending.xan : 0,
				ext: Number.isInteger(pending.ext) && pending.ext >= 0 ? pending.ext : 0,
				candies: pending.candies && typeof pending.candies === 'object' && !Array.isArray(pending.candies) ? { ...pending.candies } : {}
			},
			step: Number.isInteger(stored.step) && stored.step >= 1 && stored.step <= JUMP_STEPS.length ? stored.step : 1,
			preSetupXanaxUsed: stored.preSetupXanaxUsed === true,
			stock: {
				xanax: Number.isInteger(stock.xanax) && stock.xanax >= 0 ? stock.xanax : 0,
				ecstasy: Number.isInteger(stock.ecstasy) && stock.ecstasy >= 0 ? stock.ecstasy : 0,
				candies: { ...candies }
			}
		};
	}

	let jumpData = normalizeData(GM_getValue('torn_mhj_data', DEFAULT_DATA));

	let currentView = 'main';
	let manualToggles = {};
	let scanStatusMsg = '';

	function saveData() {
		GM_setValue('torn_mhj_data', jumpData);
	}

	// Automatic item-use tracking. Items used on the Items page are caught from the page's own request
	// (exact item, instant). Torn's lifetime counters (via the API key) then correct anything missed or miscounted.
	const AUTO_STORAGE = 'torn_mhj_auto';
	const DEBUG_STORAGE = 'torn_mhj_debug';
	let autoTrack = GM_getValue(AUTO_STORAGE, true) !== false;
	let debugLog = GM_getValue(DEBUG_STORAGE, false) === true;
	const lastHookHit = {};

	function dbg(...args) {
		if (debugLog) console.log('[MHJ]', ...args);
	}

	function deductCandies(count) {
		let remaining = count;
		for (const [cName, qty] of Object.entries(jumpData.stock.candies)) {
			const take = Math.min(qty, remaining);
			jumpData.stock.candies[cName] -= take;
			remaining -= take;
			if (jumpData.stock.candies[cName] <= 0) delete jumpData.stock.candies[cName];
			if (remaining === 0) break;
		}
	}

	function recordUse(kind, candyName) {
		const p = jumpData.pending;
		if (kind === 'xan') {
			jumpData.stock.xanax = Math.max(0, jumpData.stock.xanax - 1);
			p.xan += 1;
		} else if (kind === 'ext') {
			jumpData.stock.ecstasy = Math.max(0, jumpData.stock.ecstasy - 1);
			p.ext += 1;
		} else {
			if (jumpData.stock.candies[candyName] > 0) {
				jumpData.stock.candies[candyName] -= 1;
				if (jumpData.stock.candies[candyName] === 0) delete jumpData.stock.candies[candyName];
			} else {
				deductCandies(1);
			}
			p.candies[candyName] = (p.candies[candyName] || 0) + 1;
		}
		saveData();
		updateUI();
		if (kind !== 'candy' && apiKey) setTimeout(() => refreshApiState(true), 4000);
	}

	function reconcileCounters(stats) {
		const list = stats && Array.isArray(stats.personalstats) ? stats.personalstats : null;
		if (!list) return;
		const byName = {};
		list.forEach((s) => { byName[s.name] = Number(s.value); });
		const now = { xan: byName.xantaken, ext: byName.exttaken, candy: byName.candyused };
		if (![now.xan, now.ext, now.candy].every(Number.isFinite)) return;

		const prev = jumpData.counters;
		const p = jumpData.pending;
		if (prev) {
			const xanAdj = Math.max(0, now.xan - prev.xan) - p.xan;
			const extAdj = Math.max(0, now.ext - prev.ext) - p.ext;
			jumpData.stock.xanax = Math.max(0, jumpData.stock.xanax - xanAdj);
			jumpData.stock.ecstasy = Math.max(0, jumpData.stock.ecstasy - extAdj);

			const hookCandies = Object.values(p.candies).reduce((a, b) => a + b, 0);
			const candyAdj = Math.max(0, now.candy - prev.candy) - hookCandies;
			if (candyAdj > 0) {
				deductCandies(candyAdj);
			} else if (candyAdj < 0) {
				let refund = -candyAdj;
				for (const [cName, n] of Object.entries(p.candies)) {
					const give = Math.min(n, refund);
					jumpData.stock.candies[cName] = (jumpData.stock.candies[cName] || 0) + give;
					refund -= give;
					if (refund === 0) break;
				}
			}
			dbg('counter reconcile', { prev, now, pending: { ...p }, xanAdj, extAdj, candyAdj });
		} else {
			dbg('counter baseline', now);
		}
		jumpData.counters = now;
		jumpData.pending = { xan: 0, ext: 0, candies: {} };
		saveData();
		updateUI();
	}

	function bodyToParams(body) {
		try {
			if (typeof body === 'string') {
				if (body.trim().startsWith('{')) {
					const obj = JSON.parse(body);
					return new URLSearchParams(Object.entries(obj).map(([k, v]) => [k, String(v)]));
				}
				return new URLSearchParams(body);
			}
			if (body instanceof URLSearchParams) return body;
			if (typeof FormData !== 'undefined' && body instanceof FormData) {
				return new URLSearchParams(Array.from(body.entries()).filter(([, v]) => typeof v === 'string'));
			}
		} catch (e) { /* fall through */ }
		return new URLSearchParams();
	}

	function onItemRequest(url, params, responseText) {
		dbg('item request', { url, body: params.toString(), response: String(responseText).slice(0, 300) });
		if (!autoTrack) return;

		const itemId = params.get('itemID') || params.get('itemId') || params.get('item') || params.get('id');
		if (!itemId) return;
		const step = params.get('step');
		if (step && !/use/i.test(step)) return;

		let json = null;
		try { json = JSON.parse(responseText); } catch (e) { /* non-JSON response */ }
		if (json && json.success === false) return;
		if (/are you sure|do you want to/i.test(String(json && json.text ? json.text : responseText).slice(0, 400))) return;

		let kind = null;
		let candyName = null;
		if (itemId === '206') kind = 'xan';
		else if (itemId === '205') kind = 'ext';
		else if (jumpData.itemMap[itemId]) {
			kind = 'candy';
			candyName = jumpData.itemMap[itemId];
		}
		if (!kind) return;

		const nowMs = Date.now();
		if (lastHookHit[itemId] && nowMs - lastHookHit[itemId] < 1500) return;
		lastHookHit[itemId] = nowMs;
		recordUse(kind, candyName);
	}

	function installItemHook() {
		const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
		const isItemUrl = (u) => /item\.php|inventory/i.test(String(u));

		const origFetch = pageWin.fetch;
		if (typeof origFetch === 'function') {
			pageWin.fetch = function (input, init) {
				const p = origFetch.apply(this, arguments);
				try {
					const url = typeof input === 'string' ? input : (input && input.url) || '';
					const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
					if (method === 'POST' && isItemUrl(url)) {
						const params = bodyToParams(init && init.body);
						p.then((r) => r.clone().text()).then((t) => onItemRequest(url, params, t)).catch(() => {});
					}
				} catch (e) { /* never break the page's own request */ }
				return p;
			};
		}

		const XP = pageWin.XMLHttpRequest && pageWin.XMLHttpRequest.prototype;
		if (XP) {
			const origOpen = XP.open;
			const origSend = XP.send;
			XP.open = function (method, url) {
				this._mhj = { method: String(method).toUpperCase(), url: String(url) };
				return origOpen.apply(this, arguments);
			};
			XP.send = function (body) {
				const info = this._mhj;
				if (info && info.method === 'POST' && isItemUrl(info.url)) {
					const params = bodyToParams(body);
					this.addEventListener('load', () => {
						try { onItemRequest(info.url, params, this.responseText); } catch (e) { /* ignore */ }
					});
				}
				return origSend.apply(this, arguments);
			};
		}
	}

	// The API key lives in its own storage entry so it is never part of the synced jump state.
	const API_KEY_STORAGE = 'torn_mhj_api_key';
	const API_REFRESH_MS = 5 * 60 * 1000;
	const API_CACHE_STORAGE = 'torn_mhj_api_cache';
	const API_BAD_KEY_CODES = [2, 10, 13, 18];
	let apiKey = String(GM_getValue(API_KEY_STORAGE, '') || '');
	let apiState = { drugEnd: 0, energyFullAt: 0, fetchedAt: 0, error: '', loading: false };
	let apiTimer = null;

	function tornApiGet(path, query) {
		return new Promise((resolve, reject) => {
			GM_xmlhttpRequest({
				method: 'GET',
				url: `https://api.torn.com/v2${path}?${query ? `${query}&` : ''}comment=MiniHappyJumpHelper`,
				headers: { Authorization: `ApiKey ${apiKey}`, Accept: 'application/json' },
				timeout: 15000,
				onload: (res) => {
					let body;
					try {
						body = JSON.parse(res.responseText);
					} catch (e) {
						return reject(new Error('Bad API response'));
					}
					if (body && body.error) {
						const err = new Error(`API error ${body.error.code}: ${body.error.error}`);
						err.apiCode = body.error.code;
						return reject(err);
					}
					resolve(body);
				},
				onerror: () => reject(new Error('Network error')),
				ontimeout: () => reject(new Error('API request timed out'))
			});
		});
	}

	async function refreshApiState(force) {
		if (!apiKey || apiState.loading) return;
		if (!force && document.hidden) return;

		const cache = GM_getValue(API_CACHE_STORAGE, null);
		if (!force && cache && Date.now() - cache.fetchedAt < API_REFRESH_MS - 5000) {
			adoptApiCache(cache);
			return;
		}

		apiState.loading = true;
		try {
			const [cd, bars, stats] = await Promise.all([
				tornApiGet('/user/cooldowns'),
				tornApiGet('/user/bars'),
				// Counters are a best-effort safety net; a failure here must not hide cooldown data.
				tornApiGet('/user/personalstats', 'stat=xantaken,exttaken,candyused').catch((e) => {
					if (e.apiCode && API_BAD_KEY_CODES.includes(e.apiCode)) throw e;
					return null;
				})
			]);
			const now = Date.now();
			const fresh = {
				drugEnd: now + (Number(cd.cooldowns.drug) || 0) * 1000,
				energyFullAt: now + (Number(bars.bars.energy.full_time) || 0) * 1000,
				fetchedAt: now
			};
			GM_setValue(API_CACHE_STORAGE, fresh);
			adoptApiCache(fresh);
			reconcileCounters(stats);
		} catch (e) {
			apiState.error = e.message;
			// Torn requires dropping keys it rejects so repeated bad calls cannot get the IP banned.
			if (e.apiCode && API_BAD_KEY_CODES.includes(e.apiCode)) {
				apiKey = '';
				GM_setValue(API_KEY_STORAGE, '');
				if (apiTimer) clearInterval(apiTimer);
				apiTimer = null;
				apiState.error = `Key rejected by Torn (${e.message}) and removed. Add a new key in ⚙️.`;
			}
		}
		apiState.loading = false;
		tickTimers();
	}

	function adoptApiCache(cache) {
		apiState.drugEnd = cache.drugEnd;
		apiState.energyFullAt = cache.energyFullAt;
		apiState.fetchedAt = cache.fetchedAt;
		apiState.error = '';
		tickTimers();
	}

	function setApiKey(val) {
		apiKey = val;
		GM_setValue(API_KEY_STORAGE, val);
		GM_setValue(API_CACHE_STORAGE, null);
		apiState = { drugEnd: 0, energyFullAt: 0, fetchedAt: 0, error: '', loading: false };
		startApiPolling(true);
	}

	GM_addValueChangeListener(API_KEY_STORAGE, function (name, old_value, new_value, remote) {
		if (remote) {
			apiKey = String(new_value || '');
			apiState = { drugEnd: 0, energyFullAt: 0, fetchedAt: 0, error: '', loading: false };
			startApiPolling(false);
		}
	});

	GM_addValueChangeListener(API_CACHE_STORAGE, function (name, old_value, new_value, remote) {
		if (remote && new_value) adoptApiCache(new_value);
	});

	document.addEventListener('visibilitychange', () => {
		if (!document.hidden) refreshApiState(false);
	});

	// Real candy happiness/cooldown values, read once from Torn's item data and cached (item data rarely changes).
	const CANDY_INFO_STORAGE = 'torn_mhj_candy_info';
	const CANDY_INFO_TTL_MS = 7 * 24 * 60 * 60 * 1000;
	const CANDY_TRY_STORAGE = 'torn_mhj_candy_try';
	const CANDY_RETRY_MS = 60 * 60 * 1000;
	let candyInfo = GM_getValue(CANDY_INFO_STORAGE, null);
	let candyInfoLoading = false;

	function parseCandyEffect(effect) {
		const text = String(effect || '');
		const happy = text.match(/happ(?:y|iness)[^0-9]{0,40}(\d+)/i) || text.match(/(\d+)\s*happ/i);
		const cd = text.match(/cooldown[^0-9]{0,40}(\d+)(?:\s*(?:-|to)\s*(\d+))?\s*minutes?/i) || text.match(/(\d+)(?:\s*(?:-|to)\s*(\d+))?\s*minutes?\s*cooldown/i);
		return {
			happy: happy ? Number(happy[1]) : null,
			cd: cd ? (cd[2] ? `${cd[1]}-${cd[2]}` : String(cd[1])) : null
		};
	}

	function candyStatsText(name, withColor) {
		const info = candyInfo && candyInfo.items && candyInfo.items[String(name).toLowerCase()];
		if (!info || (info.happy === null && info.cd === null)) return '';
		const parts = [];
		if (info.happy !== null) parts.push(`+${info.happy}H`);
		if (info.cd !== null) parts.push(`${info.cd}m CD`);
		const text = ` (${parts.join(', ')})`;
		return withColor ? `<span style="color:#4caf50">${text}</span>` : text;
	}

	function unknownCandyNames() {
		const known = (candyInfo && candyInfo.items) || {};
		return Object.keys(jumpData.stock.candies).filter((n) => !(String(n).toLowerCase() in known));
	}

	async function loadCandyInfo() {
		if (!apiKey || candyInfoLoading) return;
		const fresh = candyInfo && candyInfo.fetchedAt && Date.now() - candyInfo.fetchedAt < CANDY_INFO_TTL_MS;
		const needsLookup = !fresh || unknownCandyNames().length > 0;
		if (!needsLookup) return;
		// Retry at most hourly so a candy Torn does not list cannot trigger repeated calls.
		const lastTry = Number(GM_getValue(CANDY_TRY_STORAGE, 0));
		if (Date.now() - lastTry < CANDY_RETRY_MS) return;
		GM_setValue(CANDY_TRY_STORAGE, Date.now());
		candyInfoLoading = true;
		try {
			const res = await tornApiGet('/torn/items', 'cat=Candy');
			const items = {};
			(res.items || []).forEach((it) => {
				items[String(it.name).toLowerCase()] = parseCandyEffect(it.effect);
				dbg('candy effect', it.name, '=>', it.effect);
			});
			candyInfo = { fetchedAt: Date.now(), items };
			GM_setValue(CANDY_INFO_STORAGE, candyInfo);
			updateUI();
		} catch (e) {
			dbg('candy info failed', e.message);
		}
		candyInfoLoading = false;
	}

	function startApiPolling(force) {
		if (apiTimer) clearInterval(apiTimer);
		apiTimer = null;
		if (!apiKey) return;
		refreshApiState(force);
		loadCandyInfo();
		apiTimer = setInterval(() => refreshApiState(false), API_REFRESH_MS);
	}

	function formatDuration(ms) {
		const total = Math.max(0, Math.ceil(ms / 1000));
		const h = Math.floor(total / 3600);
		const m = Math.floor((total % 3600) / 60);
		const s = total % 60;
		return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
	}

	function renderApiStatusHtml() {
		if (apiState.error) {
			return `<div style="font-size:10px; color:#f44336; margin-bottom:6px;">${apiState.error}</div>`;
		}
		if (!apiKey) {
			return '<div style="font-size:10px; color:#aaa; margin-bottom:6px;">Add a Torn API key in ⚙️ to show drug cooldown and energy.</div>';
		}
		if (apiState.error) {
			return `<div style="font-size:10px; color:#f44336; margin-bottom:6px;">${apiState.error}</div>`;
		}
		if (!apiState.fetchedAt) {
			return '<div style="font-size:10px; color:#aaa; margin-bottom:6px;">Loading cooldown…</div>';
		}
		const now = Date.now();
		const drugLeft = apiState.drugEnd - now;
		const energyLeft = apiState.energyFullAt - now;
		const drugHtml = drugLeft > 0 ? `<span class="mhj-expired">${formatDuration(drugLeft)}</span>` : '<span class="mhj-ok">Ready</span>';
		const energyHtml = energyLeft > 0 ? `<span style="color:#ffca28;">${formatDuration(energyLeft)} to full</span>` : '<span class="mhj-ok">Full</span>';
		return `
            <div class="mhj-row" style="font-size:11px; background:#222; padding:4px; border-radius:4px;">
                <span>💊 Drug CD: ${drugHtml}</span>
                <span>⚡ ${energyHtml}</span>
            </div>`;
	}

	GM_addValueChangeListener('torn_mhj_data', function (name, old_value, new_value, remote) {
		if (remote && new_value) {
			jumpData = normalizeData(new_value);
			applyPositions();
			updateUI();
		}
	});

	const style = document.createElement('style');
	style.innerHTML = `
        #mhj-icon {
            position: fixed;
            width: 42px;
            height: 42px;
            padding: 0;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: grab;
            background: #2e7d32;
            border: 2px solid #4caf50;
            color: #fff;
            font-size: 18px;
            z-index: 99999;
            box-shadow: 0 4px 10px rgba(0,0,0,0.5);
            user-select: none;
        }
        #mhj-icon:active { cursor: grabbing; }
        #mhj-icon:hover { background: #388e3c; }

        #mhj-window {
            position: fixed;
            width: 320px;
            background: rgba(30, 30, 30, 0.95);
            color: #fff;
            border: 1px solid #444;
            border-radius: 8px;
            padding: 12px;
            font-family: Arial, sans-serif;
            font-size: 12px;
            z-index: 99999;
            box-shadow: 0 4px 10px rgba(0,0,0,0.5);
            user-select: none;
        }
        #mhj-header {
            margin: 0 0 8px 0;
            font-size: 14px;
            color: #4caf50;
            display: flex;
            justify-content: space-between;
            align-items: center;
            cursor: grab;
        }
        #mhj-header:active { cursor: grabbing; }
        .mhj-controls-right {
            display: flex;
            gap: 6px;
            align-items: center;
        }
        .mhj-action-btn {
            background: none;
            border: none;
            color: #aaa;
            cursor: pointer;
            font-size: 13px;
            padding: 0;
            line-height: 1;
        }
        .mhj-action-btn:hover { color: #fff; }

        .mhj-row {
            margin-bottom: 6px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .mhj-btn {
            background: #2e7d32;
            color: #fff;
            border: none;
            padding: 6px 8px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 11px;
            margin-top: 6px;
            width: 100%;
        }
        .mhj-btn:hover { background: #388e3c; }
        .mhj-btn-reset { background: #c62828; margin-top: 4px; }
        .mhj-btn-reset:hover { background: #d32f2f; }

        .mhj-input {
            width: 60px;
            background: #222;
            border: 1px solid #555;
            color: #fff;
            padding: 4px;
            border-radius: 4px;
            font-size: 12px;
            text-align: center;
        }

        .mhj-step-list {
            background: #222;
            border: 1px solid #333;
            border-radius: 6px;
            padding: 6px;
            margin: 8px 0;
            max-height: 220px;
            overflow-y: auto;
        }
        .mhj-step-container {
            border-bottom: 1px solid #333;
            margin-bottom: 4px;
            padding-bottom: 4px;
        }
        .mhj-step-container:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }

        .mhj-step-header {
            padding: 5px;
            background: #2a2a2a;
            border-radius: 4px;
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 11px;
        }
        .mhj-step-header:hover { background: #333; }
        .mhj-step-active-header {
            background: rgba(46, 125, 50, 0.4);
            border-left: 3px solid #4caf50;
        }
        .mhj-step-body {
            padding: 6px 8px;
            font-size: 10.5px;
            color: #ccc;
            background: #1e1e1e;
            border-radius: 0 0 4px 4px;
            display: none;
        }
        .mhj-step-body.open { display: block; }
        .mhj-action-line {
            margin-bottom: 3px;
            display: flex;
            justify-content: space-between;
        }
        .mhj-candy-sub {
            font-size: 10px;
            color: #aaa;
            padding-left: 10px;
            border-left: 2px solid #444;
            margin: 2px 0;
        }
        .mhj-ok { color: #4caf50; font-weight: bold; }
        .mhj-expired { color: #f44336; font-weight: bold; }
    `;
	document.head.appendChild(style);

	const iconEl = document.createElement('div');
	iconEl.id = 'mhj-icon';
	iconEl.innerHTML = `⚡`;
	iconEl.title = 'Click to open Mini Happy Jump Assistant';
	document.body.appendChild(iconEl);

	const winEl = document.createElement('div');
	winEl.id = 'mhj-window';
	document.body.appendChild(winEl);

	let timerInterval = null;

	function applyPositions() {
		if (typeof jumpData.iconX === 'number' && typeof jumpData.iconY === 'number' && !isNaN(jumpData.iconX)) {
			iconEl.style.left = `${jumpData.iconX}px`;
			iconEl.style.top = `${jumpData.iconY}px`;
			iconEl.style.right = 'auto';
			iconEl.style.transform = 'none';
		} else {
			iconEl.style.right = '25px';
			iconEl.style.top = '50%';
			iconEl.style.left = 'auto';
			iconEl.style.transform = 'translateY(-50%)';
		}

		if (typeof jumpData.winX === 'number' && typeof jumpData.winY === 'number' && !isNaN(jumpData.winX)) {
			winEl.style.left = `${jumpData.winX}px`;
			winEl.style.top = `${jumpData.winY}px`;
			winEl.style.right = 'auto';
			winEl.style.bottom = 'auto';
		} else {
			winEl.style.right = '80px';
			winEl.style.top = '80px';
			winEl.style.left = 'auto';
		}
	}

	function getTotalCandyCount() {
		return Object.values(jumpData.stock.candies).reduce((a, b) => a + b, 0);
	}

	function parseStockInput(input) {
		const value = Number(input.value);
		return Number.isInteger(value) && value >= 0 ? value : null;
	}

	function scrapeDataAttributes(isAutomatic = false) {
		const items = Array.from(document.querySelectorAll('li[data-item][data-qty]')).filter((el) => el.getClientRects().length > 0);
		if (items.length === 0) {
			scanStatusMsg = 'No visible inventory rows found. Existing stock was kept unchanged.';
			updateUI();
			if (!isAutomatic) {
				alert('No visible inventory items found! Make sure you are on item.php with your items loaded.');
			}
			return false;
		}

		let foundXan = 0;
		let foundExt = 0;
		let foundCandies = {};
		let foundCandyIds = {};

		items.forEach((el) => {
			const itemId = el.getAttribute('data-item');
			const qty = Number.parseInt(el.getAttribute('data-qty'), 10);
			if (!Number.isInteger(qty) || qty < 0) return;
			const sortName = (el.getAttribute('data-sort') || el.innerText || '').toLowerCase();
			const category = (el.getAttribute('data-category') || '').toLowerCase();

			if (itemId === '206' || sortName.includes('xanax')) {
				foundXan += qty;
			} else if (itemId === '205' || sortName.includes('ecstasy')) {
				foundExt += qty;
			} else if (category === 'candy' || sortName.includes('candy') || sortName.includes('chocolate') || sortName.includes('hearts') || sortName.includes('sticks') || sortName.includes('jawbreaker') || sortName.includes('peppermint')) {
				let matchedName = null;
				for (const cName of Object.keys(CANDY_TYPES)) {
					if (sortName.includes(cName)) {
						matchedName = cName;
						break;
					}
				}
				const keyName = matchedName || sortName.trim() || 'other candy';
				foundCandies[keyName] = (foundCandies[keyName] || 0) + qty;
				foundCandyIds[itemId] = keyName;
			}
		});

		jumpData.stock.xanax = foundXan;
		jumpData.stock.ecstasy = foundExt;
		jumpData.stock.candies = foundCandies;
		jumpData.itemMap = { ...jumpData.itemMap, ...foundCandyIds };
		// The scan is exact, so restart counter tracking from the next API reading.
		jumpData.counters = null;
		jumpData.pending = { xan: 0, ext: 0, candies: {} };
		jumpData.lastScraped = new Date().toLocaleTimeString();
		scanStatusMsg = `Inventory synced: ${foundXan} Xanax, ${foundExt} Ecstasy, ${getTotalCandyCount()} candies.`;
		saveData();
		updateUI();
		loadCandyInfo();
		if (apiKey) refreshApiState(true);
		if (!isAutomatic) {
			alert(`Successfully synced! Xanax: ${foundXan}, Ecstasy: ${foundExt}, Candies: ${getTotalCandyCount()}`);
		}
		return true;
	}

	function scheduleAutomaticInventorySync() {
		if (window.location.pathname !== '/item.php') return;

		const startedAt = Date.now();
		let lastRowCount = 0;
		let stablePolls = 0;
		const poll = setInterval(() => {
			const rowCount = document.querySelectorAll('li[data-item][data-qty]').length;
			stablePolls = rowCount > 0 && rowCount === lastRowCount ? stablePolls + 1 : 0;
			lastRowCount = rowCount;

			if (rowCount > 0 && stablePolls >= 3 && Date.now() - startedAt >= 4000) {
				clearInterval(poll);
				scrapeDataAttributes(true);
			} else if (Date.now() - startedAt >= 20000) {
				clearInterval(poll);
				scanStatusMsg = 'Inventory did not finish loading in time. Use [Sync] to try again.';
				updateUI();
			}
		}, 1000);
	}

	function getInsuranceDisplay() {
		if (!jumpData.insuranceStartTime) return { text: 'Not Active', cls: '' };
		const remaining = 3 * 24 * 60 * 60 * 1000 - (Date.now() - jumpData.insuranceStartTime);
		if (remaining <= 0) return { text: 'EXPIRED', cls: 'mhj-expired' };
		return { text: `${formatDuration(remaining)} left`, cls: 'mhj-ok' };
	}

	// Updates only the ticking text so the panel (and its scroll position) is not rebuilt every second.
	function tickTimers() {
		if (jumpData.isMinimized || currentView !== 'main') return;
		const insEl = document.getElementById('mhj-ins-status');
		const apiEl = document.getElementById('mhj-api-status');
		if (insEl) {
			const ins = getInsuranceDisplay();
			insEl.className = ins.cls;
			insEl.textContent = ins.text;
		}
		if (apiEl) apiEl.innerHTML = renderApiStatusHtml();
	}

	function updateUI() {
		if (timerInterval) clearInterval(timerInterval);
		applyPositions();

		if (jumpData.isMinimized) {
			iconEl.style.display = 'flex';
			winEl.style.display = 'none';
			return;
		}

		iconEl.style.display = 'none';
		winEl.style.display = 'block';

		if (currentView === 'settings') {
			winEl.innerHTML = `
                <div id="mhj-header">
                    <span>⚙️ Settings</span>
                    <div class="mhj-controls-right">
                        <button class="mhj-action-btn" id="mhj-back-btn" title="Back">⬅️</button>
                    </div>
                </div>
                <div style="font-size:11px; color:#aaa; margin-bottom:8px;">
                    Torn API key (Minimal access is enough). Used only to read your drug cooldown, energy bar and item-use counters from api.torn.com. It is stored locally in Tampermonkey, is not shared with anyone, and is never synced into the jump data.
                </div>
                <div style="position:relative;">
                    <input type="password" id="mhj-api-key" class="mhj-input" style="width:100%; box-sizing:border-box; text-align:left; padding-right:28px;" placeholder="Paste API key" value="${apiKey.replace(/[^A-Za-z0-9]/g, '')}" autocomplete="off">
                    <button class="mhj-action-btn" id="mhj-toggle-key" title="Show key" type="button" style="position:absolute; right:6px; top:50%; transform:translateY(-50%); font-size:14px;">👁️</button>
                </div>
                <button class="mhj-btn" id="mhj-save-key">Save Key</button>
                <button class="mhj-btn mhj-btn-reset" id="mhj-clear-key">Remove Key</button>
                <div style="font-size:10px; color:#aaa; margin-top:6px;">Create one at <a href="https://www.torn.com/preferences.php#tab=api" style="color:#4caf50;" target="_blank">Preferences → API</a>.</div>
                <div style="border-top:1px solid #444; margin-top:10px; padding-top:8px; font-size:11px; color:#aaa;">
                    <label style="display:block; margin-bottom:4px; cursor:pointer;"><input type="checkbox" id="mhj-auto-track" ${autoTrack ? 'checked' : ''}> Auto-track item use (Items page + API counters). When on, completing a jump no longer deducts items.</label>
                    <label style="display:block; cursor:pointer;"><input type="checkbox" id="mhj-debug" ${debugLog ? 'checked' : ''}> Debug logging (browser console, prefix [MHJ])</label>
                </div>
            `;
			document.getElementById('mhj-auto-track').onchange = (e) => {
				autoTrack = e.target.checked;
				GM_setValue(AUTO_STORAGE, autoTrack);
			};
			document.getElementById('mhj-debug').onchange = (e) => {
				debugLog = e.target.checked;
				GM_setValue(DEBUG_STORAGE, debugLog);
			};
			document.getElementById('mhj-back-btn').onclick = () => {
				currentView = 'main';
				updateUI();
			};
			document.getElementById('mhj-toggle-key').onclick = () => {
				const input = document.getElementById('mhj-api-key');
				const btn = document.getElementById('mhj-toggle-key');
				const show = input.type === 'password';
				input.type = show ? 'text' : 'password';
				btn.textContent = show ? '🙈' : '👁️';
				btn.title = show ? 'Hide key' : 'Show key';
			};
			document.getElementById('mhj-save-key').onclick = () => {
				const val = document.getElementById('mhj-api-key').value.trim();
				if (!/^[A-Za-z0-9]{16}$/.test(val)) {
					alert('A Torn API key is 16 letters and numbers.');
					return;
				}
				setApiKey(val);
				currentView = 'main';
				updateUI();
			};
			document.getElementById('mhj-clear-key').onclick = () => {
				setApiKey('');
				currentView = 'main';
				updateUI();
			};
			return;
		}

		const totalCandies = getTotalCandyCount();

		if (currentView === 'stock') {
			let candyBreakdownHtml = '';
			const editorNames = Array.from(new Set([...Object.keys(CANDY_TYPES), ...Object.keys(jumpData.stock.candies)]));
			for (const cName of editorNames) {
				const count = jumpData.stock.candies[cName] || 0;
				candyBreakdownHtml += `
                    <div class="mhj-row" style="font-size:10.5px; margin-bottom:3px;">
                        <span style="text-transform:capitalize;">${cName}${candyStatsText(cName, false)}:</span>
                        <input type="number" data-candy="${cName}" class="mhj-input edit-candy-qty" value="${count}" style="width:50px;">
                    </div>
                `;
			}

			winEl.innerHTML = `
                <div id="mhj-header">
                    <span>📦 Manual Stock Backup</span>
                    <div class="mhj-controls-right">
                        <button class="mhj-action-btn" id="mhj-back-btn" title="Back">⬅️</button>
                    </div>
                </div>
                <div style="font-size:11px; color:#aaa; margin-bottom:8px;">
                    Inventory auto-syncs on the <a href="https://www.torn.com/item.php" style="color:#4caf50;" target="_blank">Items</a> page after its rows load. Use [Sync] to retry or override below:
                </div>
                ${scanStatusMsg ? `<div style="font-size:10px; color:#ffca28; margin-bottom:6px;">${scanStatusMsg}</div>` : ''}
                <div class="mhj-row">
                    <span>Xanax:</span>
                    <input type="number" min="0" step="1" id="edit-xan" class="mhj-input" value="${jumpData.stock.xanax}">
                </div>
                <div class="mhj-row">
                    <span>Ecstasy:</span>
                    <input type="number" min="0" step="1" id="edit-ext" class="mhj-input" value="${jumpData.stock.ecstasy}">
                </div>
                <div style="font-size:11px; color:#4caf50; margin: 6px 0 2px 0; font-weight:bold;">Candy Breakdown:</div>
                <div style="max-height:100px; overflow-y:auto; border:1px solid #444; padding:4px; border-radius:4px; background:#222;">
                    ${candyBreakdownHtml}
                </div>
                <button class="mhj-btn" id="mhj-save-stock" style="margin-top:8px;">Save Override</button>
            `;

			document.getElementById('mhj-back-btn').onclick = () => {
				currentView = 'main';
				updateUI();
			};
			document.getElementById('mhj-save-stock').onclick = () => {
				const xanax = parseStockInput(document.getElementById('edit-xan'));
				const ecstasy = parseStockInput(document.getElementById('edit-ext'));
				const candyInputs = Array.from(document.querySelectorAll('.edit-candy-qty'));
				const candyValues = candyInputs.map((input) => parseStockInput(input));
				if (xanax === null || ecstasy === null || candyValues.includes(null)) {
					alert('Stock counts must be whole numbers greater than or equal to zero.');
					return;
				}

				jumpData.stock.xanax = xanax;
				jumpData.stock.ecstasy = ecstasy;
				candyInputs.forEach((input, index) => {
					const name = input.getAttribute('data-candy');
					const val = candyValues[index];
					if (val > 0) {
						jumpData.stock.candies[name] = val;
					} else {
						delete jumpData.stock.candies[name];
					}
				});

				saveData();
				currentView = 'main';
				updateUI();
			};
			return;
		}

		const insurance = getInsuranceDisplay();
		const prevListScroll = winEl.querySelector && winEl.querySelector('.mhj-step-list') ? winEl.querySelector('.mhj-step-list').scrollTop : 0;

		winEl.innerHTML = `
            <div id="mhj-header">
                <span>⚡ Mini Happy Jump</span>
                <div class="mhj-controls-right">
                    <button class="mhj-action-btn" id="mhj-sync-btn" title="Retry inventory sync from the current Items page" style="color:#4caf50; font-size:11px; text-decoration:underline; cursor:pointer; background:none; border:none;">[Sync]</button>
                    <button class="mhj-action-btn" id="mhj-stock-btn" title="Manual Backup">📦</button>
                    <button class="mhj-action-btn" id="mhj-settings-btn" title="Settings (API key)">⚙️</button>
                    <span style="font-size:10px; color:#aaa;" title="Drag header">≡</span>
                    <button class="mhj-action-btn" id="mhj-minimize-btn" title="Minimize">🗕</button>
                </div>
            </div>
            <div class="mhj-row">
                <span>OD Insurance:</span>
                <span id="mhj-ins-status" class="${insurance.cls}">${insurance.text}</span>
            </div>
            <div class="mhj-row" style="font-size:11px; background:#222; padding:4px; border-radius:4px;">
                <span>🎒 Stock: <b style="color:#4caf50">${totalCandies}</b> Candies | <b style="color:#4caf50">${jumpData.stock.xanax}</b> Xan | <b style="color:#4caf50">${jumpData.stock.ecstasy}</b> E</span>
            </div>
            <div id="mhj-api-status">${renderApiStatusHtml()}</div>
            ${scanStatusMsg ? `<div style="font-size:10px; color:#ffca28; margin-bottom:6px;">${scanStatusMsg}</div>` : ''}
            <div class="mhj-step-body open" style="margin:6px 0;">
                <b>Before-bed pre-setup:</b> let energy refill to full, take 1 Xanax, then sleep. Xanax cooldown is 360–480 minutes; wait until Torn shows it has cleared before the next drug.
                <button class="mhj-btn" id="mhj-pre-setup" ${jumpData.preSetupXanaxUsed ? 'disabled' : ''}>
                    ${jumpData.preSetupXanaxUsed ? 'Bedtime Xanax Marked Used' : `Mark Bedtime Xanax Used (${jumpData.stock.xanax} / 1)`}
                </button>
            </div>

            <div class="mhj-step-list">
                ${JUMP_STEPS.map((step, index) => renderAccordionStep(step, index + 1, jumpData.step)).join('')}
            </div>

            <button class="mhj-btn" id="mhj-next-btn">Mark Current Jump Completed ➔</button>
            <div style="font-size:10px; color:#aaa;">Completing a jump advances the checklist; items are deducted automatically as you use them (or on completion if auto-track is off in ⚙️). Complete it only after the cooldown waits and actions are done.</div>
            ${!jumpData.insuranceStartTime ? '<button class="mhj-btn" id="mhj-start-ins" style="background:#0277bd;">Start 3-Day Insurance Clock</button>' : ''}
            <button class="mhj-btn mhj-btn-reset" id="mhj-reset-btn">Reset Cycle</button>
        `;

		for (let i = 1; i <= JUMP_STEPS.length; i++) {
			const headerEl = document.getElementById(`mhj-step-hdr-${i}`);
			if (headerEl) {
				headerEl.onclick = () => {
					const isActive = i === jumpData.step;
					const currentlyOpen = manualToggles[i] !== undefined ? manualToggles[i] : isActive;
					manualToggles[i] = !currentlyOpen;
					updateUI();
				};
			}
		}

		document.getElementById('mhj-sync-btn').onclick = (e) => {
			e.stopPropagation();
			scrapeDataAttributes();
		};

		document.getElementById('mhj-stock-btn').onclick = (e) => {
			e.stopPropagation();
			currentView = 'stock';
			updateUI();
		};
		document.getElementById('mhj-settings-btn').onclick = (e) => {
			e.stopPropagation();
			currentView = 'settings';
			updateUI();
		};
		document.getElementById('mhj-minimize-btn').onclick = (e) => {
			e.stopPropagation();
			jumpData.isMinimized = true;
			saveData();
			updateUI();
		};

		document.getElementById('mhj-pre-setup').onclick = () => {
			if (jumpData.preSetupXanaxUsed) return;
			if (!autoTrack) {
				if (jumpData.stock.xanax < 1) {
					alert('Not enough Xanax in tracked stock. Sync or update your stock before marking the pre-setup.');
					return;
				}
				jumpData.stock.xanax -= 1;
			}
			jumpData.preSetupXanaxUsed = true;
			saveData();
			updateUI();
		};

		document.getElementById('mhj-next-btn').onclick = () => {
			const step = JUMP_STEPS[jumpData.step - 1];
			// With auto-tracking on, stock is already deducted as items are used, so completing only advances the step.
			if (!autoTrack) {
				const totalAvailableCandies = getTotalCandyCount();
				if (totalAvailableCandies < step.candies || jumpData.stock.xanax < step.xanax || jumpData.stock.ecstasy < step.ecstasy) {
					alert(`Not enough tracked stock for ${step.title}. Need ${step.candies} candies, ${step.xanax} Xanax, and ${step.ecstasy} Ecstasy.`);
					return;
				}
				deductCandies(step.candies);
				jumpData.stock.xanax -= step.xanax;
				jumpData.stock.ecstasy -= step.ecstasy;
			}
			const completedCycle = jumpData.step === JUMP_STEPS.length;
			jumpData.step = (jumpData.step % JUMP_STEPS.length) + 1;
			if (completedCycle) {
				jumpData.preSetupXanaxUsed = false;
				jumpData.insuranceStartTime = null;
			}
			manualToggles = {};
			saveData();
			updateUI();
		};

		if (document.getElementById('mhj-start-ins')) {
			document.getElementById('mhj-start-ins').onclick = () => {
				jumpData.insuranceStartTime = Date.now();
				saveData();
				updateUI();
			};
		}

		document.getElementById('mhj-reset-btn').onclick = () => {
			if (confirm('Reset Mini Happy Jump progress and insurance timer?')) {
				jumpData = normalizeData(DEFAULT_DATA);
				manualToggles = {};
				saveData();
				updateUI();
			}
		};

		const listEl = winEl.querySelector('.mhj-step-list');
		if (listEl) listEl.scrollTop = prevListScroll;

		if (jumpData.insuranceStartTime || apiKey) {
			timerInterval = setInterval(tickTimers, 1000);
		}
	}

	function renderAccordionStep(step, stepNum, currentStep) {
		const isActive = stepNum === currentStep;
		const isDone = stepNum < currentStep;

		const totalCandies = getTotalCandyCount();
		const candyColor = totalCandies < step.candies ? '#f44336' : '#4caf50';
		const xanColor = jumpData.stock.xanax < step.xanax ? '#f44336' : '#4caf50';
		const extColor = jumpData.stock.ecstasy < step.ecstasy ? '#f44336' : '#4caf50';

		let isOpen = isActive;
		if (manualToggles[stepNum] !== undefined) {
			isOpen = manualToggles[stepNum];
		}

		let candySubsHtml = '';
		if (Object.keys(jumpData.stock.candies).length > 0) {
			for (const [cName, count] of Object.entries(jumpData.stock.candies)) {
				candySubsHtml += `<div class="mhj-candy-sub">• ${count}x ${cName}${candyStatsText(cName, true)}</div>`;
			}
		} else {
			candySubsHtml = `<div class="mhj-candy-sub" style="color:#f44336">• No candies in stock</div>`;
		}

		return `
            <div class="mhj-step-container">
                <div id="mhj-step-hdr-${stepNum}" class="mhj-step-header ${isActive ? 'mhj-step-active-header' : ''}">
                    <span>${isDone ? '✅ ' : isActive ? '▶ ' : '▫ '}${step.title}</span>
                    <span style="font-size:9px; color:#aaa;">${isOpen ? '▲' : '▼'}</span>
                </div>
                <div class="mhj-step-body ${isOpen ? 'open' : ''}">
                    <div class="mhj-action-line">
                        <span>• Candy needed</span>
                        <span style="color:${candyColor}">(${totalCandies} / ${step.candies})</span>
                    </div>
                    ${candySubsHtml}
                    <div class="mhj-action-line">
                        <span>• Xanax needed</span>
                        <span style="color:${xanColor}">(${jumpData.stock.xanax} / ${step.xanax})</span>
                    </div>
                    <div class="mhj-action-line" style="margin-top:4px;">
                        <span>• Ecstasy needed</span>
                        <span style="color:${extColor}">(${jumpData.stock.ecstasy} / ${step.ecstasy})</span>
                    </div>
                    <div style="margin-top:5px; color:#ccc;">
                        ${step.instructions.map((instruction) => `<div>• ${instruction}</div>`).join('')}
                    </div>
                </div>
            </div>
        `;
	}

	// Drag Logic for Icon
	let iconDragging = false,
		iconMoved = false,
		iconStartX,
		iconStartY;
	iconEl.onmousedown = (e) => {
		iconDragging = true;
		iconMoved = false;
		if (jumpData.iconX === null) {
			const rect = iconEl.getBoundingClientRect();
			iconEl.style.left = `${rect.left}px`;
			iconEl.style.top = `${rect.top}px`;
			iconEl.style.right = 'auto';
			iconEl.style.transform = 'none';
		}
		iconStartX = e.clientX - iconEl.offsetLeft;
		iconStartY = e.clientY - iconEl.offsetTop;
		e.preventDefault();
	};

	document.addEventListener('mousemove', (e) => {
		if (!iconDragging) return;
		iconMoved = true;
		let newX = Math.max(0, Math.min(e.clientX - iconStartX, window.innerWidth - iconEl.offsetWidth));
		let newY = Math.max(0, Math.min(e.clientY - iconStartY, window.innerHeight - iconEl.offsetHeight));
		iconEl.style.left = `${newX}px`;
		iconEl.style.top = `${newY}px`;
	});

	document.addEventListener('mouseup', () => {
		if (iconDragging) {
			iconDragging = false;
			jumpData.iconX = iconEl.offsetLeft;
			jumpData.iconY = iconEl.offsetTop;
			saveData();
			if (!iconMoved) {
				jumpData.isMinimized = false;
				saveData();
				updateUI();
			}
		}
	});

	// Drag Logic for Window
	let winDragging = false,
		winStartX,
		winStartY;
	winEl.onmousedown = (e) => {
		const header = document.getElementById('mhj-header');
		if (header && (e.target === header || header.contains(e.target))) {
			if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
			if (jumpData.winX === null) {
				const rect = winEl.getBoundingClientRect();
				winEl.style.left = `${rect.left}px`;
				winEl.style.top = `${rect.top}px`;
				winEl.style.right = 'auto';
			}
			winDragging = true;
			winStartX = e.clientX - winEl.offsetLeft;
			winStartY = e.clientY - winEl.offsetTop;
			e.preventDefault();
		}
	};

	document.addEventListener('mousemove', (e) => {
		if (!winDragging) return;
		let newX = Math.max(0, Math.min(e.clientX - winStartX, window.innerWidth - winEl.offsetWidth));
		let newY = Math.max(0, Math.min(e.clientY - winStartY, window.innerHeight - winEl.offsetHeight));
		winEl.style.left = `${newX}px`;
		winEl.style.top = `${newY}px`;
	});

	document.addEventListener('mouseup', () => {
		if (winDragging) {
			winDragging = false;
			jumpData.winX = winEl.offsetLeft;
			jumpData.winY = winEl.offsetTop;
			saveData();
		}
	});

	applyPositions();
	updateUI();
	scheduleAutomaticInventorySync();
	startApiPolling();
	installItemHook();
})();
