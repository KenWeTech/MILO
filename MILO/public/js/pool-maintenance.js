
(() => {
    if (!document.getElementById('dead-files-modal')) return;

    const ACTIVE_TAB_CLASSES = ['bg-[#2C53CA]', 'border-[#2B66FD]', 'text-[#ffffff]'];
    const INACTIVE_TAB_CLASSES = ['bg-[#000000]', 'border-[#216281]', 'text-[#b4b7c5]'];
    let poolOverviewRefreshTimer = null;
    let poolOverviewInFlight = false;
    let poolOverviewLastPayload = null;
    let poolOverviewRenderedStorageKey = '';

    function normalizePoolPath(value) {
        return String(value == null ? '' : value).replace(/\\/g, '/');
    }

    function poolEscapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    function displayBytes(value) {
        const bytes = Number(value) || 0;
        if (bytes < 1) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
        const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
        const number = bytes / Math.pow(1024, index);
        return `${number.toLocaleString(undefined, { maximumFractionDigits: index >= 3 ? 2 : 1 })} ${units[index]}`;
    }

    function formatDate(value) {
        const time = Number(value);
        return time > 0 ? new Date(time).toLocaleString() : 'Not recorded';
    }

    function formatDuration(value) {
        const milliseconds = Number(value);
        if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—';
        const totalSeconds = Math.floor(milliseconds / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        if (hours) return `${hours}h ${minutes}m ${seconds}s`;
        if (minutes) return `${minutes}m ${seconds}s`;
        return `${seconds}s`;
    }

    function setPoolTabButton(button, active) {
        if (!button) return;
        button.setAttribute('aria-selected', String(active));
        ACTIVE_TAB_CLASSES.forEach(name => button.classList.toggle(name, active));
        INACTIVE_TAB_CLASSES.forEach(name => button.classList.toggle(name, !active));
    }

    function setPoolPanel(panel, active) {
        if (!panel) return;
        panel.classList.toggle('hidden', !active);
        panel.classList.toggle('flex', active);
    }

    function switchPoolMaintenanceTab(tab, reloadContent = true) {
        const selected = ['overview', 'dead-files', 'wanted-tracks'].includes(tab) ? tab : 'overview';
        const allowed = selected === 'wanted-tracks' ? !!document.getElementById('wanted-tracks-tab-panel')
            : selected === 'overview' ? !!document.getElementById('pool-overview-tab-panel') : true;
        const active = allowed ? selected : 'dead-files';
        setPoolTabButton(document.getElementById('pool-tab-overview'), active === 'overview');
        setPoolTabButton(document.getElementById('pool-tab-dead-files'), active === 'dead-files');
        setPoolTabButton(document.getElementById('pool-tab-wanted-tracks'), active === 'wanted-tracks');
        setPoolPanel(document.getElementById('pool-overview-tab-panel'), active === 'overview');
        setPoolPanel(document.getElementById('dead-files-tab-panel'), active === 'dead-files');
        setPoolPanel(document.getElementById('wanted-tracks-tab-panel'), active === 'wanted-tracks');

        if (active !== 'wanted-tracks' && typeof wantedTracksLoadPollTimeout !== 'undefined' && wantedTracksLoadPollTimeout) {
            clearTimeout(wantedTracksLoadPollTimeout);
            wantedTracksLoadPollTimeout = null;
        }
        if (active !== 'overview' && poolOverviewRefreshTimer) {
            clearTimeout(poolOverviewRefreshTimer);
            poolOverviewRefreshTimer = null;
        }
        if (!reloadContent || activeManagedModalId !== 'dead-files-modal') return;
        const modalToken = modalRequestGeneration;
        if (active === 'overview') {
            refreshPoolMaintenanceOverview(false);
        } else if (active === 'wanted-tracks') {
            document.getElementById('wanted-tracks-preview').innerText = 'Loading wanted tracks…';
            document.getElementById('wanted-tracks-count').innerText = 'Loading list…';
            loadWantedTracksData(modalToken);
        } else {
            loadDeadFilesData(modalToken);
        }
    }

    function openPoolMaintenanceModal(tab = 'overview') {
        const selectedTab = tab || 'overview';
        const modalToken = showManagedModal('dead-files-modal', selectedTab === 'dead-files' ? 'dead-files-container' : null, 'Loading Pool Maintenance…');
        switchPoolMaintenanceTab(selectedTab, false);
        if (selectedTab === 'overview') refreshPoolMaintenanceOverview(false);
        else if (selectedTab === 'wanted-tracks') {
            document.getElementById('wanted-tracks-preview').innerText = 'Loading wanted tracks…';
            document.getElementById('wanted-tracks-count').innerText = 'Loading list…';
            loadWantedTracksData(modalToken);
        } else loadDeadFilesData(modalToken);
    }

    function openDeadFilesModal() {
        openPoolMaintenanceModal(document.getElementById('pool-tab-overview') ? 'overview' : 'dead-files');
    }
    function openDeadFilesTab() { openPoolMaintenanceModal('dead-files'); }
    function openWantedTracksModal() { openPoolMaintenanceModal('wanted-tracks'); }
    function closeDeadFilesModal() {
        if (poolOverviewRefreshTimer) clearTimeout(poolOverviewRefreshTimer);
        poolOverviewRefreshTimer = null;
        closeManagedModal('dead-files-modal');
    }
    function closeWantedTracksModal() { closeDeadFilesModal(); }

    function updateWantedTracksModeUI() {
        const mode = document.getElementById('wanted-tracks-mode');
        const url = document.getElementById('wanted-tracks-post-url');
        if (!mode || !url) return;
        const selectedMode = mode.value;
        const needsPost = selectedMode === 'post' || selectedMode === 'both';
        url.disabled = !needsPost;
        url.required = needsPost;
        url.classList.toggle('opacity-50', !needsPost);
        const generateButton = document.getElementById('btn-generate-wanted-tracks');
        if (generateButton) generateButton.innerText = selectedMode === 'file' ? 'Generate Text Now' : 'Generate & Send Now';
    }

    function renderWantedTracksData(data) {
        document.getElementById('wanted-tracks-mode').value = data.mode || 'file';
        document.getElementById('wanted-tracks-post-url').value = data.post_url || '';
        document.getElementById('wanted-tracks-file-path').innerText = normalizePoolPath(data.file_path || 'Path unavailable');
        const count = document.getElementById('wanted-tracks-count');
        const preview = document.getElementById('wanted-tracks-preview');
        const status = document.getElementById('wanted-tracks-status');
        if (data.list_pending) {
            count.innerText = 'Building current wanted list…';
            preview.innerText = 'Preparing the current wanted list for the first time…';
            status.innerText = 'The file location is ready. MILO is building a cached list so future opens do not repeat the full catalog comparison.';
            updateWantedTracksModeUI();
            return;
        }
        if (data.list_error) {
            count.innerText = 'Unable to build list';
            preview.innerText = 'Unable to load the current wanted list.';
            status.innerText = data.list_error;
            updateWantedTracksModeUI();
            return;
        }
        count.innerText = `${Number(data.track_count) || 0} unique wanted track(s). Preview shows up to 30 lines.`;
        preview.innerText = (data.preview || []).join('\n') || '(No currently wanted tracks.)';
        if (data.last_generated_at) {
            let resultText = `Last generated: ${new Date(data.last_generated_at).toLocaleString()} · ${Number(data.last_count) || 0} track(s).`;
            if (data.last_result && data.last_result.message) resultText += `\n${data.last_result.message}`;
            status.innerText = resultText;
        } else status.innerText = 'No output has been generated yet. Automatic updates run after successful scans and playlist syncs.';
        const skippedUnformatted = Number(data.skipped_unformatted_count) || 0;
        if (skippedUnformatted > 0) status.innerText += `\n${skippedUnformatted} legacy unmatched entr${skippedUnformatted === 1 ? 'y was' : 'ies were'} omitted because MILO could not identify both artist and song title. Re-sync the source playlists to refresh those entries.`;
        updateWantedTracksModeUI();
    }

    async function loadWantedTracksData(modalToken = null, retryingPendingList = false) {
        const status = document.getElementById('wanted-tracks-status');
        if (!status) return;
        if (!retryingPendingList) {
            if (wantedTracksLoadPollTimeout) clearTimeout(wantedTracksLoadPollTimeout);
            wantedTracksLoadPollTimeout = null;
            status.innerText = 'Loading wanted-track settings and the current list…';
        }
        try {
            const response = await fetch('/api/admin/wanted-tracks', { cache: 'no-store' });
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.message || 'Could not load Wanted Tracks.');
            if (modalToken != null && !isManagedModalCurrent('dead-files-modal', modalToken)) return;
            renderWantedTracksData(data);
            if (data.list_pending && modalToken != null && isManagedModalCurrent('dead-files-modal', modalToken)) {
                wantedTracksLoadPollTimeout = setTimeout(() => {
                    wantedTracksLoadPollTimeout = null;
                    if (isManagedModalCurrent('dead-files-modal', modalToken)) loadWantedTracksData(modalToken, true);
                }, 1200);
            }
        } catch (error) {
            if (modalToken != null && !isManagedModalCurrent('dead-files-modal', modalToken)) return;
            status.innerText = error.message || 'Could not load Wanted Tracks settings.';
            document.getElementById('wanted-tracks-preview').innerText = 'Unable to load the current wanted list.';
            document.getElementById('wanted-tracks-count').innerText = 'Unable to load list';
            document.getElementById('wanted-tracks-file-path').innerText = 'Unable to load file path';
        }
    }

    async function postWantedTracksSettings() {
        const mode = document.getElementById('wanted-tracks-mode').value;
        const post_url = document.getElementById('wanted-tracks-post-url').value.trim();
        const response = await fetch('/api/admin/wanted-tracks/settings', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, post_url })
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || 'Could not save Wanted Tracks settings.');
        return data;
    }

    async function saveWantedTracksSettings() {
        const button = document.getElementById('btn-save-wanted-tracks');
        const status = document.getElementById('wanted-tracks-status');
        button.disabled = true;
        status.innerText = 'Saving Wanted Tracks settings…';
        try {
            await postWantedTracksSettings();
            const modalToken = activeManagedModalId === 'dead-files-modal' ? modalRequestGeneration : null;
            await loadWantedTracksData(modalToken);
            status.innerText = 'Wanted Tracks settings saved. Automatic updates will use these settings after scans and playlist syncs.';
            status.classList.remove('text-[#ff80a8]');
        } catch (error) { status.innerText = error.message || 'Could not save Wanted Tracks settings.'; }
        finally { button.disabled = false; }
    }

    async function generateWantedTracksNow() {
        const button = document.getElementById('btn-generate-wanted-tracks');
        const saveButton = document.getElementById('btn-save-wanted-tracks');
        const status = document.getElementById('wanted-tracks-status');
        button.disabled = true;
        saveButton.disabled = true;
        status.innerText = 'Saving settings, rebuilding the deduplicated list, and delivering the configured output…';
        try {
            await postWantedTracksSettings();
            const response = await fetch('/api/admin/wanted-tracks/generate', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
            });
            const result = await response.json();
            if (result.preview) {
                document.getElementById('wanted-tracks-count').innerText = `${Number(result.count) || 0} unique wanted track(s). Preview shows up to 30 lines.`;
                document.getElementById('wanted-tracks-preview').innerText = result.preview.join('\n') || '(No currently wanted tracks.)';
            }
            status.innerText = result.message || (result.success ? 'Wanted Tracks generated.' : 'Wanted Tracks generation had a problem.');
            if (!response.ok || !result.success) status.classList.add('text-[#ff80a8]');
            else status.classList.remove('text-[#ff80a8]');
            if (result.generatedAt) status.innerText += `\nGenerated: ${new Date(result.generatedAt).toLocaleString()}`;
        } catch (error) {
            status.innerText = error.message || 'Could not generate or send Wanted Tracks.';
            status.classList.add('text-[#ff80a8]');
        } finally { button.disabled = false; saveButton.disabled = false; }
    }

    function loadDeadFilesData(modalToken) {
        const countElement = document.getElementById('dead-files-count');
        if (!countElement) return;
        countElement.innerText = 'Checking catalog folders…';
        fetch('/api/admin/dead-files', { cache: 'no-store' })
            .then(async response => {
                const data = await response.json();
                if (!response.ok) throw new Error(data.message || 'Could not load missing catalog entries.');
                return data;
            })
            .then(files => {
                if (!isManagedModalCurrent('dead-files-modal', modalToken)) return;
                const container = document.getElementById('dead-files-container');
                container.innerHTML = '';
                deadFileRepairChoices = new Map();
                if (!Array.isArray(files)) {
                    container.innerHTML = `<div class="text-xs text-[#ff80a8] text-center p-4">${poolEscapeHtml(files.message || 'Could not load missing catalog entries.')}</div>`;
                    countElement.innerText = 'Unable to load missing files';
                    updateDeadFileSelectionUI();
                    return;
                }
                countElement.innerText = `${files.length} dead catalog entries detected`;
                if (!files.length) {
                    deadFileSelectedIds.clear();
                    container.innerHTML = '<div class="text-xs text-[#7a7d90] text-center p-4">No missing catalog files detected.</div>';
                } else {
                    files.forEach(file => {
                        const row = document.createElement('div');
                        row.className = 'bg-[#000012] border border-[#2a2e43] rounded-lg p-3 space-y-2';
                        const replacement = file.replacement;
                        const deadId = Number(file.id);
                        if (replacement && replacement.path) deadFileRepairChoices.set(deadId, replacement.path);
                        const selectable = !!(replacement && replacement.path);
                        const selected = deadFileSelectedIds.has(deadId) && selectable;
                        row.innerHTML = `
                            <div class="flex items-start gap-2">
                                <input type="checkbox" ${selectable ? '' : 'disabled'} ${selected ? 'checked' : ''} onchange="toggleDeadFileSelection(${deadId}, this.checked)" class="mt-1 accent-[#2B66FD] disabled:opacity-30" aria-label="Select ${poolEscapeHtml(file.title || 'catalog entry')} for repair">
                                <div class="text-sm font-semibold text-[#ffffff] min-w-0">${poolEscapeHtml(file.artist || 'Unknown artist')} — ${poolEscapeHtml(file.title || 'Unknown title')}</div>
                            </div>
                            <div><div class="text-[10px] uppercase text-[#7a7d90] mb-1">Missing catalog path</div><div class="font-mono text-xs text-[#ff80a8] break-all">${poolEscapeHtml(normalizePoolPath(file.path || ''))}</div></div>
                            ${file.album ? `<div class="text-[11px] text-[#7a7d90]">Album: ${poolEscapeHtml(file.album)}</div>` : ''}
                            ${replacement ? `<div class="border-t border-[#2a2e43] pt-2 space-y-1"><div class="text-[10px] uppercase text-[#00BBFC]">Possible replacement · ${poolEscapeHtml(replacement.format || 'Audio')}${replacement.is_higher_quality ? ' · Higher quality' : ''}</div><div class="font-mono text-xs text-[#d5d7e0] break-all">${poolEscapeHtml(normalizePoolPath(replacement.path))}</div><div class="text-[11px] text-[#b4b7c5]">${poolEscapeHtml(replacement.artist || 'Unknown artist')} — ${poolEscapeHtml(replacement.title || 'Unknown title')}${replacement.album ? ` · ${poolEscapeHtml(replacement.album)}` : ''}</div><div class="text-[11px] text-[#7a7d90]">${replacement.duration ? `Duration: ${poolEscapeHtml(formatOrganizerDuration(replacement.duration))}` : 'Duration: Unknown'}${replacement.bitrate ? ` · ${poolEscapeHtml(String(replacement.bitrate))} kbps` : ''}${replacement.bit_depth ? ` · ${poolEscapeHtml(String(replacement.bit_depth))}-bit` : ''} · Missing entry format: ${poolEscapeHtml(file.missing_format || 'Unknown')}</div><div class="text-[11px] ${replacement.album_match ? 'text-[#00BBFC]' : 'text-[#A05AFA]'}">${poolEscapeHtml(replacement.message || '')}</div><button data-dead-id="${deadId}" data-replacement="${poolEscapeHtml(normalizePoolPath(replacement.path))}" onclick="repairDeadFileFromButton(this)" class="mt-1 px-3 py-2 rounded-lg bg-[#1A76C9] hover:bg-[#0092FC] text-xs font-semibold">Repair Catalog Path</button></div>` : (file.ambiguous_matches ? '<div class="text-[11px] text-[#A05AFA]">Several files have matching title and artist metadata, and there is no unique replacement. Run a rescan or verify the files manually.</div>' : '<div class="text-[11px] text-[#7a7d90]">No replacement with matching embedded title and artist was found.</div>')}
                            <div class="flex justify-end border-t border-[#2a2e43] pt-2"><button onclick="clearDeadFile(${deadId})" class="px-3 py-2 rounded-lg bg-[#330816] hover:bg-[#66112c] text-xs font-semibold text-[#ff80a8]">Clear Stale Catalog Entry</button></div>`;
                        container.appendChild(row);
                    });
                }
                for (const id of [...deadFileSelectedIds]) if (!deadFileRepairChoices.has(id)) deadFileSelectedIds.delete(id);
                updateDeadFileSelectionUI();
            })
            .catch(error => {
                if (!isManagedModalCurrent('dead-files-modal', modalToken)) return;
                document.getElementById('dead-files-container').innerHTML = `<div class="text-xs text-[#ff80a8] text-center p-4">${poolEscapeHtml(error.message || 'Could not contact the Dead Files endpoint.')}</div>`;
                countElement.innerText = 'Unable to load missing files';
                updateDeadFileSelectionUI();
            });
    }

    function updateDeadFileSelectionUI() {
        const selectedCount = [...deadFileSelectedIds].filter(id => deadFileRepairChoices.has(id)).length;
        const repairableCount = deadFileRepairChoices.size;
        const count = document.getElementById('dead-files-selection-count');
        const master = document.getElementById('dead-files-select-repairable');
        const button = document.getElementById('btn-repair-dead-selected');
        if (count) count.innerText = `${selectedCount} selected · ${repairableCount} repairable`;
        if (button) button.disabled = selectedCount === 0;
        if (master) {
            master.checked = repairableCount > 0 && selectedCount === repairableCount;
            master.indeterminate = selectedCount > 0 && selectedCount < repairableCount;
            master.disabled = repairableCount === 0;
        }
    }

    function toggleDeadFileSelection(id, checked) {
        const deadId = Number(id);
        if (!deadFileRepairChoices.has(deadId)) return;
        if (checked) deadFileSelectedIds.add(deadId); else deadFileSelectedIds.delete(deadId);
        updateDeadFileSelectionUI();
    }

    function toggleDeadFileAllSelection(checked) {
        if (checked) for (const id of deadFileRepairChoices.keys()) deadFileSelectedIds.add(Number(id));
        else deadFileSelectedIds.clear();
        document.querySelectorAll('#dead-files-container input[type="checkbox"]').forEach(input => {
            if (!input.disabled) input.checked = !!checked;
        });
        updateDeadFileSelectionUI();
    }

    async function startDeadFileTask(endpoint, payload, initialMessage) {
        closeDeadFilesModal();
        showSecondaryProgressPanel({ status: 'running', progress: 0, total: payload && payload.items ? payload.items.length : 0, message: initialMessage }, 'dead-files-bulk', 'Open Dead Files', openDeadFilesTab);
        try {
            const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) });
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.message || 'Could not start the Dead Files task.');
            deadFileSelectedIds.clear();
            pollDeadFileJobStatus();
        } catch (error) {
            activeProgressJobType = null;
            document.getElementById('job-progress-container').classList.add('hidden');
            document.getElementById('job-action-container').classList.add('hidden');
            openDeadFilesTab();
            showAlert('Dead Files', error.message || 'Could not start the Dead Files task.', false);
        }
    }

    async function pollDeadFileJobStatus(suppressCompletionAlert = false) {
        if (deadFileStatusPollInterval) clearInterval(deadFileStatusPollInterval);
        let inFlight = false;
        const poll = async () => {
            if (inFlight) return;
            inFlight = true;
            try {
                const response = await fetch('/api/admin/dead-files/job-status', { cache: 'no-store' });
                const job = await response.json();
                if (!response.ok) throw new Error(job.message || 'Could not read Dead Files progress.');
                showSecondaryProgressPanel(job, 'dead-files-bulk', 'Open Dead Files', openDeadFilesTab);
                if (job.status === 'completed' || job.status === 'error') {
                    clearInterval(deadFileStatusPollInterval);
                    deadFileStatusPollInterval = null;
                    loadCatalog();
                    const result = job.result || {};
                    const summary = job.task === 'dead-files-purge'
                        ? `${job.message}${job.status === 'completed' ? ` Cleared ${Number(result.purged) || 0} catalog entr${Number(result.purged) === 1 ? 'y' : 'ies'}.` : ''}`
                        : `${job.message}${Array.isArray(result.items) ? '\n' + result.items.filter(item => !item.success).slice(0, 5).map(item => `#${item.id}: ${item.message}`).join('\n') : ''}`;
                    if (!suppressCompletionAlert) showAlert('Dead Files', summary, job.status === 'completed' && !(Number(result.failed) > 0));
                    if (activeManagedModalId === 'dead-files-modal') refreshPoolMaintenanceOverview(false);
                }
            } catch (error) {
                const text = document.getElementById('job-status-text');
                if (text) text.innerText = `${error.message || 'Connection interrupted while checking progress.'} Retrying…`;
            } finally { inFlight = false; }
        };
        deadFileStatusPollInterval = setInterval(poll, 800);
        poll();
    }

    async function repairSelectedDeadFiles() {
        const items = [...deadFileSelectedIds].filter(id => deadFileRepairChoices.has(id))
            .map(id => ({ id: Number(id), replacement_path: deadFileRepairChoices.get(id) }));
        if (!items.length) return showAlert('Dead Files', 'Select one or more entries with a verified replacement first.', false);
        if (!(await showConfirm('Repair Selected Catalog Paths', `Repair ${items.length} selected catalog entr${items.length === 1 ? 'y' : 'ies'} to their verified replacement files? Existing library assignments will be preserved.`, 'Repair Selected'))) return;
        return startDeadFileTask('/api/admin/dead-files/repair/bulk', { items }, `Starting catalog repair for ${items.length} selected entr${items.length === 1 ? 'y' : 'ies'}…`);
    }

    async function repairDeadFileFromButton(button) {
        const deadId = Number(button.dataset.deadId);
        const replacementPath = button.dataset.replacement;
        if (!(await showConfirm('Repair Catalog Path', `Repair catalog entry #${deadId} to this file?\n\n${replacementPath}\n\nExisting library assignments will be preserved.`, 'Repair Path'))) return;
        return startDeadFileTask('/api/admin/dead-files/repair/bulk', { items: [{ id: deadId, replacement_path: replacementPath }] }, `Starting repair for catalog entry #${deadId}…`);
    }

    async function clearDeadFile(id) {
        if (!(await showConfirm('Clear Dead Catalog Entry', `Clear stale catalog entry #${id}? This removes only the catalog record and associated library links; it does not delete audio files.`, 'Clear Entry'))) return;
        try {
            const response = await fetch(`/api/admin/dead-files/${id}`, { method: 'DELETE' });
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.message || 'Could not clear this catalog entry.');
            deadFileSelectedIds.delete(Number(id));
            showAlert('Dead Files', 'Stale catalog entry cleared.', true);
            loadCatalog();
            openDeadFilesTab();
        } catch (error) { showAlert('Dead Files', error.message || 'Could not contact the catalog repair endpoint.', false); }
    }

    async function purgeDeadFiles() {
        if (!(await showConfirm('Clear Dead Catalog Entries', 'Check the catalog for stale entries pointing to missing files, then remove those catalog records? This does not delete audio files.', 'Purge Dead Entries'))) return;
        return startDeadFileTask('/api/admin/dead-files/purge', {}, 'Starting Dead Files catalog check…');
    }

    function setOverviewStatus(message, error = false) {
        const status = document.getElementById('pool-overview-status');
        if (!status) return;
        status.innerText = message || '';
        status.classList.toggle('text-[#ff80a8]', !!error);
        status.classList.toggle('text-[#7a7d90]', !error);
    }

    function summaryTile(label, value, note = '') {
        return `<div class="bg-[#000012] border border-[#216281] rounded-lg p-3 min-w-0"><div class="text-[10px] uppercase tracking-wider text-[#7a7d90]">${poolEscapeHtml(label)}</div><div class="text-lg font-bold text-[#f1f2f6] mt-1 break-words">${poolEscapeHtml(value)}</div>${note ? `<div class="text-[10px] text-[#7a7d90] mt-1">${poolEscapeHtml(note)}</div>` : ''}</div>`;
    }

    function renderPoolOverview(data) {
        poolOverviewLastPayload = data;
        document.getElementById('pool-overview-path').innerText = `Master Pool: ${normalizePoolPath(data.masterPoolPath || '')}`;
        const storage = data.storage || {};
        const history = Array.isArray(data.history) ? data.history : [];
        const failures = history.filter(item => item.status === 'error').length;
        document.getElementById('pool-overview-summary').innerHTML = [
            summaryTile('Master Pool Storage', displayBytes(storage.totalBytes), `${Number(storage.totalTracks || 0).toLocaleString()} live tracks`),
            summaryTile('Assigned Library Links', Number(storage.totalAssignedLinks || 0).toLocaleString(), `${Number(storage.validLinks || 0).toLocaleString()} verified on disk`),
            summaryTile('Broken / Missing Links', Number(storage.brokenLinks || 0).toLocaleString(), 'Compared with the current catalog'),
            summaryTile('Recent Failed Tasks', failures.toLocaleString(), 'Within the latest 100 recorded tasks')
        ].join('');
        renderUpcoming(data.upcoming || []);
        renderActiveWork(data.activeTasks || []);
        renderStorage(storage);
        renderTaskHistory(history);
        const status = storage.status === 'building'
            ? (storage.phase === 'enumerate'
                ? (storage.message || 'Enumerating Master Pool audio files…')
                : `${storage.message || 'Storage analysis running…'} ${Number(storage.progress || 0).toLocaleString()} / ${Number(storage.total || 0).toLocaleString()} (${storage.phase || 'starting'}).`)
            : storage.status === 'error'
                ? `Storage analysis failed: ${storage.message || 'Unknown error.'}`
                : storage.status === 'ready'
                    ? `Last refreshed ${formatDate(storage.calculatedAt)}. ${Number(storage.errors || 0).toLocaleString()} file access error(s); ${Number(storage.missingMetadata || 0).toLocaleString()} file(s) had no useful cached metadata.`
                    : 'Storage analysis is waiting to start.';
        setOverviewStatus(status, storage.status === 'error');
        document.getElementById('pool-storage-calculated-at').innerText = storage.calculatedAt ? `Updated ${formatDate(storage.calculatedAt)}` : '';
        const refreshButton = document.getElementById('btn-pool-overview-refresh');
        if (refreshButton) refreshButton.disabled = poolOverviewInFlight || storage.status === 'building';
    }

    function renderUpcoming(items) {
        const container = document.getElementById('pool-upcoming-work');
        if (!items.length) {
            container.innerHTML = '<p class="text-xs text-[#7a7d90]">No scheduled scans or syncs are currently enabled.</p>';
            return;
        }
        container.innerHTML = items.slice(0, 16).map(item => `
            <div class="bg-[#000012] border border-[#2a2e43] rounded-lg p-3 min-w-0">
                <div class="flex justify-between gap-2"><span class="text-xs font-semibold text-[#f1f2f6]">${poolEscapeHtml(item.label)}</span><span class="text-[10px] text-[#00BBFC] whitespace-nowrap">${poolEscapeHtml(item.triggerSource || 'scheduled cron')}</span></div>
                <div class="text-[11px] text-[#b4b7c5] mt-2">Next run: ${poolEscapeHtml(formatDate(item.nextRunAt))}</div>
                <div class="text-[10px] text-[#7a7d90] mt-1">Every ${poolEscapeHtml(item.intervalMinutes)} minute(s)${item.lastRunAt ? ` · Last run: ${poolEscapeHtml(formatDate(item.lastRunAt))}` : ' · No completed run recorded'}</div>
            </div>`).join('');
    }

    function renderActiveWork(tasks) {
        const container = document.getElementById('pool-active-work');
        if (!tasks.length) {
            container.innerHTML = '<p class="text-xs text-[#7a7d90]">No scans, syncs, or other background work are currently running or queued.</p>';
            return;
        }
        container.innerHTML = tasks.map(task => `
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-[#000012] border border-[#2a2e43] rounded-lg p-3">
                <div class="min-w-0"><div class="text-xs font-semibold text-[#f1f2f6]">${poolEscapeHtml(task.label || task.type || task.kind)}</div><div class="text-[10px] text-[#7a7d90] mt-1">${poolEscapeHtml(task.message || '')}</div></div>
                <div class="text-[10px] whitespace-nowrap ${task.status === 'running' ? 'text-[#00BBFC]' : 'text-[#A05AFA]'}">${poolEscapeHtml(task.status)}${task.position > 0 ? ` · Queue #${poolEscapeHtml(task.position)}` : ''}${Number(task.total) > 0 ? ` · ${Number(task.progress || 0).toLocaleString()}/${Number(task.total).toLocaleString()}` : ''}</div>
            </div>`).join('');
    }

    function renderStorage(storage) {
        const snapshotKey = `${Number(storage.calculatedAt) || 0}:${storage.status || 'idle'}:${storage.status === 'error' ? Number(storage.failedAt) || 0 : ''}`;

        if (snapshotKey === poolOverviewRenderedStorageKey) return;
        poolOverviewRenderedStorageKey = snapshotKey;
        const summary = document.getElementById('pool-storage-summary');
        const formats = document.getElementById('pool-storage-formats');
        const topArtists = document.getElementById('pool-top-artists');
        const linkSummary = document.getElementById('pool-user-link-summary');
        const userLinks = document.getElementById('pool-user-link-stats');
        const hasCachedResults = Number(storage.calculatedAt) > 0
            && Array.isArray(storage.formats) && Array.isArray(storage.topArtists) && Array.isArray(storage.userLinks);
        if (storage.status !== 'ready' && !hasCachedResults) {
            summary.innerHTML = `<p class="text-xs ${storage.status === 'error' ? 'text-[#ff80a8]' : 'text-[#7a7d90]'}">${poolEscapeHtml(storage.message || 'Storage analysis is pending…')}</p>`;
            formats.innerHTML = storage.status === 'error' && storage.errorTrace ? `<details class="text-xs text-[#ff80a8]"><summary>Storage analysis error trace</summary><pre class="whitespace-pre-wrap break-words mt-2">${poolEscapeHtml(storage.errorTrace)}</pre></details>` : '<p class="text-xs text-[#7a7d90]">Format totals appear when the analysis completes.</p>';
            topArtists.innerHTML = '<p class="text-xs text-[#7a7d90]">Artist totals appear when the analysis completes.</p>';
            linkSummary.innerHTML = '';
            userLinks.innerHTML = '<p class="text-xs text-[#7a7d90]">Link totals appear when the analysis completes.</p>';
            return;
        }
        summary.innerHTML = [
            summaryTile('Used by Master Pool', displayBytes(storage.totalBytes), 'Sum of live audio file sizes; not allocated disk blocks'),
            summaryTile('Live Tracks', Number(storage.totalTracks || 0).toLocaleString()),
            summaryTile('Formats / Codecs', Number((storage.formats || []).length).toLocaleString()),
            summaryTile('Metadata Gaps', Number(storage.missingMetadata || 0).toLocaleString(), 'Files without useful cached metadata')
        ].join('');
        const formatRows = storage.formats || [];
        formats.innerHTML = formatRows.length ? `<table class="w-full text-left text-xs"><thead><tr class="border-b border-[#216281] text-[#7a7d90]"><th class="py-2 pr-3">Format / Codec</th><th class="py-2 pr-3 text-right">Tracks</th><th class="py-2 pr-3 text-right">Storage</th><th class="py-2 text-right">Avg. Bitrate</th></tr></thead><tbody>${formatRows.map(item => `<tr class="border-b border-[#2a2e43]"><td class="py-2 pr-3 text-[#f1f2f6]">${poolEscapeHtml(item.name)}</td><td class="py-2 pr-3 text-right tabular-nums">${Number(item.trackCount || 0).toLocaleString()}</td><td class="py-2 pr-3 text-right tabular-nums">${poolEscapeHtml(displayBytes(item.bytes))}</td><td class="py-2 text-right tabular-nums">${item.averageBitrateKbps ? `${Number(item.averageBitrateKbps).toLocaleString()} kbps` : 'Unknown'}</td></tr>`).join('')}</tbody></table>` : '<p class="text-xs text-[#7a7d90]">No valid audio files were measured.</p>';
        const artists = storage.topArtists || [];
        const maxArtistBytes = Math.max(1, ...artists.map(item => Number(item.bytes) || 0));
        topArtists.innerHTML = artists.length ? artists.map((item, index) => `<div><div class="flex justify-between gap-2 text-xs"><span class="text-[#d5d7e0] truncate">${index + 1}. ${poolEscapeHtml(item.artist)}</span><span class="text-[#7a7d90] whitespace-nowrap">${poolEscapeHtml(displayBytes(item.bytes))}</span></div><div class="h-1.5 rounded bg-[#1d202f] mt-1 overflow-hidden"><div class="h-full bg-[#2B66FD]" style="width:${Math.max(1, Math.min(100, (Number(item.bytes || 0) / maxArtistBytes) * 100))}%"></div></div><div class="text-[10px] text-[#7a7d90] mt-1">${Number(item.trackCount || 0).toLocaleString()} tracks</div></div>`).join('') : '<p class="text-xs text-[#7a7d90]">No artist metadata was found.</p>';
        linkSummary.innerHTML = [
            summaryTile('Assigned', Number(storage.totalAssignedLinks || 0).toLocaleString()),
            summaryTile('Verified', Number(storage.validLinks || 0).toLocaleString()),
            summaryTile('Missing / Mismatched', Number(storage.brokenLinks || 0).toLocaleString())
        ].join('');
        const users = storage.userLinks || [];
        userLinks.innerHTML = users.length ? `<table class="w-full text-left text-xs"><thead><tr class="border-b border-[#216281] text-[#7a7d90]"><th class="py-2 pr-2">User</th><th class="py-2 pr-2 text-right">Assigned</th><th class="py-2 pr-2 text-right">Verified</th><th class="py-2 text-right">Missing</th></tr></thead><tbody>${users.map(item => `<tr class="border-b border-[#2a2e43]"><td class="py-2 pr-2"><div class="text-[#f1f2f6]">${poolEscapeHtml(item.username)}</div><div class="text-[10px] text-[#7a7d90]">${poolEscapeHtml(item.role)} · ${poolEscapeHtml(item.indexMode)}</div></td><td class="py-2 pr-2 text-right tabular-nums">${Number(item.totalLinks || 0).toLocaleString()}</td><td class="py-2 pr-2 text-right tabular-nums text-[#00BBFC]">${Number(item.validLinks || 0).toLocaleString()}</td><td class="py-2 text-right tabular-nums ${Number(item.brokenLinks || 0) ? 'text-[#ff80a8]' : 'text-[#7a7d90]'}">${Number(item.brokenLinks || 0).toLocaleString()}</td></tr>`).join('')}</tbody></table>` : '<p class="text-xs text-[#7a7d90]">No user library assignments found.</p>';
        if (storage.status === 'error' && storage.errorTrace) {
            formats.insertAdjacentHTML('beforeend', `<details class="text-xs text-[#ff80a8] mt-3"><summary>Latest refresh error trace</summary><pre class="whitespace-pre-wrap break-words mt-2">${poolEscapeHtml(storage.errorTrace)}</pre></details>`);
        }
    }

    function renderTaskHistory(items) {
        const container = document.getElementById('pool-task-history');
        if (!items.length) {
            container.innerHTML = '<p class="text-xs text-[#7a7d90]">No completed or failed background tasks have been recorded yet. New jobs will appear here after they finish.</p>';
            return;
        }
        container.innerHTML = items.map(item => {
            const failed = item.status === 'error';
            const statusColor = failed ? 'text-[#ff80a8]' : (item.status === 'completed' || item.status === 'auto_completed' ? 'text-[#00BBFC]' : 'text-[#A05AFA]');
            const trace = item.errorTrace || '';
            return `<article class="bg-[#000012] border border-[#2a2e43] rounded-lg p-3 space-y-2"><div class="flex flex-col lg:flex-row lg:items-start justify-between gap-2"><div class="min-w-0"><div class="text-xs font-semibold text-[#f1f2f6] break-words">${poolEscapeHtml(item.label || item.type || item.kind)}</div><div class="text-[10px] text-[#7a7d90] mt-1">${poolEscapeHtml(formatDate(item.createdAt))} · ${poolEscapeHtml(item.username || item.requestedBy || 'System')} · ${poolEscapeHtml(item.triggerSource || 'manual')}${item.triggerDetail ? ` · ${poolEscapeHtml(item.triggerDetail)}` : ''}</div></div><div class="flex gap-3 text-[10px] whitespace-nowrap"><span class="${statusColor}">${poolEscapeHtml(item.status)}</span><span class="text-[#b4b7c5]">${poolEscapeHtml(formatDuration(item.durationMs))}</span></div></div>${item.message ? `<p class="text-[11px] text-[#b4b7c5] whitespace-pre-line break-words">${poolEscapeHtml(item.message)}</p>` : ''}${trace ? `<details class="text-[11px] text-[#ff80a8]"><summary class="cursor-pointer select-none">View error trace</summary><pre class="mt-2 whitespace-pre-wrap break-words font-mono text-[10px]">${poolEscapeHtml(trace)}</pre></details>` : ''}${item.resultSummary ? `<details class="text-[11px] text-[#7a7d90]"><summary class="cursor-pointer select-none">Result details</summary><pre class="mt-2 whitespace-pre-wrap break-words font-mono text-[10px] text-[#b4b7c5]">${poolEscapeHtml(item.resultSummary)}</pre></details>` : ''}</article>`;
        }).join('');
    }

    async function refreshPoolMaintenanceOverview(forceStorage = false) {
        if (!document.getElementById('pool-overview-tab-panel')) return;
        if (poolOverviewInFlight) return;
        poolOverviewInFlight = true;
        const button = document.getElementById('btn-pool-overview-refresh');
        if (button) button.disabled = true;
        try {
            const url = `/api/admin/pool-maintenance/overview${forceStorage ? '?refresh=1' : ''}`;
            const response = await fetch(url, { cache: 'no-store' });
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.message || 'Could not load Pool Maintenance overview.');
            renderPoolOverview(data);
        } catch (error) {
            setOverviewStatus(error.message || 'Could not load Pool Maintenance overview.', true);
        } finally {
            poolOverviewInFlight = false;
            if (button) button.disabled = poolOverviewLastPayload?.storage?.status === 'building';
            if (poolOverviewRefreshTimer) clearTimeout(poolOverviewRefreshTimer);
            const overviewIsVisible = activeManagedModalId === 'dead-files-modal'
                && document.getElementById('pool-tab-overview')?.getAttribute('aria-selected') === 'true';
            if (overviewIsVisible) {
                const storageBuilding = poolOverviewLastPayload && poolOverviewLastPayload.storage?.status === 'building';
                poolOverviewRefreshTimer = setTimeout(() => refreshPoolMaintenanceOverview(false), storageBuilding ? 2500 : 15000);
            }
        }
    }

    Object.assign(window, {
        normalizePoolPath, openPoolMaintenanceModal, openDeadFilesModal, openDeadFilesTab,
        openWantedTracksModal, closeDeadFilesModal, closeWantedTracksModal,
        switchPoolMaintenanceTab, updateWantedTracksModeUI, loadWantedTracksData,
        saveWantedTracksSettings, generateWantedTracksNow, loadDeadFilesData,
        updateDeadFileSelectionUI, toggleDeadFileSelection, toggleDeadFileAllSelection,
        pollDeadFileJobStatus, repairSelectedDeadFiles, repairDeadFileFromButton,
        clearDeadFile, purgeDeadFiles, refreshPoolMaintenanceOverview
    });

    window.addEventListener('pagehide', () => {
        if (poolOverviewRefreshTimer) clearTimeout(poolOverviewRefreshTimer);
    });
})();
