
(() => {
    if (!document.getElementById('catalog-table')) return;

function saveCatalogPreferences() {
    try {
        localStorage.setItem(catalogPreferencesKey, JSON.stringify({
            search: document.getElementById('search-input').value,
            filter: document.getElementById('library-filter').value,
            sort: document.getElementById('sort-by').value,
            order: document.getElementById('sort-order').value,
            limit: document.getElementById('page-limit').value,
            page: currentPage
        }));
    } catch (_) {

    }
}

function restoreCatalogPreferences() {
    try {
        const saved = JSON.parse(localStorage.getItem(catalogPreferencesKey) || 'null');
        if (!saved || typeof saved !== 'object') return;
        const filter = document.getElementById('library-filter');
        const sort = document.getElementById('sort-by');
        const order = document.getElementById('sort-order');
        const limit = document.getElementById('page-limit');
        const search = document.getElementById('search-input');
        if (saved.filter && Array.from(filter.options).some(option => option.value === saved.filter)) filter.value = saved.filter;
        if (saved.sort && Array.from(sort.options).some(option => option.value === saved.sort)) sort.value = saved.sort;
        if (saved.order && Array.from(order.options).some(option => option.value === saved.order)) order.value = saved.order;
        if (saved.limit && Array.from(limit.options).some(option => option.value === saved.limit)) limit.value = saved.limit;
        if (typeof saved.search === 'string') search.value = saved.search;
        currentPage = Number.isSafeInteger(Number(saved.page)) && Number(saved.page) > 0 ? Number(saved.page) : 1;
    } catch (_) {
        currentPage = 1;
    }
}

function loadCatalog() {
    const q = document.getElementById('search-input').value;
    const sort = document.getElementById('sort-by').value;
    const order = document.getElementById('sort-order').value;
    const filter = document.getElementById('library-filter').value;
    const limit = document.getElementById('page-limit').value;
    saveCatalogPreferences();
    const requestToken = ++catalogRequestToken;
    if (catalogAbortController) catalogAbortController.abort();
    catalogAbortController = new AbortController();
    const tbody = document.getElementById('catalog-table');
    tbody.innerHTML = `<tr><td colspan="4" class="p-6 text-center text-xs text-[#7a7d90]"><span class="inline-flex items-center justify-center gap-2"><span class="inline-block w-3 h-3 border-2 border-[#216281] border-t-[#00BBFC] rounded-full animate-spin"></span>Loading catalog…</span></td></tr>`;

    fetch(`/api/catalog?q=${encodeURIComponent(q)}&sort=${encodeURIComponent(sort)}&order=${encodeURIComponent(order)}&library_filter=${encodeURIComponent(filter)}&page=${currentPage}&limit=${encodeURIComponent(limit)}`, { signal: catalogAbortController.signal })
        .then(r => {
            if (!r.ok) throw new Error(`Catalog request failed (${r.status}).`);
            return r.json();
        })
        .then(data => {
            if (requestToken !== catalogRequestToken) return;
            if (!data || !Array.isArray(data.tracks) || !data.stats) throw new Error('The catalog response was incomplete.');
            renderCatalogTable(data.tracks);
            updatePaginationUI(data.stats);
            saveCatalogPreferences();
        })
        .catch(err => {
            if (err && err.name === 'AbortError') return;
            if (requestToken !== catalogRequestToken) return;
            tbody.innerHTML = `<tr><td colspan="4" class="p-6 text-center text-xs text-[#ff80a8]">${escapeHtml(err.message || 'Could not load the catalog.')}</td></tr>`;
        });
}

function renderCatalogTable(tracks) {
    const tbody = document.getElementById('catalog-table');
    tbody.innerHTML = '';

    if (tracks.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="p-6 text-center text-xs text-[#7a7d90]">No matching tracks found.</td></tr>`;
        return;
    }

    tracks.forEach(track => {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-[#1d202f]/30 transition-colors cursor-pointer sm:cursor-default';
        tr.setAttribute('onclick', `toggleMobileRow(${Number(track.id)})`);
        tr.innerHTML = `
            <td class="p-4 font-medium text-[#f1f2f6]">
                <div class="flex items-center justify-between gap-2">
                    <div class="min-w-0 truncate max-w-[180px] sm:max-w-xs font-semibold text-[#fcfcfc]">
                        ${escapeHtml(track.title)}
                        <div class="sm:hidden text-xs text-[#b4b7c5] font-normal truncate mt-0.5">${escapeHtml(track.artist || '')}</div>
                    </div>
                    <button type="button" class="sm:hidden text-[#7a7d90] hover:text-[#d5d7e0] ml-1 p-1 shrink-0" aria-label="Show track details" tabindex="-1">
                        <svg id="chevron-${Number(track.id)}" class="w-4 h-4 transform transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                    </button>
                </div>
            </td>
            <td class="p-4 text-[#b4b7c5] truncate max-w-[150px] hidden sm:table-cell">${escapeHtml(track.artist || '')}</td>
            <td class="p-4 text-[#7a7d90] truncate max-w-[180px] hidden sm:table-cell">${escapeHtml(track.album || '')}</td>
            <td class="p-4 text-right pr-4 sm:pr-6" onclick="event.stopPropagation()">
                <button type="button" data-track-id="${Number(track.id)}" data-in-library="${track.in_library ? 'true' : 'false'}" onclick="toggleTrack(${Number(track.id)})" class="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${track.in_library ? 'bg-[#330816] hover:bg-[#66112c] text-[#ff80a8] border border-[#66112c]' : 'bg-[#003B63] hover:bg-[#0092FC] text-[#00BBFC] border border-[#0092FC]'}">
                    ${track.in_library ? 'Remove' : 'Add'}
                </button>
            </td>
        `;
        tbody.appendChild(tr);

        const details = document.createElement('tr');
        details.id = `details-${Number(track.id)}`;
        details.className = 'hidden sm:hidden bg-[#000000]/80 border-b border-[#216281]/80';
        const durationSeconds = Number(track.duration);
        const durationLabel = Number.isFinite(durationSeconds) && durationSeconds > 0
            ? `${Math.floor(durationSeconds / 60)}:${String(Math.floor(durationSeconds % 60)).padStart(2, '0')}`
            : '';
        const formatLabel = String(track.format || '').trim();
        details.innerHTML = `
            <td colspan="2" class="p-3 text-xs space-y-1.5">
                <div><span class="text-[#7a7d90] uppercase font-semibold text-[10px]">Album:</span> <span class="text-[#d5d7e0] ml-1 break-words">${escapeHtml(track.album || 'Unknown album')}</span></div>
                <div><span class="text-[#7a7d90] uppercase font-semibold text-[10px]">${durationLabel ? 'Track Length:' : 'Format:'}</span> <span class="text-[#d5d7e0] ml-1 break-words">${escapeHtml(durationLabel || formatLabel || 'Unknown')}</span></div>
            </td>
        `;
        tbody.appendChild(details);
    });
}

function toggleMobileRow(trackId) {
    if (window.matchMedia('(min-width: 640px)').matches) return;
    const details = document.getElementById(`details-${Number(trackId)}`);
    const chevron = document.getElementById(`chevron-${Number(trackId)}`);
    if (!details) return;
    const opening = details.classList.contains('hidden');
    details.classList.toggle('hidden', !opening);
    if (chevron) chevron.classList.toggle('rotate-180', opening);
}

function updatePaginationUI(stats) {
    totalTracks = stats.total;
    totalPages = stats.totalPages;
    currentPage = stats.page;

    document.getElementById('stat-total').innerText = stats.total;
    document.getElementById('stat-library').innerText = stats.library;

    const start = stats.filtered === 0 ? 0 : (currentPage - 1) * (stats.limit === 'all' ? stats.filtered : stats.limit) + 1;
    const end = stats.limit === 'all' ? stats.filtered : Math.min(currentPage * stats.limit, stats.filtered);

    document.getElementById('page-start-count').innerText = start;
    document.getElementById('page-end-count').innerText = end;
    document.getElementById('page-total-count').innerText = stats.filtered;
    document.getElementById('page-indicator').innerText = `Page ${currentPage} of ${totalPages}`;

    document.getElementById('btn-first-page').disabled = currentPage <= 1;
    document.getElementById('btn-prev-page').disabled = currentPage <= 1;
    document.getElementById('btn-next-page').disabled = currentPage >= totalPages;
    document.getElementById('btn-last-page').disabled = currentPage >= totalPages;
}

function handleSearchInput() {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
        currentPage = 1;
        loadCatalog();
    }, 300);
}

function resetPageAndLoad() { currentPage = 1; loadCatalog(); }
function handleSortByChange() {
    currentPage = 1;

    if (document.getElementById('sort-by').value === 'added') {
        document.getElementById('sort-order').value = 'desc';
    }
    loadCatalog();
}
function changePage(delta) { goToPage(currentPage + delta); }
function goToPage(page) {
    if (page >= 1 && page <= totalPages) {
        currentPage = page;
        loadCatalog();
    }
}

function styleCatalogTrackButton(button, inLibrary) {
    button.className = `px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${inLibrary
        ? 'bg-[#330816] hover:bg-[#66112c] text-[#ff80a8] border border-[#66112c]'
        : 'bg-[#003B63] hover:bg-[#0092FC] text-[#00BBFC] border border-[#0092FC]'}`;
}

async function toggleTrack(trackId) {
    const button = document.querySelector(`button[data-track-id="${Number(trackId)}"]`);
    if (!button || button.disabled) return;
    const wasInLibrary = button.dataset.inLibrary === 'true';
    button.disabled = true;
    button.innerText = wasInLibrary ? 'Removing…' : 'Adding…';
    try {
        const response = await fetch('/api/user/toggle-track', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ track_id: Number(trackId) })
        });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.message || `Could not ${wasInLibrary ? 'remove' : 'add'} this track.`);
        const inLibrary = !!result.in_library;
        button.dataset.inLibrary = inLibrary ? 'true' : 'false';
        button.innerText = inLibrary ? 'Remove' : 'Add';
        styleCatalogTrackButton(button, inLibrary);
        const count = document.getElementById('stat-library');
        if (count && inLibrary !== wasInLibrary) {
            const current = Number.parseInt(count.innerText, 10) || 0;
            count.innerText = String(Math.max(0, current + (inLibrary ? 1 : -1)));
        }
        const filter = document.getElementById('library-filter').value;
        if ((inLibrary && filter === 'unadded') || (!inLibrary && filter === 'added')) {
            currentPage = 1;
            loadCatalog();
            return;
        }
        button.disabled = false;
    } catch (error) {
        button.innerText = wasInLibrary ? 'Remove' : 'Add';
        styleCatalogTrackButton(button, wasInLibrary);
        button.disabled = false;
        showAlert('Library Update Failed', error.message || 'Could not update this track in your library.', false);
    }
}

    Object.assign(window, {
        saveCatalogPreferences, restoreCatalogPreferences, loadCatalog, renderCatalogTable,
        toggleMobileRow, updatePaginationUI, handleSearchInput, resetPageAndLoad,
        handleSortByChange, changePage, goToPage, styleCatalogTrackButton, toggleTrack
    });
})();
