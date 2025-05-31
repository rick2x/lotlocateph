$(document).ready(function () {
    // Constants for LocalStorage Keys
    const DEFAULT_SAVE_KEY = 'surveyLotsStore_default'; // Used for backward compatibility and general backup
    const EXPLICIT_DEFAULT_SAVE_NAME = '(Default Survey)';
    const NAMED_SAVES_INDEX_KEY = 'surveyLotsStore_namedSavesIndex';

    let isLocalStorageAvailable = true; // Assume available until checked
    let hasUnsavedChanges = false; // Flag for unsaved changes indicator

    window.currentLoadedSaveName = null; // Track the currently loaded named save

    const primeSymbol = '′';
    const lotListUL = $('#lotList');
    const activeLotEditorArea = $('#activeLotEditorArea');
    const formMessagesArea = $('#formMessages');

    let lotCounter = 0;
    let activeLotId = null;
    let surveyLotsStore = {};

    let map;
    let currentTileLayer = null; // To keep track of the current basemap layer
    const basemaps = {
        'esriImagery': {
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            options: { attribution: 'Tiles &copy; Esri & Contributors', maxZoom: 19 }
        },
        'osmStandard': {
            url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
            options: { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 19 }
        },
        'esriStreet': {
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
            options: { attribution: 'Tiles &copy; Esri &mdash; Source: Esri, DeLorme, NAVTEQ, USGS, Intermap, iPC, NRCAN, Esri Japan, METI, Esri China (Hong Kong), Esri (Thailand), TomTom, 2012', maxZoom: 19 }
        }
    };

    let plottedFeatureGroups = {};
    let mainReferenceMarker = null;
    let currentModifiedMainRefEN = null; // Stores { easting: <value>, northing: <value> } for dragged ref point
    let debounceTimeout;
    let messageFadeTimeoutId = null;
    let loadingOverlayTimerId = null; // Timer ID for the loading overlay
    const LOADING_OVERLAY_DELAY = 300; // milliseconds (e.g., 300ms)

    let isEditorMinimized = false; // State for editor minimize/maximize

    function checkLocalStorageAvailability() {
        const testKey = '__localStorageTest__';
        try {
            localStorage.setItem(testKey, testKey);
            localStorage.removeItem(testKey);
            return true; 
        } catch (e) {
            return false; 
        }
    }

    isLocalStorageAvailable = checkLocalStorageAvailability();

    function safeLocalStorageSet(key, value) {
        if (!isLocalStorageAvailable) { return false; }
        try {
            localStorage.setItem(key, value);
            return true;
        } catch (e) {
            if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
                console.error(`QuotaExceededError for localStorage item ${key}:`, e);
                displayMessage('error', 'Error saving data: Browser storage quota exceeded. Please free up space by deleting old saves or other browser data, then try again.', 0);
            } else {
                console.error(`Error setting localStorage item ${key}:`, e);
                displayMessage('error', 'Error saving data: Local storage might be full or unavailable. Please check browser settings or free up space.');
            }
            return false;
        }
    }

    function safeLocalStorageGet(key) {
        if (!isLocalStorageAvailable) { return null; }
        try { return localStorage.getItem(key); }
        catch (e) { console.error(`Error getting localStorage item ${key}:`, e); displayMessage('error', 'Error retrieving data: Local storage might be unavailable.'); return null; }
    }

    function safeLocalStorageRemove(key) {
        if (!isLocalStorageAvailable) { return false; }
        try { localStorage.removeItem(key); return true; }
        catch (e) { console.error(`Error removing localStorage item ${key}:`, e); displayMessage('error', 'Error removing data: Local storage might be unavailable.'); return false; }
    }

    function safeLocalStorageGetJson(key, defaultValue = null) {
        if (!isLocalStorageAvailable) { return defaultValue; }
        const item = safeLocalStorageGet(key);
        if (item === null) { return defaultValue; }
        try { return JSON.parse(item); }
        catch (e) { console.error(`Error parsing JSON for localStorage item ${key}:`, e); displayMessage('error', `Error: Data for '${key}' appears to be corrupted. Please try resetting or re-saving.`); return defaultValue; }
    }

    let initialBasemapKey = 'esriImagery';
    if (isLocalStorageAvailable) { initialBasemapKey = safeLocalStorageGet('selectedBasemap') || 'esriImagery'; }
    $('#basemapSelect').val(initialBasemapKey);

    function updateActiveSaveStatusDisplay() {
        const statusDisplay = $('#activeSaveNameDisplay');
        let displayName = EXPLICIT_DEFAULT_SAVE_NAME;
        let isActuallyNamed = false;

        if (window.currentLoadedSaveName) {
            displayName = window.currentLoadedSaveName;
            isActuallyNamed = true;
        } else { isActuallyNamed = false; }

        if (hasUnsavedChanges) { displayName += '*'; }
        statusDisplay.text(displayName);

        const statusContainer = statusDisplay.closest('#activeSaveStatusContainer');
        if (isActuallyNamed && window.currentLoadedSaveName !== EXPLICIT_DEFAULT_SAVE_NAME) {
            statusContainer.removeClass('alert-secondary alert-info').addClass('alert-primary');
        } else if (isActuallyNamed && window.currentLoadedSaveName === EXPLICIT_DEFAULT_SAVE_NAME) {
             statusContainer.removeClass('alert-secondary alert-primary').addClass('alert-info');
        }
         else {
            statusContainer.removeClass('alert-primary alert-info').addClass('alert-secondary');
        }
    }

    function updateBasemap(selectedBasemapKey) {
        const selectedLayerConfig = basemaps[selectedBasemapKey];
        if (!selectedLayerConfig) { console.error('Invalid basemap key selected:', selectedBasemapKey); return; }
        if (currentTileLayer) { map.removeLayer(currentTileLayer); }
        currentTileLayer = L.tileLayer(selectedLayerConfig.url, selectedLayerConfig.options);
        currentTileLayer.addTo(map);
    }

    function initMap() {
        if (map) { map.remove(); }
        map = L.map('map', {
            fullscreenControl: { position: 'topright', title: 'Enter fullscreen', titleCancel: 'Exit fullscreen', forcePseudoFullscreen: false },
            zoomControl: false
        }).setView([12.8797, 121.7740], 6);
        updateBasemap(initialBasemapKey);
        L.control.zoom({ position: 'bottomright' }).addTo(map);
        map.on('mousemove', function(e) {
            const coordDisplay = document.getElementById('coordinate-display');
            if (coordDisplay) { coordDisplay.innerHTML = `Lat: ${e.latlng.lat.toFixed(5)}, Lng: ${e.latlng.lng.toFixed(5)}`; }
        });
    }

    $('#basemapSelect').on('change', function() {
        const selectedKey = $(this).val();
        updateBasemap(selectedKey);
        safeLocalStorageSet('selectedBasemap', selectedKey);
    });

    if (typeof $.fn.select2 === 'function') {
        $('#reference_point_select').select2({
            placeholder: "Select Reference Point", allowClear: true, dropdownAutoWidth: true, width: '100%',
            theme: "bootstrap-5"
        }).on('change', function() {
            currentModifiedMainRefEN = null;
            triggerMapUpdateWithDebounce();
        });
    }

    $('#target_crs_select').on('change', function() {
        safeLocalStorageSet('selectedCRS', $(this).val());
        triggerMapUpdateWithDebounce();
    });

    $('#toggleTieLines, #togglePobMarkers, #toggleParcelVertices').on('change', function() { triggerMapUpdateWithDebounce(); });

    let savedCRS = null;
    if (isLocalStorageAvailable) { savedCRS = safeLocalStorageGet('selectedCRS'); }
    if (savedCRS) { $('#target_crs_select').val(savedCRS).trigger('change'); }

    function validateSurveyDataObject(dataObject, sourceName = 'loaded/imported data') {
        if (typeof dataObject !== 'object' || dataObject === null) { console.error(`Validation failed for ${sourceName}: Data is not an object.`); return false; }
        for (const key in dataObject) {
            if (dataObject.hasOwnProperty(key)) {
                const lot = dataObject[key];
                if (typeof lot !== 'object' || lot === null) { console.error(`Validation failed for ${sourceName}: Lot '${key}' is not an object.`); return false; }
                if (typeof lot.id !== 'string') { console.error(`Validation failed for ${sourceName}, Lot '${key}': Property 'id' is not a string.`); return false; }
                if (typeof lot.name !== 'string') { console.error(`Validation failed for ${sourceName}, Lot '${key}': Property 'name' is not a string.`); return false; }
                if (typeof lot.lines_text !== 'string') { console.error(`Validation failed for ${sourceName}, Lot '${key}': Property 'lines_text' is not a string.`); return false; }
                if (typeof lot.num !== 'number') { console.error(`Validation failed for ${sourceName}, Lot '${key}': Property 'num' is not a number.`); return false; }
            }
        }
        return true;
    }

    function formatDataLine(ns, deg, min, ew, dist) {
        const degStr = String(deg).padStart(2, '0');
        const minStr = String(min).padStart(2, '0');
        const distStr = parseFloat(dist).toFixed(2);
        return `${ns} ${degStr}D ${minStr}${primeSymbol} ${ew};${distStr}`;
    }

    function persistActiveLotData() {
        if (!activeLotId || !surveyLotsStore[activeLotId]) { return; }
        const lotNameInput = activeLotEditorArea.find('.lot-name-input.form-control');
        const defaultName = lotNameInput.length ? (lotNameInput.data('default-name') || `Lot ${surveyLotsStore[activeLotId].num}`) : `Lot ${surveyLotsStore[activeLotId].num}`;
        let lotName = lotNameInput.length ? (lotNameInput.val() || defaultName) : defaultName;
        lotName = lotName.trim();
        if (lotName === "") { lotName = defaultName; }
        surveyLotsStore[activeLotId].name = lotName;
        lotListUL.find(`li[data-lot-id="${activeLotId}"] .lot-name-display`).text(lotName);
        const dataLines = [];
        activeLotEditorArea.find('.surveyPointsListContainer .survey-point-row').each(function () {
            const row = $(this);
            const ns = row.find('.point-ns').val();
            const degVal = row.find('.point-deg').val();
            const minVal = row.find('.point-min').val();
            const ew = row.find('.point-ew').val();
            const distVal = row.find('.point-dist').val();
            if (ns && degVal && minVal && ew && distVal) {
                const deg = parseInt(degVal, 10); const min = parseInt(minVal, 10); const dist = parseFloat(distVal);
                if (!isNaN(deg) && deg >= 0 && deg <= 89 && !isNaN(min) && min >= 0 && min <= 59 && !isNaN(dist) && dist > 0) {
                    dataLines.push(formatDataLine(ns, deg, min, ew, dist));
                }
            }
        });
        surveyLotsStore[activeLotId].lines_text = dataLines.join('\n');
        hasUnsavedChanges = true; 
        updateActiveSaveStatusDisplay(); 
        if (activeLotId) { saveCurrentSurvey(window.currentLoadedSaveName || undefined, false); }
    }

    function saveCurrentSurvey(name, isSaveAs = false) {
        let targetSaveName;
        if (name === null || name === undefined) { targetSaveName = window.currentLoadedSaveName || EXPLICIT_DEFAULT_SAVE_NAME; }
        else { targetSaveName = name; }
        const specificSaveKey = `surveyLotsStore_data_${targetSaveName}`;
        let namedSavesIndex = safeLocalStorageGetJson(NAMED_SAVES_INDEX_KEY, {});
        if (isSaveAs && (safeLocalStorageGet(specificSaveKey) !== null || namedSavesIndex[targetSaveName])) {
            if (!confirm(`A survey named "${targetSaveName}" already exists. Overwrite it?`)) {
                displayMessage('info', `Save As for "${targetSaveName}" cancelled.`);
                if (window.currentLoadedSaveName) { populateNamedSavesDropdown(); }
                else { $('#savedSurveysDropdown').val(''); }
                return;
            }
        }
        let overallSaveSuccess = true;
        if (!safeLocalStorageSet(specificSaveKey, JSON.stringify(surveyLotsStore))) { overallSaveSuccess = false; }
        namedSavesIndex[targetSaveName] = true;
        if (!safeLocalStorageSet(NAMED_SAVES_INDEX_KEY, JSON.stringify(namedSavesIndex))) { overallSaveSuccess = false; }
        if (!safeLocalStorageSet(DEFAULT_SAVE_KEY, JSON.stringify(surveyLotsStore))) { overallSaveSuccess = false; }
        if (overallSaveSuccess) {
            window.currentLoadedSaveName = targetSaveName;
            hasUnsavedChanges = false;
            if (isSaveAs) { displayMessage('success', `Survey saved as "${targetSaveName}".`); }
            else { displayMessage('success', `Survey "${targetSaveName}" updated.`); }
        } else { displayMessage('error', `Failed to fully save survey "${targetSaveName}". Check console for details.`); }
        populateNamedSavesDropdown();
        updateActiveSaveStatusDisplay();
    }

    function populateNamedSavesDropdown() {
        const dropdown = $('#savedSurveysDropdown'); const currentlySelected = dropdown.val();
        dropdown.empty().append('<option value="" disabled selected>Select a survey...</option>'); 
        const namedSavesIndex = safeLocalStorageGetJson(NAMED_SAVES_INDEX_KEY, {});
        const names = Object.keys(namedSavesIndex);
        if (names.length === 0) { dropdown.append('<option value="" disabled>No saved surveys yet.</option>'); }
        else { names.sort().forEach(name => { dropdown.append($('<option>', { value: name, text: name })); }); }
        if (window.currentLoadedSaveName && names.includes(window.currentLoadedSaveName)) { dropdown.val(window.currentLoadedSaveName); }
        else if (currentlySelected && names.includes(currentlySelected)) { dropdown.val(currentlySelected); }
        else { dropdown.val(""); }
        dropdown.trigger('change');
    }

    function deleteSurvey(name) {
        if (!name) { displayMessage('error', 'No survey name provided for deletion.'); return; }
        safeLocalStorageRemove(`surveyLotsStore_data_${name}`);
        let namedSavesIndex = safeLocalStorageGetJson(NAMED_SAVES_INDEX_KEY, {});
        if (namedSavesIndex && namedSavesIndex[name]) { delete namedSavesIndex[name]; safeLocalStorageSet(NAMED_SAVES_INDEX_KEY, JSON.stringify(namedSavesIndex)); }
        populateNamedSavesDropdown();
        if (window.currentLoadedSaveName === name) {
            window.currentLoadedSaveName = null;
            displayMessage('info', `Deleted active survey "${name}". Loading next available survey...`);
            loadSurvey();
        } else { displayMessage('success', `Survey "${name}" deleted successfully.`); }
    }

    function loadSurvey(name) {
        let surveyDataToLoad = null; let sourceDescription = ''; let loadedNameForGlobal = null;
        if (name === null || name === undefined) {
            surveyDataToLoad = safeLocalStorageGetJson(`surveyLotsStore_data_${EXPLICIT_DEFAULT_SAVE_NAME}`);
            if (surveyDataToLoad) { sourceDescription = EXPLICIT_DEFAULT_SAVE_NAME; loadedNameForGlobal = EXPLICIT_DEFAULT_SAVE_NAME; }
            else {
                surveyDataToLoad = safeLocalStorageGetJson(DEFAULT_SAVE_KEY);
                if (surveyDataToLoad) { sourceDescription = 'Default Survey (legacy)'; loadedNameForGlobal = null; }
                else { sourceDescription = 'New Survey'; loadedNameForGlobal = null; }
            }
        } else {
            sourceDescription = name; surveyDataToLoad = safeLocalStorageGetJson(`surveyLotsStore_data_${name}`);
            if (surveyDataToLoad) { loadedNameForGlobal = name; } else { loadedNameForGlobal = null;}
        }
        if (surveyDataToLoad && !validateSurveyDataObject(surveyDataToLoad, sourceDescription)) {
            displayMessage('error', `Data for '${sourceDescription}' is invalid or corrupted and cannot be loaded.`);
            surveyDataToLoad = null;
            if (name && name !== EXPLICIT_DEFAULT_SAVE_NAME && name !== DEFAULT_SAVE_KEY) {
                 if (confirm(`The named save '${name}' is corrupted. Would you like to remove it?`)) { deleteSurvey(name); return; }
            }
            loadedNameForGlobal = null;
        }
        window.currentLoadedSaveName = loadedNameForGlobal;
        if (surveyDataToLoad) {
            surveyLotsStore = surveyDataToLoad;
            lotListUL.empty();
            activeLotEditorArea.html('<div class="card-body">Select a lot from the list or add a new one to start editing.</div>').addClass('placeholder');
            activeLotId = null; lotCounter = 0;
            let firstLotId = null; let maxLotNum = 0;
            if (Object.keys(surveyLotsStore).length > 0) {
                for (const lotId in surveyLotsStore) {
                    if (surveyLotsStore.hasOwnProperty(lotId)) {
                        const lotData = surveyLotsStore[lotId];
                        const lotNum = lotData.num || (parseInt(lotId.split('_')[1],10) || ++maxLotNum);
                        maxLotNum = Math.max(maxLotNum, lotNum);
                        const listItemHTML = `<li class="list-group-item d-flex justify-content-between align-items-center" data-lot-id="${lotId}">` +
                                            `<span class="lot-name-display">${$('<div/>').text(lotData.name).html()}</span>` +
                                            `<button class="btn-remove-lot-list btn btn-danger btn-sm" title="Remove ${$('<div/>').text(lotData.name).html()}">×</button>` +
                                         `</li>`;
                        lotListUL.append(listItemHTML);
                        if (!firstLotId) firstLotId = lotId;
                        if (map && !plottedFeatureGroups[lotId]) { plottedFeatureGroups[lotId] = L.featureGroup().addTo(map); }
                        else if (map && plottedFeatureGroups[lotId]) { plottedFeatureGroups[lotId].clearLayers(); }
                    }
                }
                lotCounter = maxLotNum;
                if (firstLotId) { setActiveLot(firstLotId); }
            } else { surveyLotsStore = {}; addLot(); }
            if (name === null || name === undefined) {
                if (sourceDescription === EXPLICIT_DEFAULT_SAVE_NAME) { displayMessage('success', `${EXPLICIT_DEFAULT_SAVE_NAME} loaded.`); }
                else if (sourceDescription === 'Default Survey (legacy)') { displayMessage('info', `Legacy default survey loaded. Consider re-saving.`); }
            } else { displayMessage('success', `Survey "${sourceDescription}" loaded.`); }
        } else {
            surveyLotsStore = {}; window.currentLoadedSaveName = null;
            lotListUL.empty();
            activeLotEditorArea.html('<div class="card-body">Select a lot or add a new one.</div>').addClass('placeholder');
            activeLotId = null; lotCounter = 0;
            if (name && name !== DEFAULT_SAVE_KEY && name !== EXPLICIT_DEFAULT_SAVE_NAME) { displayMessage('error', `Could not find saved survey "${name}". Starting fresh.`); }
            addLot();
        }
        populateNamedSavesDropdown();
        updateActiveSaveStatusDisplay();
        triggerMapUpdateWithDebounce();
    }

    function clearAllLots() {
        if (!confirm('Are you sure you want to clear all lots? This will remove all entered data and cannot be undone.')) { return; }
        surveyLotsStore = {}; window.currentLoadedSaveName = null;
        lotListUL.empty(); clearAllLotMapLayers(true); lotCounter = 0; activeLotId = null;
        activeLotEditorArea.html('<div class="card-body">All lots cleared. Add a new lot to begin.</div>').addClass('placeholder');
        activeLotEditorArea.removeClass('editor-minimized');
        saveCurrentSurvey(null, false);
        addLot();
        displayMessage('info', 'All lots have been cleared and a new Lot 1 started.');
        hasUnsavedChanges = false; updateActiveSaveStatusDisplay();
    }

    function addLot() {
        lotCounter++;
        const newLotId = `lot_${lotCounter}`; const lotNum = lotCounter; const defaultLotName = `Lot ${lotNum}`;
        surveyLotsStore[newLotId] = { id: newLotId, name: defaultLotName, lines_text: "", num: lotNum };
        const listItemHTML = `<li class="list-group-item d-flex justify-content-between align-items-center" data-lot-id="${newLotId}">` +
                                `<span class="lot-name-display">${defaultLotName}</span>` +
                                `<button class="btn-remove-lot-list btn btn-danger btn-sm" title="Remove ${defaultLotName}">×</button>` +
                             `</li>`;
        lotListUL.append(listItemHTML);
        if (map && !plottedFeatureGroups[newLotId]) { plottedFeatureGroups[newLotId] = L.featureGroup().addTo(map); }
        setActiveLot(newLotId);
        saveCurrentSurvey(window.currentLoadedSaveName || undefined, false);
        triggerMapUpdateWithDebounce();
    }

    function removeLot(lotIdToRemove) {
        if (!lotIdToRemove) { return; }
        if (activeLotId && activeLotId !== lotIdToRemove) { persistActiveLotData(); }
        lotListUL.find(`li[data-lot-id="${lotIdToRemove}"]`).remove();
        delete surveyLotsStore[lotIdToRemove];
        if (plottedFeatureGroups[lotIdToRemove]) { if (map.hasLayer(plottedFeatureGroups[lotIdToRemove])) { map.removeLayer(plottedFeatureGroups[lotIdToRemove]); } delete plottedFeatureGroups[lotIdToRemove]; }
        if (activeLotId === lotIdToRemove) {
            activeLotId = null;
            activeLotEditorArea.html('<div class="card-body">Select a lot from the list or add a new one.</div>').addClass('placeholder');
            activeLotEditorArea.removeClass('editor-minimized');
            const firstRemainingLot = lotListUL.find('li:first-child').data('lot-id');
            if (firstRemainingLot) { setActiveLot(firstRemainingLot); }
        }
        saveCurrentSurvey(window.currentLoadedSaveName || undefined, false);
        triggerMapUpdateWithDebounce();
    }

    function setActiveLot(lotIdToActivate) {
        if (!lotIdToActivate || !surveyLotsStore[lotIdToActivate]) {
            activeLotEditorArea.html('<div class="card-body">Lot data not found. Please add or select another lot.</div>').addClass('placeholder');
            activeLotEditorArea.removeClass('editor-minimized'); activeLotId = null;
            if (lotListUL.find('li.active').length === 0 && lotListUL.find('li').length > 0) {
                const firstLotId = lotListUL.find('li:first-child').data('lot-id');
                if (firstLotId && surveyLotsStore[firstLotId]) { lotIdToActivate = firstLotId; } else { return; }
            } else if (!lotListUL.find('li').length || !lotIdToActivate || !surveyLotsStore[lotIdToActivate]) { return; }
        }
        if (activeLotId === lotIdToActivate && !activeLotEditorArea.hasClass('placeholder')) { return; }
        persistActiveLotData();
        activeLotId = lotIdToActivate;
        lotListUL.find('li').removeClass('active');
        lotListUL.find(`li[data-lot-id="${activeLotId}"]`).addClass('active');
        renderActiveLotEditor();
    }

    function renderActiveLotEditor() {
        if (!activeLotId || !surveyLotsStore[activeLotId]) {
            activeLotEditorArea.html('<div class="card-body">Select a lot or add a new one to begin.</div>').addClass('placeholder');
            activeLotEditorArea.removeClass('editor-minimized');
            return;
        }

        activeLotEditorArea.removeClass('placeholder').empty();
        const lotData = surveyLotsStore[activeLotId];
        const sanitizedLotName = $('<div/>').text(lotData.name).html();
        const buttonTextContent = `Add Point to ${sanitizedLotName}`;

        const editorHtml = `
            <div class="lot-editor-header d-flex align-items-center mb-3 p-2 border-bottom">
                <button type="button" class="btn-toggle-editor btn btn-sm btn-outline-secondary me-2" title="Minimize Editor">－</button>
                <label for="${activeLotId}_name_editor" class="form-label me-2 mb-0">Lot:</label>
                <input type="text" id="${activeLotId}_name_editor" class="lot-name-input form-control form-control-sm flex-grow-1" value="${sanitizedLotName}" data-default-name="Lot ${lotData.num}">
            </div>
            <div class="survey-point-editor">
                <h3 class="h5 mt-3 mb-3">Survey Data Points for "<span class="dynamic-lot-name-header">${sanitizedLotName}</span>"</h3>
                <div class="survey-point-table-content">
                    <div class="point-headers d-flex justify-content-between align-items-center mb-2 text-muted small border-bottom pb-1">
                        <span class="header-label p-1">Line</span>
                        <span class="header-ns p-1">N/S</span>
                        <span class="header-deg p-1">Deg</span>
                        <span class="header-min p-1">Min</span>
                        <span class="header-ew p-1">E/W</span>
                        <span class="header-dist p-1">Dist (m)</span>
                        <span class="header-action p-1"></span>
                    </div>
                    <div class="surveyPointsListContainer"></div>
                </div>
            </div>
            <div class="misclosure-display-section mt-3 p-3 border rounded bg-light">
                <h4 class="h6">Lot Misclosure</h4>
                <p class="mb-1 small"><strong>Distance:</strong> <span id="misclosureDistanceDisplay">-</span></p>
                <p class="mb-1 small"><strong>Bearing:</strong> <span id="misclosureBearingDisplay">-</span></p>
            </div>
            <div class="area-display-section mt-3 p-3 border rounded bg-light">
                <h4 class="h6">Lot Area</h4>
                <p class="mb-1 small"><strong>Square meters:</strong> <span id="areaSqmDisplay">-</span></p>
                <p class="mb-1 small"><strong>Hectares:</strong> <span id="areaHectaresDisplay">-</span></p>
            </div>
            <button type="button" class="btn btn-primary btn-sm mt-3 d-block w-100 btn-add-point-to-lot">${buttonTextContent}</button>
        `;
        activeLotEditorArea.html(editorHtml);

        if (lotData && lotData.misclosure) { $('#misclosureDistanceDisplay').text(lotData.misclosure.distance || '-'); $('#misclosureBearingDisplay').text(lotData.misclosure.bearing || '-'); }
        else { $('#misclosureDistanceDisplay').text('-'); $('#misclosureBearingDisplay').text('-'); }
        if (lotData && lotData.areas) { $('#areaSqmDisplay').text(lotData.areas.sqm || '-'); $('#areaHectaresDisplay').text(lotData.areas.hectares || '-'); }
        else { $('#areaSqmDisplay').text('-'); $('#areaHectaresDisplay').text('-'); }

        if (isEditorMinimized) { activeLotEditorArea.addClass('editor-minimized'); activeLotEditorArea.find('.btn-toggle-editor').text('＋').attr('title', 'Maximize Editor'); }
        else { activeLotEditorArea.removeClass('editor-minimized'); activeLotEditorArea.find('.btn-toggle-editor').text('－').attr('title', 'Minimize Editor');}

        activeLotEditorArea.find('.lot-name-input').on('input', function () {
            const currentName = $(this).val().trim(); const defaultName = $(this).data('default-name');
            const displayedName = currentName || defaultName;
            activeLotEditorArea.find('.dynamic-lot-name-header').text(displayedName);
            activeLotEditorArea.find('.btn-add-point-to-lot').text(`Add Point to ${displayedName}`);
            hasUnsavedChanges = true; updateActiveSaveStatusDisplay();
        });

        const surveyPointsListContainer = activeLotEditorArea.find('.surveyPointsListContainer');
        const lines = lotData.lines_text.split('\n').filter(line => line.trim() !== '');
        if (lines.length > 0) { lines.forEach(line => { addSurveyPointRowToActiveEditor(surveyPointsListContainer, line.split(';')); }); }
        else { addSurveyPointRowToActiveEditor(surveyPointsListContainer, null); }
    }

    function addSurveyPointRowToActiveEditor(surveyPointsListContainer, data = null) {
        if (!activeLotId) { return; }
        const lotSpecificPointIndex = surveyPointsListContainer.children().length + 1;
        let nsVal = 'N', degVal = '', minVal = '', ewVal = 'E', distVal = '';

        if (data && data[0] && typeof data[1] !== 'undefined') {
            const bearingParts = parseBearing(data[0]);
            if (bearingParts) { nsVal = bearingParts.ns; degVal = bearingParts.deg; minVal = bearingParts.min; ewVal = bearingParts.ew; }
            distVal = parseFloat(data[1]).toFixed(2);
        }

        const inputNamePrefix = `${activeLotId}_line${lotSpecificPointIndex}`;
        // Removed form-control-sm and form-select-sm, and inline style="width:..."
        const newRowHtml = `
            <div class="survey-point-row d-flex align-items-center mb-2 p-1 border rounded" data-row-index="${lotSpecificPointIndex}">
                <span class="point-label me-2 small text-muted col-form-label">Line ${lotSpecificPointIndex}</span>
                <select class="point-input point-ns form-select me-1" name="${inputNamePrefix}_ns">
                    <option value="N" ${nsVal === 'N' ? 'selected' : ''}>N</option>
                    <option value="S" ${nsVal === 'S' ? 'selected' : ''}>S</option>
                </select>
                <input type="number" class="point-input point-deg form-control me-1" min="0" max="89" placeholder="Deg" value="${degVal}" name="${inputNamePrefix}_deg">
                <input type="number" class="point-input point-min form-control me-1" min="0" max="59" placeholder="Min" value="${minVal}" name="${inputNamePrefix}_min">
                <select class="point-input point-ew form-select me-1" name="${inputNamePrefix}_ew">
                    <option value="E" ${ewVal === 'E' ? 'selected' : ''}>E</option>
                    <option value="W" ${ewVal === 'W' ? 'selected' : ''}>W</option>
                </select>
                <input type="number" class="point-input point-dist form-control me-1 flex-grow-1" step="0.01" min="0.01" placeholder="Dist (m)" value="${distVal}" name="${inputNamePrefix}_dist">
                <div class="btn-remove-point-container ms-auto">
                    <button type="button" class="btn-remove-point btn btn-danger btn-sm" title="Remove this point">×</button>
                </div>
            </div>`;
        surveyPointsListContainer.append(newRowHtml);
        // updateRowLabelsForActiveEditor(surveyPointsListContainer); // Not strictly needed for this change
        hasUnsavedChanges = true; updateActiveSaveStatusDisplay();
    }

    function parseBearing(bearingStr) {
        const match = bearingStr.match(/([NS])\s*(\d+)D\s*(\d+)['′]\s*([EW])/i);
        if (match) { return { ns: match[1].toUpperCase(), deg: parseInt(match[2], 10), min: parseInt(match[3], 10), ew: match[4].toUpperCase() }; }
        return null;
    }

    $('#addLotBtnSidebar').on('click', addLot);
    $('#clearAllLotsBtn').on('click', clearAllLots);
    lotListUL.on('click', 'li.list-group-item', function () { setActiveLot($(this).data('lot-id')); });
    lotListUL.on('click', '.btn-remove-lot-list', function (e) { e.stopPropagation(); if (confirm('Are you sure you want to remove this lot? All its data will be lost.')) { removeLot($(this).closest('li').data('lot-id')); } });
    $('#importSurveyDataBtn').on('click', function() { $('#importSurveyFile').click(); });
    $('#importSurveyFile').on('change', function(event) {
        const file = event.target.files[0]; if (!file) { return; }
        const reader = new FileReader();
        reader.onload = (e) => {
            let importedData; try { importedData = JSON.parse(e.target.result); } catch (err) { displayMessage('error', 'Invalid file format: Not a valid JSON file.'); $(this).val(null); return; }
            if (typeof importedData !== 'object' || importedData === null) { displayMessage('error', 'Invalid data structure: Expected an object.'); $(this).val(null); return; }
            if (!validateSurveyDataObject(importedData, 'imported file')) { displayMessage('error', 'Imported file contains invalid or corrupted survey data. Cannot import.'); $(this).val(null); return; }
            const importChoice = confirm("Choose import mode:\n\nOK = Overwrite Current Survey (unsaved changes will be lost)\nCancel = Import as New Named Save");
            if (importChoice) {
                if (!confirm("Are you sure you want to overwrite your current default survey data? This action cannot be undone.")) { displayMessage('info', 'Import operation to overwrite default cancelled.'); $(this).val(null); return; }
                surveyLotsStore = importedData; window.currentLoadedSaveName = null; saveCurrentSurvey(null, false);
                displayMessage('success', 'Survey data imported and replaced current survey (saved to default).');
            } else {
                const newSaveName = prompt("Enter a name for the new imported survey save:");
                if (newSaveName && newSaveName.trim() !== "") { surveyLotsStore = importedData; saveCurrentSurvey(newSaveName.trim(), true); }
                else { displayMessage('info', 'Import as new save cancelled or no name provided.'); $(this).val(null); return; }
            }
            lotListUL.empty(); activeLotEditorArea.html('<div class="card-body">Select a lot or add a new one.</div>').addClass('placeholder'); activeLotId = null; lotCounter = 0;
            let firstLotId = null;
            Object.keys(surveyLotsStore).forEach(lotId => {
                const lotData = surveyLotsStore[lotId];
                lotData.num = lotData.num || (parseInt(lotId.split('_')[1], 10) || (lotCounter + 1));
                lotCounter = Math.max(lotCounter, lotData.num);
                const listItemHTML = `<li class="list-group-item d-flex justify-content-between align-items-center" data-lot-id="${lotId}">` +
                                    `<span class="lot-name-display">${$('<div/>').text(lotData.name).html()}</span>` +
                                    `<button class="btn-remove-lot-list btn btn-danger btn-sm" title="Remove ${$('<div/>').text(lotData.name).html()}">×</button>` +
                                 `</li>`;
                lotListUL.append(listItemHTML);
                if (!firstLotId) firstLotId = lotId;
                if (map && !plottedFeatureGroups[lotId]) { plottedFeatureGroups[lotId] = L.featureGroup().addTo(map); }
                else if (map && plottedFeatureGroups[lotId]) { plottedFeatureGroups[lotId].clearLayers(); }
            });
            if (firstLotId) { setActiveLot(firstLotId); } else { addLot(); }
            populateNamedSavesDropdown(); triggerMapUpdateWithDebounce(); $(this).val(null);
        };
        reader.onerror = () => { displayMessage('error', 'Error reading file.'); $(this).val(null); };
        reader.readAsText(file);
    });
    $('#exportSurveyDataBtn').on('click', function() {
        persistActiveLotData();
        if (Object.keys(surveyLotsStore).length === 0) { displayMessage('info', 'No survey data to export.'); return; }
        let hasMeaningfulData = false;
        for (const lotId in surveyLotsStore) { if (surveyLotsStore.hasOwnProperty(lotId)) { const lot = surveyLotsStore[lotId]; if ((lot.lines_text && lot.lines_text.trim() !== "") || (lot.name && lot.name.trim() !== `Lot ${lot.num}`)) { hasMeaningfulData = true; break; } } }
        if (!hasMeaningfulData) { displayMessage('info', 'No actual survey data to export. Add lines to lots or change their default names.'); return; }
        try {
            const surveyDataJson = JSON.stringify(surveyLotsStore, null, 2); const blob = new Blob([surveyDataJson], { type: 'application/json' });
            const filename = 'survey_data.llph'; const url = window.URL.createObjectURL(blob); const a = document.createElement('a');
            a.style.display = 'none'; a.href = url; a.download = filename; document.body.appendChild(a); a.click();
            window.URL.revokeObjectURL(url); document.body.removeChild(a); displayMessage('success', `Survey data exported as '${filename}'.`);
        } catch (error) { console.error('Error exporting survey data:', error); displayMessage('error', 'Could not export survey data.'); }
    });

    activeLotEditorArea.on('click', '.btn-toggle-editor', function () {
        isEditorMinimized = !isEditorMinimized; const editor = $(this).closest('.active-lot-editor-container'); const button = $(this);
        const addLotBtnSidebar = $('#addLotBtnSidebar');
        if (isEditorMinimized) { editor.addClass('editor-minimized'); button.text('＋').attr('title', 'Maximize Editor'); addLotBtnSidebar.addClass('d-none');}
        else { editor.removeClass('editor-minimized'); button.text('－').attr('title', 'Minimize Editor'); addLotBtnSidebar.removeClass('d-none');}
        if (map) { setTimeout(() => { map.invalidateSize(); }, 350); }
    });
    activeLotEditorArea.on('click', '.btn-add-point-to-lot', function () { const surveyPointsListContainer = activeLotEditorArea.find('.surveyPointsListContainer'); addSurveyPointRowToActiveEditor(surveyPointsListContainer, null); triggerMapUpdateWithDebounce(); });
    activeLotEditorArea.on('click', '.btn-remove-point', function () { const pointRow = $(this).closest('.survey-point-row'); const surveyPointsListContainer = pointRow.parent(); pointRow.remove(); /* updateRowLabelsForActiveEditor(surveyPointsListContainer); */ hasUnsavedChanges = true; updateActiveSaveStatusDisplay(); triggerMapUpdateWithDebounce(); });
    activeLotEditorArea.on('input change', '.point-input, .lot-name-input', function () { triggerMapUpdateWithDebounce(); });

    function showLoading(message = "Processing...") { if (loadingOverlayTimerId) { clearTimeout(loadingOverlayTimerId); } loadingOverlayTimerId = setTimeout(() => { const overlay = $('#loadingOverlay'); const messageElement = $('#loadingMessage'); if (messageElement.length && overlay.length) { messageElement.text(message); overlay.css('display', 'flex'); } loadingOverlayTimerId = null; }, LOADING_OVERLAY_DELAY); }
    function hideLoading() { if (loadingOverlayTimerId) { clearTimeout(loadingOverlayTimerId); loadingOverlayTimerId = null; } const overlay = $('#loadingOverlay'); if (overlay.length) { overlay.css('display', 'none'); } }

    function displayMessage(type, message, duration = 5000) {
        if (messageFadeTimeoutId) { clearTimeout(messageFadeTimeoutId); }
        formMessagesArea.empty();
        let alertClass = 'alert-info';
        if (type === 'error') alertClass = 'alert-danger';
        else if (type === 'success') alertClass = 'alert-success';
        else if (type === 'warning') alertClass = 'alert-warning';
        
        const messageDiv = $(`<div class="alert ${alertClass} alert-dismissible fade show" role="alert">${message}<button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button></div>`);
        formMessagesArea.append(messageDiv);

        if (duration > 0) {
            messageFadeTimeoutId = setTimeout(function () {
                messageDiv.alert('close');
                messageFadeTimeoutId = null;
            }, duration);
        }
    }

    function clearMessages() { if (messageFadeTimeoutId) { clearTimeout(messageFadeTimeoutId); messageFadeTimeoutId = null; } formMessagesArea.empty(); }
    function validateSurveyInputs(showAlerts = true, eventTargetId = null) {
        let formIsValid = true;
        if ($('#target_crs_select').val() === "") { if (showAlerts) { displayMessage('error', "CRS not selected."); } formIsValid = false; }
        const lotsForPayload = getLotsForPayload();
        if ($('#reference_point_select').val() === "" && lotsForPayload.length > 0 && lotsForPayload.some(l => l.lines_text.trim() !== "")) { if (showAlerts) { displayMessage('error', "Please select a Reference Point when lot data exists."); } formIsValid = false; }
        let specificErrorMessage = null;
        const lotIds = Object.keys(surveyLotsStore);
        for (let i = 0; i < lotIds.length; i++) {
            const lotId = lotIds[i]; const lot = surveyLotsStore[lotId]; const lines = lot.lines_text.split('\n').filter(l => l.trim() !== '');
            if (lines.length > 0) {
                for (let j = 0; j < lines.length; j++) {
                    const line = lines[j]; const lineNum = j + 1; const parts = line.split(';');
                    if (parts.length < 2) { specificErrorMessage = `Lot "${lot.name}", Line ${lineNum}: Incomplete line data.`; formIsValid = false; break; }
                    const bearingData = parseBearing(parts[0]); const distStr = parts[1].trim(); const dist = parseFloat(distStr);
                    if (!bearingData) { specificErrorMessage = `Lot "${lot.name}", Line ${lineNum}: Invalid bearing format.`; formIsValid = false; break; }
                    if (typeof bearingData.deg !== 'number' || !Number.isInteger(bearingData.deg) || bearingData.deg < 0 || bearingData.deg > 89) { specificErrorMessage = `Lot "${lot.name}", Line ${lineNum}: Degrees must be an integer between 0 and 89.`; formIsValid = false; break; }
                    if (typeof bearingData.min !== 'number' || !Number.isInteger(bearingData.min) || bearingData.min < 0 || bearingData.min > 59) { specificErrorMessage = `Lot "${lot.name}", Line ${lineNum}: Minutes must be an integer between 0 and 59.`; formIsValid = false; break; }
                    if (isNaN(dist) || dist <= 0) { specificErrorMessage = `Lot "${lot.name}", Line ${lineNum}: Distance must be a positive number.`; formIsValid = false; break; }
                }
            }
            if (!formIsValid) break;
        }
        if (!formIsValid && specificErrorMessage && showAlerts) { displayMessage('error', specificErrorMessage); }
        const isExportAction = (targetId) => ['exportShapefileBtn', 'exportKmzBtn', 'exportDxfBtn', 'exportGeoJsonBtn'].includes(targetId);
        if (isExportAction(eventTargetId) && lotsForPayload.filter(l => l.lines_text.trim() !== "").length === 0 && !$('#reference_point_select').val()) { if (showAlerts) { displayMessage('error', "Cannot export: No reference point selected and no lot data with lines provided."); } formIsValid = false; }
        else if (isExportAction(eventTargetId) && lotsForPayload.filter(l => l.lines_text.trim() !== "").length === 0 && $('#reference_point_select').val()) { if (showAlerts) { displayMessage('info', "No lot data with lines. Export will only include the reference point if applicable."); } }
        return formIsValid;
    }
    function triggerMapUpdateWithDebounce() { clearTimeout(debounceTimeout); persistActiveLotData(); debounceTimeout = setTimeout(() => { fetchAndPlotMapData(); }, 700); }
    function getLotsForPayload() { const payloadLots = []; for (const lotId in surveyLotsStore) { if (surveyLotsStore.hasOwnProperty(lotId)) { const lot = surveyLotsStore[lotId]; if (lot.lines_text.trim() !== "" || lot.name.trim() !== `Lot ${lot.num}` || Object.keys(surveyLotsStore).length === 1) { payloadLots.push({ id: lot.id, name: lot.name, lines_text: lot.lines_text }); } } } return payloadLots; }
    function getPayloadForServer() { persistActiveLotData(); const payload = { target_crs_select: $('#target_crs_select').val(), reference_point_select: $('#reference_point_select').val(), lots: getLotsForPayload() }; if (currentModifiedMainRefEN && currentModifiedMainRefEN.easting !== undefined && currentModifiedMainRefEN.northing !== undefined) { payload.main_ref_e = currentModifiedMainRefEN.easting; payload.main_ref_n = currentModifiedMainRefEN.northing; } return payload; }
    function fetchAndPlotMapData() {
        clearMessages();
        if (!validateSurveyInputs(false, null)) { displayMessage('warning', "Map not updated due to invalid or incomplete inputs."); return; }
        const payload = getPayloadForServer(); const hasLotsWithLines = payload.lots.some(l => l.lines_text.trim() !== "");
        if (!payload.reference_point_select && !hasLotsWithLines && payload.lots.length === 0) { clearAllLotMapLayers(true); return; }
        if (hasLotsWithLines && !payload.reference_point_select) { clearAllLotMapLayers(true); displayMessage('error', "A reference point must be selected to plot lot data."); return; }
        showLoading('Updating map...');
        fetch('/calculate_plot_data_multi', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        .then(response => response.json())
        .then(result => {
            clearMessages();
            if (result.status === 'success' || result.status === 'success_with_errors') {
                (result.data_per_lot || []).forEach(lotResult => { if (surveyLotsStore[lotResult.lot_id]) { if (lotResult.misclosure) { surveyLotsStore[lotResult.lot_id].misclosure = lotResult.misclosure; } if (lotResult.areas) { surveyLotsStore[lotResult.lot_id].areas = lotResult.areas; } } });
                plotMultiLotDataOnMap(result.data_per_lot, result.reference_plot_data);
                if (activeLotId && surveyLotsStore[activeLotId] && surveyLotsStore[activeLotId].misclosure) { $('#misclosureDistanceDisplay').text(surveyLotsStore[activeLotId].misclosure.distance || '-'); $('#misclosureBearingDisplay').text(surveyLotsStore[activeLotId].misclosure.bearing || '-'); }
                else if (activeLotId) { $('#misclosureDistanceDisplay').text('-'); $('#misclosureBearingDisplay').text('-'); }
                if (activeLotId && surveyLotsStore[activeLotId] && surveyLotsStore[activeLotId].areas) { $('#areaSqmDisplay').text(surveyLotsStore[activeLotId].areas.sqm || '-'); $('#areaHectaresDisplay').text(surveyLotsStore[activeLotId].areas.hectares || '-'); }
                else if (activeLotId) { $('#areaSqmDisplay').text('-'); $('#areaHectaresDisplay').text('-'); }
                if (result.status === 'success_with_errors') {
                    let errorMessages = ["Map updated. Some lots may have issues:"];
                    (result.data_per_lot || []).forEach(lr => { if (lr.status === 'error') { errorMessages.push(`Lot '${lr.lot_name}': ${lr.message}`); } else if (lr.status === 'nodata' && payload.lots.find(l => l.id === lr.lot_id && l.lines_text.trim() !== "")) { errorMessages.push(`Lot '${lr.lot_name}': No plottable geometry from provided lines.`); } });
                    if (errorMessages.length > 1) { displayMessage('warning', errorMessages.join('<br>')); } else { displayMessage('info', 'Map updated.'); }
                } else { displayMessage('info', 'Map updated successfully.'); }
            } else { displayMessage('error', 'Plotting Error: ' + (result.message || "Unknown server error.")); clearAllLotMapLayers(true); }
        })
        .catch(error => { clearMessages(); console.error('Plot Fetch Error:', error); displayMessage('error', 'Failed to update map. Check console or server logs.'); clearAllLotMapLayers(true); })
        .finally(() => { hideLoading(); });
    }
    function clearAllLotMapLayers(clearMainRef = false) { for (const lotId in plottedFeatureGroups) { if (plottedFeatureGroups[lotId] && map.hasLayer(plottedFeatureGroups[lotId])) { map.removeLayer(plottedFeatureGroups[lotId]); } } plottedFeatureGroups = {}; if (clearMainRef && mainReferenceMarker && map.hasLayer(mainReferenceMarker)) { map.removeLayer(mainReferenceMarker); mainReferenceMarker = null; } }
    const lotColors = ['#007bff', '#6f42c1', '#fd7e14', '#28a745', '#dc3545', '#17a2b8', '#ffc107', '#6c757d'];
    function plotMultiLotDataOnMap(dataPerLot, referencePlotData) {
        if (!map) { initMap(); } clearAllLotMapLayers(false);
        const showTieLines = $('#toggleTieLines').is(':checked'); const showPobMarkers = $('#togglePobMarkers').is(':checked'); const showParcelVertices = $('#toggleParcelVertices').is(':checked');
        let allLatLngsForBounds = [];
        if (mainReferenceMarker && map.hasLayer(mainReferenceMarker)) { map.removeLayer(mainReferenceMarker); mainReferenceMarker = null; }
        if (referencePlotData && referencePlotData.reference_marker_latlng) {
            mainReferenceMarker = L.marker(referencePlotData.reference_marker_latlng, { title: "Reference Point (Drag to modify)", draggable: true }).bindPopup("Reference Point (Drag to modify location)");
            mainReferenceMarker.on('dragend', function(event) {
                const newLatLng = event.target.getLatLng(); const targetCrs = $('#target_crs_select').val();
                if (!targetCrs) { displayMessage('error', 'Target CRS not selected. Cannot transform coordinates.'); return; }
                showLoading('Transforming reference point...');
                fetch('/api/transform_to_projected', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ latitude: newLatLng.lat, longitude: newLatLng.lng, target_crs_epsg: targetCrs }) })
                .then(response => response.json())
                .then(result => {
                    if (result.status === "success") { currentModifiedMainRefEN = { easting: result.easting, northing: result.northing }; displayMessage('info', `Reference point E/N updated to: ${result.easting.toFixed(3)}, ${result.northing.toFixed(3)}. Recalculating lots...`); fetchAndPlotMapData(); }
                    else { currentModifiedMainRefEN = null; displayMessage('error', `Failed to transform reference point: ${result.message}`); }
                })
                .catch(error => { currentModifiedMainRefEN = null; console.error('Transform API Error:', error); displayMessage('error', 'Failed to transform reference point coordinates due to a network or server error.'); })
                .finally(() => { hideLoading(); });
            });
            mainReferenceMarker.addTo(map); allLatLngsForBounds.push(referencePlotData.reference_marker_latlng);
        }
        (dataPerLot || []).forEach((lotResult, index) => {
            const lotId = lotResult.lot_id; const lotName = lotResult.lot_name;
            if (lotResult.status !== 'success') { if (plottedFeatureGroups[lotId] && map.hasLayer(plottedFeatureGroups[lotId])) { map.removeLayer(plottedFeatureGroups[lotId]); delete plottedFeatureGroups[lotId]; } return; }
            const plotData = lotResult.plot_data; const color = lotColors[index % lotColors.length];
            if (!plottedFeatureGroups[lotId]) { plottedFeatureGroups[lotId] = L.featureGroup(); } else { plottedFeatureGroups[lotId].clearLayers(); }
            let currentLotFeatureGroup = plottedFeatureGroups[lotId]; let lotHasDrawableData = false;
            if (showTieLines && plotData.tie_line_latlngs && plotData.tie_line_latlngs.length > 0) { const tieLine = L.polyline(plotData.tie_line_latlngs, { color: '#e60000', dashArray: '6, 6', weight: 2.5, opacity: 0.8 }).bindPopup(`Tie-Line for ${lotName}`); currentLotFeatureGroup.addLayer(tieLine); plotData.tie_line_latlngs.forEach(p => allLatLngsForBounds.push(p)); lotHasDrawableData = true; }
            if (plotData.parcel_polygon_latlngs && plotData.parcel_polygon_latlngs.length > 0) {
                let parcelPath = plotData.parcel_polygon_latlngs; const parcelPolyline = L.polyline(parcelPath, { color: color, weight: 3.5, opacity: 0.9 }).bindPopup(`Boundary: ${lotName}`); currentLotFeatureGroup.addLayer(parcelPolyline); parcelPath.forEach(p => allLatLngsForBounds.push(p)); lotHasDrawableData = true;
                parcelPath.forEach((point, pIndex) => {
                    let label = (pIndex === 0) ? `POB: ${lotName}` : `Pt ${pIndex + 1}: ${lotName}`; const isPobPoint = pIndex === 0; const isClosingPoint = pIndex === parcelPath.length - 1 && pIndex > 0 && parcelPath[0][0] === point[0] && parcelPath[0][1] === point[1];
                    if (isClosingPoint) {}
                    else if (isPobPoint && showPobMarkers) { const pobMarker = L.circleMarker(point, { radius: 5, color: color, weight: 1, fillColor: '#FFD700', fillOpacity: 0.9, title: label }).bindPopup(label); currentLotFeatureGroup.addLayer(pobMarker); }
                    else if (!isPobPoint && showParcelVertices) { const vertexMarker = L.circleMarker(point, { radius: 4.5, color: color, weight: 1, fillColor: color, fillOpacity: 0.7, title: label }).bindPopup(label); currentLotFeatureGroup.addLayer(vertexMarker); }
                });
            }
            if (lotHasDrawableData && !map.hasLayer(currentLotFeatureGroup)) { currentLotFeatureGroup.addTo(map); }
            else if (!lotHasDrawableData && map.hasLayer(currentLotFeatureGroup)) { map.removeLayer(currentLotFeatureGroup); }
        });
        if (allLatLngsForBounds.length > 0) { map.fitBounds(L.latLngBounds(allLatLngsForBounds), { padding: [40, 40], maxZoom: 19 }); }
        else if (mainReferenceMarker) { map.setView(mainReferenceMarker.getLatLng(), 17); }
    }
    function handleFileDownload(response, defaultFilename) { if (!response.ok) { return response.json().then(err => { throw new Error(err.message || `Server error: ${response.status}`); }); } const disposition = response.headers.get('Content-Disposition'); let filename = defaultFilename; if (disposition && disposition.indexOf('attachment') !== -1) { const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/; const matches = filenameRegex.exec(disposition); if (matches != null && matches[1]) { filename = matches[1].replace(/['"]/g, ''); } } return response.blob().then(blob => ({ blob, filename })); }
    function triggerDownload(blob, filename, successMessageBase) { clearMessages(); const url = window.URL.createObjectURL(blob); const a = document.createElement('a'); a.style.display = 'none'; a.href = url; a.download = filename; document.body.appendChild(a); a.click(); window.URL.revokeObjectURL(url); document.body.removeChild(a); displayMessage('info', `${successMessageBase} '${filename}' downloaded.`); }

    $('#exportShapefileBtn, #exportKmzBtn, #exportDxfBtn, #exportGeoJsonBtn').on('click', function (e) {
        clearMessages(); persistActiveLotData();
        if (!validateSurveyInputs(true, e.target.id)) { return; }
        const payload = getPayloadForServer();
        if (!payload.reference_point_select && payload.lots.filter(l => l.lines_text.trim() !== "").length === 0) { displayMessage('error', "Select Reference Point or add Lot Data for export."); return; }
        if (payload.lots.filter(l => l.lines_text.trim() !== "").length > 0 && !payload.reference_point_select) { displayMessage('error', "Reference Point must be selected to export lot data."); return; }
        
        const exportType = e.target.id.replace('export', '').replace('Btn', '').toLowerCase();
        let endpoint = `/export_${exportType}_multi`;
        let defaultFilename = `survey_export_multi.${exportType === 'shapefile' ? 'zip' : exportType}`;
        let friendlyName = exportType.toUpperCase();
        if (exportType === 'shapefile') friendlyName = 'Shapefile layers'; else if (exportType === 'geojson') friendlyName = 'GeoJSON file';

        showLoading(`Preparing ${friendlyName} export...`);
        $('.btn-export').prop('disabled', true);
        fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        .then(response => handleFileDownload(response, defaultFilename))
        .then(({ blob, filename }) => { triggerDownload(blob, filename, friendlyName); })
        .catch(error => { clearMessages(); console.error(`${friendlyName} Export Error:`, error); displayMessage('error', `${friendlyName} Export Failed: ${error.message}`); })
        .finally(() => { hideLoading(); $('.btn-export').prop('disabled', false); });
    });

    $('#saveSurveyBtn').on('click', function() { if (activeLotId) { persistActiveLotData(); } else { saveCurrentSurvey(window.currentLoadedSaveName || undefined, false); } });
    $('#saveAsSurveyBtn').on('click', function() { if (activeLotId) { persistActiveLotData(); } const name = prompt("Enter a name for this survey save (current survey will be saved under this new name):"); if (name && name.trim() !== "") { saveCurrentSurvey(name.trim(), true); } else if (name !== null) { displayMessage('warning', 'Save As name cannot be empty.'); } });
    $('#savedSurveysDropdown').on('change', function() { const selectedName = $(this).val(); if (selectedName) { $('#loadSelectedSurveyBtn, #deleteSelectedSurveyBtn').prop('disabled', false); } else { $('#loadSelectedSurveyBtn, #deleteSelectedSurveyBtn').prop('disabled', true); } });
    $('#loadSelectedSurveyBtn').on('click', function() { const selectedName = $('#savedSurveysDropdown').val(); if (selectedName) { loadSurvey(selectedName); } else { displayMessage('warning', 'Please select a survey to load.'); } });
    $('#deleteSelectedSurveyBtn').on('click', function() { const selectedName = $('#savedSurveysDropdown').val(); if (selectedName) { if (confirm(`Are you sure you want to delete the survey "${selectedName}"? This cannot be undone.`)) { deleteSurvey(selectedName); } } else { displayMessage('warning', 'Please select a survey to delete.'); } });

    if (isLocalStorageAvailable) { populateNamedSavesDropdown(); loadSurvey(); updateActiveSaveStatusDisplay(); }
    else {
        surveyLotsStore = {}; window.currentLoadedSaveName = null; activeLotId = null; lotCounter = 0;
        populateNamedSavesDropdown(); updateActiveSaveStatusDisplay(); addLot();
        displayMessage('error', 'Warning: Browser storage is unavailable or disabled. Saving, loading, and survey preferences will not work. Please check your browser settings.', 0);
        const UIElementsToDisable = ['#saveSurveyBtn', '#saveAsSurveyBtn', '#savedSurveysDropdown', '#loadSelectedSurveyBtn', '#deleteSelectedSurveyBtn', '#importSurveyDataBtn', '#importSurveyFile', '#resetApplicationDataBtn', '#basemapSelect', '#target_crs_select'];
        UIElementsToDisable.forEach(selector => { $(selector).prop('disabled', true).css('opacity', 0.5).attr('title', 'Feature disabled: Browser storage unavailable.'); });
    }

    $('#resetApplicationDataBtn').on('click', function() {
        if (!isLocalStorageAvailable) { displayMessage('error', 'Browser storage is unavailable. Reset is not applicable.'); return; }
        if (!confirm("WARNING: This will delete ALL survey data, including all named saves and the default survey, from your browser's storage. This action cannot be undone. Are you absolutely sure you want to proceed?")) { return; }
        const namedSavesIndex = safeLocalStorageGetJson(NAMED_SAVES_INDEX_KEY, {});
        for (const name in namedSavesIndex) { if (namedSavesIndex.hasOwnProperty(name)) { safeLocalStorageRemove(`surveyLotsStore_data_${name}`); } }
        safeLocalStorageRemove(NAMED_SAVES_INDEX_KEY); safeLocalStorageRemove(DEFAULT_SAVE_KEY);
        safeLocalStorageRemove('selectedBasemap'); safeLocalStorageRemove('selectedCRS');
        surveyLotsStore = {}; window.currentLoadedSaveName = null; activeLotId = null; lotCounter = 0;
        $('#lotList').empty(); activeLotEditorArea.html('<div class="card-body">Select a lot from the list or add a new one to start editing.</div>').addClass('placeholder');
        populateNamedSavesDropdown(); updateActiveSaveStatusDisplay();
        addLot(); triggerMapUpdateWithDebounce();
        displayMessage('info', 'All application data has been reset. Starting with a fresh survey.');
        hasUnsavedChanges = false; updateActiveSaveStatusDisplay();
    });

    initMap();
});
