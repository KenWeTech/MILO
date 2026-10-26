
(() => {
    if (!document.getElementById('organizer-review-modal')) return;

function openOrganizerReviewModal() {
    showManagedModal('organizer-review-modal', 'organizer-review-list', 'Loading organizer review…');
    loadOrganizerReview(1);
}

function closeOrganizerReviewModal() {
    organizerReviewLoadToken++;
    closeManagedModal('organizer-review-modal');
}

function organizerReviewFilters() {
    return {
        kind: document.getElementById('organizer-review-kind')?.value || 'all',
        search: document.getElementById('organizer-review-search')?.value.trim() || '',
        location: document.getElementById('organizer-review-location')?.value || 'all',
        limit: document.getElementById('organizer-review-limit')?.value || '50'
    };
}

function organizerReviewFiltersChanged() {
    if (organizerReviewSearchDebounce) clearTimeout(organizerReviewSearchDebounce);
    organizerSelectedIds.clear();
    organizerSelectAllFiltered = false;
    organizerReviewCurrentPage = 1;
    loadOrganizerReview(1);
}

function queueOrganizerReviewSearch() {
    if (organizerReviewSearchDebounce) clearTimeout(organizerReviewSearchDebounce);
    organizerReviewSearchDebounce = setTimeout(organizerReviewFiltersChanged, 300);
}

function refreshOrganizerReviewCount() {
    const badge = document.getElementById('organizer-review-count');
    if (!badge) return;
    fetch('/api/admin/organizer/review?limit=10')
        .then(r => r.json())
        .then(data => { if (data.success) badge.innerText = String(data.count || 0); })
        .catch(() => {});
}

function loadOrganizerReview(page = organizerReviewCurrentPage) {
    const list = document.getElementById('organizer-review-list');
    if (!list) return;
    const loadToken = ++organizerReviewLoadToken;
    const modalToken = modalRequestGeneration;
    const filters = organizerReviewFilters();
    const requestedPage = Math.max(1, Number(page) || 1);
    list.innerHTML = '<div class="text-sm text-[#7a7d90]">Loading organizer review items...</div>';
    const query = new URLSearchParams({ kind: filters.kind, q: filters.search, location: filters.location, page: String(requestedPage), limit: filters.limit });
    fetch(`/api/admin/organizer/review?${query.toString()}`)
        .then(r => r.json())
        .then(data => {
            if (loadToken !== organizerReviewLoadToken || !isManagedModalCurrent('organizer-review-modal', modalToken)) return;
            if (!data.success) {
                list.innerHTML = `<div class="text-sm text-[#ff80a8]">${escapeHtml(data.message || 'Unable to load review items.')}</div>`;
                return;
            }
            const badge = document.getElementById('organizer-review-count');
            if (badge) badge.innerText = String(data.count || 0);
            organizerCurrentItems = data.items || [];
            organizerReviewCurrentPage = data.page || requestedPage;
            organizerReviewPages = data.pages || 1;
            organizerReviewFilteredCount = data.filteredCount || 0;
            document.getElementById('organizer-review-result-count').innerText = `${data.filteredCount || 0} matching review items · ${data.count || 0} pending total`;
            document.getElementById('organizer-review-page-info').innerText = `Page ${organizerReviewCurrentPage} of ${organizerReviewPages}`;
            document.getElementById('organizer-review-prev').disabled = organizerReviewCurrentPage <= 1;
            document.getElementById('organizer-review-next').disabled = organizerReviewCurrentPage >= organizerReviewPages;
            document.getElementById('organizer-select-filtered').innerText = organizerSelectAllFiltered
                ? `All ${data.filteredCount || 0} filtered results selected`
                : `Select all ${data.filteredCount || 0} filtered results`;
            const visibleSelect = document.getElementById('organizer-select-visible');
            visibleSelect.checked = !organizerSelectAllFiltered && organizerCurrentItems.length > 0 && organizerCurrentItems.every(item => organizerSelectedIds.has(Number(item.id)));
            visibleSelect.disabled = organizerSelectAllFiltered || organizerCurrentItems.length === 0;
            if (!organizerCurrentItems.length) {
                list.innerHTML = '<div class="bg-[#000000] border border-[#2a2e43] rounded-xl p-6 text-sm text-[#7a7d90] text-center">No organizer items match these filters.</div>';
                updateOrganizerSelectionSummary();
                return;
            }
            list.innerHTML = '';
            organizerCurrentItems.forEach(item => {
                const row = document.createElement('div');
                row.className = 'bg-[#000000] border border-[#2a2e43] rounded-xl p-4 space-y-3';
                const confidence = `${Math.round((Number(item.confidence) || 0) * 100)}%`;
                const tags = item.tags || {};
                const embedded = item.embedded || {};
                const matchedMetadata = item.matched_metadata || {};
                const category = item.kind === 'duplicate' ? 'Exact Duplicate' : item.kind === 'path_conflict' ? 'Naming-Path Conflict' : item.kind === 'quality_upgrade' ? 'Higher-Quality Version Available' : item.kind === 'similar' ? 'Similar Metadata · Different Path' : item.kind === 'low_match' ? 'Possible Match · Incomplete Tags' : item.kind === 'error' ? 'Organizer Error' : 'Metadata Approval Required';
                const matchedBlock = item.matched_path
                    ? (item.match_is_meaningful
                        ? `<div><span class="text-[#00BBFC] font-semibold">Compared with existing pool file:</span><div class="font-mono text-xs text-[#d5d7e0] break-all mt-1">${escapeHtml(normalizeDisplayedPath(item.matched_path))}</div><div class="text-[11px] text-[#7a7d90] mt-1">Metadata match confidence: ${confidence}${item.matched_exists ? '' : ' · recorded match path is missing'}</div></div>`
                        : `<div><span class="text-[#A05AFA] font-semibold">Naming destination is occupied:</span><div class="font-mono text-xs text-[#d5d7e0] break-all mt-1">${escapeHtml(normalizeDisplayedPath(item.matched_path))}</div><div class="text-[11px] text-[#7a7d90] mt-1">The embedded metadata does not support identifying this as the same song. This is a path conflict, not a duplicate match.</div></div>`)
                    : '<div class="text-xs text-[#7a7d90]">No existing pool file has been linked as a metadata match.</div>';
                const metadataBlock = item.matched_path && item.match_is_meaningful
                    ? renderOrganizerMetadataComparison(embedded, matchedMetadata)
                    : renderOrganizerMetadataFallback(embedded, tags);
                let actions = '';
                if (item.candidate_in_trash) {
                    actions += `<button onclick="resolveOrganizerReview(${item.id}, 'delete')" class="px-3 py-2 rounded-lg bg-[#61152b] hover:bg-[#8b1b3d] text-xs font-semibold">Delete Candidate (Trash)</button>`;
                } else {
                    actions += `<button onclick="resolveOrganizerReview(${item.id}, 'stage_trash')" class="px-3 py-2 rounded-lg bg-[#814AC8] hover:bg-[#A05AFA] text-xs font-semibold">Move Candidate to Trash</button>`;
                }
                if (item.matched_path) {
                    if (item.matched_exists && item.is_quality_upgrade) {
                        actions += `<button onclick="resolveOrganizerReview(${item.id}, 'upgrade')" class="px-3 py-2 rounded-lg bg-[#1A76C9] hover:bg-[#0092FC] text-xs font-semibold">Upgrade Pool Version</button>`;
                    } else if (item.matched_exists && item.can_overwrite) {

                        actions += `<button onclick="resolveOrganizerReview(${item.id}, 'overwrite')" class="px-3 py-2 rounded-lg bg-[#713CCC] hover:bg-[#8A48FF] text-xs font-semibold">Overwrite Pool Song</button>`;
                    }
                    if (item.kind !== 'duplicate') {
                        actions += `<button onclick="resolveOrganizerReview(${item.id}, 'keep_both')" class="px-3 py-2 rounded-lg bg-[#2C53CA] hover:bg-[#2B66FD] text-xs font-semibold">Keep Both / Organize Separately</button>`;
                    }
                } else {
                    actions += `<button onclick="resolveOrganizerReview(${item.id}, 'approve')" class="px-3 py-2 rounded-lg bg-[#2C53CA] hover:bg-[#2B66FD] text-xs font-semibold">Approve &amp; Organize</button>`;
                }
                if (!item.candidate_in_trash) {
                    actions += `<button onclick="resolveOrganizerReview(${item.id}, 'keep_dump')" class="px-3 py-2 rounded-lg bg-[#1d202f] hover:bg-[#2a2e43] border border-[#2a2e43] text-xs font-semibold">Keep in Dump</button>`;
                }
                const isSelected = organizerSelectAllFiltered || organizerSelectedIds.has(Number(item.id));
                row.innerHTML = `
                    <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
                        <div class="flex gap-3 min-w-0">
                            <input type="checkbox" class="mt-1 accent-[#2B66FD] shrink-0" aria-label="Select review item ${item.id}" ${isSelected ? 'checked' : ''} ${organizerSelectAllFiltered ? 'disabled' : ''} onchange="toggleOrganizerItemSelection(${item.id}, this.checked)">
                            <div class="min-w-0">
                                <div class="text-sm font-semibold text-[#ffffff]">${escapeHtml(category)}</div>
                                <div class="text-xs text-[#b4b7c5] mt-1">${escapeHtml(item.reason || '')}</div>
                            </div>
                        </div>
                        <div class="flex items-center gap-2 self-start shrink-0">
                            <span class="text-[10px] uppercase tracking-wider text-[#00BBFC] border border-[#216281] rounded-md px-2 py-1">${escapeHtml(item.kind)}</span>
                            <span class="text-[10px] text-[#7a7d90]">#${item.id}</span>
                        </div>
                    </div>
                    <div><div class="text-[10px] uppercase tracking-wider text-[#7a7d90] mb-1">Candidate file</div><div class="font-mono text-xs text-[#ffffff] break-all">${escapeHtml(normalizeDisplayedPath(item.candidate_path || item.source_path || ''))}</div></div>
                    ${matchedBlock}
                    ${metadataBlock}
                    ${item.planned_path ? `<div><div class="text-[10px] uppercase tracking-wider text-[#7a7d90] mb-1">Planned destination</div><div class="font-mono text-xs text-[#b4b7c5] break-all">${escapeHtml(normalizeDisplayedPath(item.planned_path))}</div></div>` : `<div><div class="text-[10px] uppercase tracking-wider text-[#7a7d90] mb-1">Planned destination</div><div class="font-mono text-xs text-[#ff80a8] break-all">Not generated — the naming script needs more usable tag values, or it produced an invalid path.</div></div>`}
                    <div class="text-[11px] text-[#7a7d90]">${item.is_quality_upgrade ? 'The candidate appears to be a better-quality encoding. Upgrade preserves the existing pool version in Trash and updates the catalog to the new path.' : item.matched_path ? (item.can_overwrite ? 'Overwrite is available for this meaningful possible match. MILO preserves the old pool file in Trash first. Keep Both organizes this candidate separately.' : (item.match_is_meaningful ? 'The metadata suggests the same track, but overwrite is not available for this file format or evidence level. Keep Both preserves both files.' : 'This path is occupied by a file whose embedded metadata does not identify it as the same song. Overwrite is disabled; Keep Both preserves both files.')) : 'Approve & Organize explicitly allows this reviewed file into the pool using your naming script. Incomplete embedded metadata is never organized automatically.'}</div>
                    <div class="flex flex-wrap gap-2 pt-1">${actions}</div>
                `;
                list.appendChild(row);
            });
            updateOrganizerSelectionSummary();
        })
        .catch(() => { list.innerHTML = '<div class="text-sm text-[#ff80a8]">Could not contact the organizer review endpoint.</div>'; });
}

function organizerMetadataValue(tags, field) {
    tags = tags || {};
    if (field === 'artist') return tags.artist || '';
    if (field === 'albumartist') return tags.albumartist || '';
    if (field === 'date') return tags.originaldate || tags.date || '';
    if (field === 'track') return tags.tracknumber || '';
    if (field === 'disc') return tags.totaldiscs ? `${tags.discnumber || '?'} / ${tags.totaldiscs}` : (tags.discnumber || '');
    if (field === 'duration') return Number(tags.duration) > 0 ? formatOrganizerDuration(tags.duration) : '';
    if (field === 'format') return tags._codec || String(tags._extension || '').toUpperCase();
    if (field === 'bitrate') return tags._bitrate ? `${tags._bitrate} kbps` : '';
    return tags[field] || '';
}

function formatOrganizerDuration(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return 'Unknown';
    const total = Math.round(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remaining = total % 60;
    return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}` : `${minutes}:${String(remaining).padStart(2, '0')}`;
}

function organizerCompareEqual(field, left, right) {
    if (!left || !right || left === 'Unknown' || right === 'Unknown') return null;
    if (field === 'duration') return Math.abs(Number(left) - Number(right)) <= 1.5;
    const normalize = value => String(value).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();
    return normalize(left) === normalize(right);
}

function renderOrganizerMetadataComparison(candidate, matched) {
    const fields = [['Title', 'title'], ['Artist', 'artist'], ['Album Artist', 'albumartist'], ['Album', 'album'], ['Original Date / Date', 'date'], ['Track', 'track'], ['Disc', 'disc'], ['Duration', 'duration'], ['Format / Codec', 'format'], ['Bitrate', 'bitrate']];
    const rows = fields.map(([label, field]) => {
        const leftRaw = organizerMetadataValue(candidate, field);
        const rightRaw = organizerMetadataValue(matched, field);
        const left = leftRaw || 'Missing';
        const right = rightRaw || 'Missing';
        const equal = field === 'duration'
            ? organizerCompareEqual(field, candidate.duration, matched.duration)
            : organizerCompareEqual(field, leftRaw, rightRaw);
        const status = equal === null ? 'Not enough data' : equal ? 'Match' : 'Different';
        const statusClass = equal === null ? 'text-[#7a7d90]' : equal ? 'text-[#00BBFC]' : 'text-[#ff80a8]';
        return `<tr class="border-t border-[#2a2e43]"><td class="p-2 text-[#7a7d90] whitespace-nowrap">${label}</td><td class="p-2 text-[#ffffff] break-words">${escapeHtml(left)}</td><td class="p-2 text-[#ffffff] break-words">${escapeHtml(right)}</td><td class="p-2 ${statusClass} whitespace-nowrap">${status}</td></tr>`;
    }).join('');
    return `<div class="bg-[#000012] border border-[#216281] rounded-lg overflow-hidden"><div class="p-3 text-[10px] uppercase tracking-wider text-[#00BBFC] font-semibold">Embedded metadata comparison</div><div class="overflow-x-auto"><table class="w-full text-xs text-left"><thead class="bg-[#000000] text-[#b4b7c5]"><tr><th class="p-2 font-semibold">Field</th><th class="p-2 font-semibold">Candidate (embedded)</th><th class="p-2 font-semibold">Existing pool file</th><th class="p-2 font-semibold">Comparison</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

function renderOrganizerMetadataFallback(embedded, suggested) {
    const fields = [['Title', 'title'], ['Artist', 'artist'], ['Album Artist', 'albumartist'], ['Album', 'album'], ['Original Date / Date', 'date'], ['Track', 'track'], ['Disc', 'disc'], ['Duration', 'duration']];
    const embeddedCell = (tags, field) => escapeHtml(organizerMetadataValue(tags, field) || 'Missing');
    const hintFields = [
        ['Title from filename', suggested.source_path_title || (!embedded.title ? suggested.title : '')],
        ['Artist from folders', suggested.source_path_artist || (!embedded.artist && !embedded.albumartist ? suggested.artist : '')],
        ['Album from folders', suggested.source_path_album || (!embedded.album ? suggested.album : '')]
    ];
    const hintCell = value => escapeHtml(value || 'No path clue');
    return `<div class="grid grid-cols-1 lg:grid-cols-2 gap-2 text-xs"><div class="bg-[#000012] border border-[#2a2e43] rounded-lg p-3"><div class="text-[10px] uppercase tracking-wider text-[#00BBFC] mb-2">Candidate embedded metadata</div>${fields.map(([label, field]) => `<div class="grid grid-cols-[8rem_1fr] gap-2 py-1 border-t border-[#2a2e43]/70"><span class="text-[#7a7d90]">${label}</span><span class="text-[#d5d7e0] break-words">${embeddedCell(embedded, field)}</span></div>`).join('')}</div><div class="bg-[#000012] border border-[#2a2e43] rounded-lg p-3"><div class="text-[10px] uppercase tracking-wider text-[#7a7d90] mb-2">Path / filename clues only — not embedded tags</div>${hintFields.map(([label, value]) => `<div class="grid grid-cols-[8rem_1fr] gap-2 py-1 border-t border-[#2a2e43]/70"><span class="text-[#7a7d90]">${label}</span><span class="text-[#d5d7e0] break-words">${hintCell(value)}</span></div>`).join('')}</div></div>`;
}

function updateOrganizerSelectionSummary() {
    const summary = document.getElementById('organizer-selection-summary');
    if (!summary) return;
    summary.innerText = organizerSelectAllFiltered
        ? `${organizerReviewFilteredCount} filtered items selected`
        : `${organizerSelectedIds.size} selected across pages`;
}

function toggleOrganizerItemSelection(id, checked) {
    const key = Number(id);
    if (checked) organizerSelectedIds.add(key);
    else organizerSelectedIds.delete(key);
    const visibleSelect = document.getElementById('organizer-select-visible');
    if (visibleSelect) visibleSelect.checked = !organizerSelectAllFiltered && organizerCurrentItems.length > 0 && organizerCurrentItems.every(item => organizerSelectedIds.has(Number(item.id)));
    updateOrganizerSelectionSummary();
}

function toggleOrganizerVisibleSelection(checked) {
    if (organizerSelectAllFiltered) return;
    organizerCurrentItems.forEach(item => {
        const key = Number(item.id);
        if (checked) organizerSelectedIds.add(key);
        else organizerSelectedIds.delete(key);
    });
    loadOrganizerReview(organizerReviewCurrentPage);
}

function selectAllOrganizerFiltered() {
    if (!organizerReviewFilteredCount) return;
    organizerSelectAllFiltered = true;
    organizerSelectedIds.clear();
    loadOrganizerReview(organizerReviewCurrentPage);
}

function clearOrganizerSelection() {
    organizerSelectAllFiltered = false;
    organizerSelectedIds.clear();
    loadOrganizerReview(organizerReviewCurrentPage);
}

async function runOrganizerBulkAction() {
    const action = document.getElementById('organizer-bulk-action').value;
    if (!organizerSelectAllFiltered && !organizerSelectedIds.size) {
        showAlert('Organizer Review', 'Select one or more review items first.', false);
        return;
    }
    if (action === 'delete' && !(await showConfirm('Delete Candidates', 'Permanently delete selected candidates that are physically inside the configured Trash folder? Items outside Trash will fail safely.', 'Delete'))) return;
    if (action === 'overwrite' && !(await showConfirm('Overwrite Pool Songs', 'Overwrite the matched pool songs? Each existing pool file will first be preserved in Trash. Items without a valid match will fail safely.', 'Overwrite'))) return;
    if (action === 'upgrade' && !(await showConfirm('Upgrade Pool Songs', 'Upgrade selected tracks to a higher-quality version? The existing pool version will be preserved in Trash and the catalog path will be updated.', 'Upgrade'))) return;
    if (action === 'approve' && !(await showConfirm('Approve Unmatched Files', 'Approve and organize selected unmatched files using the saved naming script? Files that have an existing match will not be approved by this action.', 'Approve'))) return;
    const filters = organizerReviewFilters();
    const payload = organizerSelectAllFiltered
        ? { allFiltered: true, filters: { kind: filters.kind, search: filters.search, location: filters.location }, action }
        : { ids: [...organizerSelectedIds], action };
    activeProgressJobType = 'bulk-review';
    closeOrganizerReviewModal();
    showOrganizerProgressPanel({ status: 'running', progress: 0, total: organizerSelectAllFiltered ? organizerReviewFilteredCount : organizerSelectedIds.size, message: 'Starting bulk organizer review...' });
    fetch('/api/admin/organizer/review/bulk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    })
        .then(r => r.json())
        .then(res => {
            if (!res.success) {
                activeProgressJobType = null;
                document.getElementById('job-progress-container').classList.add('hidden');
                document.getElementById('job-action-container').classList.add('hidden');
                openOrganizerReviewModal();
                showAlert('Organizer Review', res.message || 'Bulk action could not be started.', false);
                return;
            }
            organizerSelectedIds.clear();
            organizerSelectAllFiltered = false;
            pollOrganizerStatus();
        })
        .catch(() => {
            activeProgressJobType = null;
            document.getElementById('job-progress-container').classList.add('hidden');
            document.getElementById('job-action-container').classList.add('hidden');
            openOrganizerReviewModal();
            showAlert('Organizer Error', 'Could not contact the bulk review endpoint.', false);
        });
}

async function resolveOrganizerReview(id, action) {
    if (action === 'delete' && !(await showConfirm('Delete Candidate', 'Permanently delete this candidate from the configured Trash folder? This cannot be undone.', 'Delete'))) return;
    if (action === 'overwrite' && !(await showConfirm('Replace Pool Song', 'Replace the matched pool song? The existing pool file will first be preserved in the configured Trash folder.', 'Replace'))) return;
    if (action === 'upgrade' && !(await showConfirm('Upgrade Pool Song', 'Upgrade to this verified higher-quality version? The old pool file will be preserved in Trash and the catalog path updated.', 'Upgrade'))) return;
    fetch(`/api/admin/organizer/review/${id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
    })
    .then(r => r.json())
    .then(res => {
        if (!res.success) {
            showAlert('Organizer Review', res.message || 'The review action could not be completed.', false);
            return;
        }
        loadOrganizerReview(organizerReviewCurrentPage);
        refreshOrganizerReviewCount();
        if (typeof loadCatalog === 'function') loadCatalog();
        if (action !== 'stage_trash') showAlert('Organizer Review', res.message || 'Review action completed.', true);
    })
    .catch(() => showAlert('Organizer Error', 'Could not contact the organizer review endpoint.', false));
}

    Object.assign(window, {
        openOrganizerReviewModal, closeOrganizerReviewModal, organizerReviewFilters,
        organizerReviewFiltersChanged, queueOrganizerReviewSearch, refreshOrganizerReviewCount,
        loadOrganizerReview, organizerMetadataValue, formatOrganizerDuration,
        organizerCompareEqual, renderOrganizerMetadataComparison, renderOrganizerMetadataFallback,
        updateOrganizerSelectionSummary, toggleOrganizerItemSelection, toggleOrganizerVisibleSelection,
        selectAllOrganizerFiltered, clearOrganizerSelection, runOrganizerBulkAction,
        resolveOrganizerReview
    });
})();
