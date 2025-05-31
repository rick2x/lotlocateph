
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

    // Basemap Persistence - Load
    // let initialBasemapKey = localStorage.getItem('selectedBasemap') || 'esriImagery'; // Default to 'esriImagery'
    // Will be replaced by safeLocalStorageGet
    // $('#basemapSelect').val(initialBasemapKey); // Set dropdown to reflect loaded/default choice

    // --- LocalStorage Availability Check ---
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

    isLocalStorageAvailable = checkLocalStorageAvailability(); // Set the global flag

    // --- Safe LocalStorage Utilities ---
    function safeLocalStorageSet(key, value) {
        if (!isLocalStorageAvailable) {
            // displayMessage('error', 'Browser storage is unavailable. Cannot save data.'); // Main warning at startup
            return false;
        }
        try {
            localStorage.setItem(key, value);
            return true;
        } catch (e) {
            if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
                console.error(`QuotaExceededError for localStorage item ${key}:`, e);
                displayMessage('error', 'Error saving data: Browser storage quota exceeded. Please free up space by deleting old saves or other browser data, then try again.', 0); // Non-fading
            } else {
                console.error(`Error setting localStorage item ${key}:`, e);
                displayMessage('error', 'Error saving data: Local storage might be full or unavailable. Please check browser settings or free up space.');
            }
            return false;
        }
    }

    function safeLocalStorageGet(key) {
        if (!isLocalStorageAvailable) {
            return null; 
        }
        try {
            return localStorage.getItem(key);
        } catch (e) {
            console.error(`Error getting localStorage item ${key}:`, e);
            displayMessage('error', 'Error retrieving data: Local storage might be unavailable.');
            return null; 
        }
    }

    function safeLocalStorageRemove(key) {
        if (!isLocalStorageAvailable) {
            return false;
        }
        try {
            localStorage.removeItem(key);
            return true;
        } catch (e) {
            console.error(`Error removing localStorage item ${key}:`, e);
            displayMessage('error', 'Error removing data: Local storage might be unavailable.');
            return false;
        }
    }

    function safeLocalStorageGetJson(key, defaultValue = null) {
        if (!isLocalStorageAvailable) {
            return defaultValue;
        }
        const item = safeLocalStorageGet(key); // This already checks isLocalStorageAvailable
        if (item === null) { 
            return defaultValue;
        }
        try {
            return JSON.parse(item);
        } catch (e) {
            console.error(`Error parsing JSON for localStorage item ${key}:`, e);
            displayMessage('error', `Error: Data for '${key}' appears to be corrupted. Please try resetting or re-saving.`);
            return defaultValue;
        }
    }

    // Basemap Persistence - Load (using safe utility)
    let initialBasemapKey = 'esriImagery'; // Default value if localStorage is not available
    if (isLocalStorageAvailable) {
        initialBasemapKey = safeLocalStorageGet('selectedBasemap') || 'esriImagery';
    }
    $('#basemapSelect').val(initialBasemapKey);

    // --- UI Update Functions ---
    function updateActiveSaveStatusDisplay() {
        const statusDisplay = $('#activeSaveNameDisplay');
        let displayName = EXPLICIT_DEFAULT_SAVE_NAME; // Default to the explicit default survey name
        let isActuallyNamed = false; // Tracks if it's a user-defined name or the explicit default

        if (window.currentLoadedSaveName) {
            displayName = window.currentLoadedSaveName;
            // Consider EXPLICIT_DEFAULT_SAVE_NAME as "named" for styling if it's the current one
            isActuallyNamed = true;
        } else {
            // If window.currentLoadedSaveName is null, it implies a truly empty session or legacy default.
            // The displayName will remain EXPLICIT_DEFAULT_SAVE_NAME, but it won't be styled as "named".
            // This state should ideally be temporary until the first save operation.
            isActuallyNamed = false;
        }

        if (hasUnsavedChanges) {
            displayName += '*';
        }
        statusDisplay.text(displayName);

        // Style based on whether it's considered a named save (including EXPLICIT_DEFAULT_SAVE_NAME)
        // or the more generic implicit default state (when window.currentLoadedSaveName is null).
        if (isActuallyNamed) { // This will be true if window.currentLoadedSaveName is set (incl. to EXPLICIT_DEFAULT_SAVE_NAME)
            statusDisplay.closest('#activeSaveStatusContainer').css('background-color', '#d4edda'); // Light green
        } else {
            statusDisplay.closest('#activeSaveStatusContainer').css('background-color', '#e9ecef'); // Default grey
        }
    }

    // --- INITIALIZATION ---

    function updateBasemap(selectedBasemapKey) {
        const selectedLayerConfig = basemaps[selectedBasemapKey];

        if (!selectedLayerConfig) {
            console.error('Invalid basemap key selected:', selectedBasemapKey);
            return;
        }

        if (currentTileLayer) {
            map.removeLayer(currentTileLayer);
        }

        currentTileLayer = L.tileLayer(selectedLayerConfig.url, selectedLayerConfig.options);
        currentTileLayer.addTo(map);
    }

    function initMap() {
        if (map) {
            map.remove(); // Remove existing map instance if any
        }
        map = L.map('map', {
            fullscreenControl: {
                position: 'topright',
                title: 'Enter fullscreen',
                titleCancel: 'Exit fullscreen',
                forcePseudoFullscreen: false
            },
            zoomControl: false // Disable the default zoom control
        }).setView([12.8797, 121.7740], 6); // Default view over the Philippines
        
        updateBasemap(initialBasemapKey); // Use the loaded/default key

        L.control.zoom({
            position: 'bottomright' // Add zoom control to bottom right
        }).addTo(map);

        // Add the mousemove event listener here
        map.on('mousemove', function(e) {
            const coordinateDisplayElement = document.getElementById('coordinate-display');
            if (coordinateDisplayElement) {
                const lat = e.latlng.lat;
                const lng = e.latlng.lng;
                coordinateDisplayElement.innerHTML = `Lat: ${lat.toFixed(5)}, Lng: ${lng.toFixed(5)}`;
            }
        });
    }

    // Basemap selector change event
    $('#basemapSelect').on('change', function() {
        const selectedKey = $(this).val();
        updateBasemap(selectedKey);
        safeLocalStorageSet('selectedBasemap', selectedKey); // Basemap Persistence - Save
    });

    if (typeof $.fn.select2 === 'function') {
        $('#reference_point_select').select2({
            placeholder: "Select Reference Point",
            allowClear: true,
            dropdownAutoWidth: true,
            width: '100%',
            theme: "default"
        }).on('change', function() { // Modified to a full function to include reset
            currentModifiedMainRefEN = null; // Reset modified coordinates on dropdown change
            triggerMapUpdateWithDebounce();
        });
    }

    $('#target_crs_select').on('change', function() {
        safeLocalStorageSet('selectedCRS', $(this).val());
        triggerMapUpdateWithDebounce();
    });

    // Event listeners for map display toggles
    $('#toggleTieLines, #togglePobMarkers, #toggleParcelVertices').on('change', function() {
        triggerMapUpdateWithDebounce();
    });

    $('#closeDisclaimerBtn').on('click', function () {
        $('#disclaimerBar').slideUp();
    });

    // Load and apply saved CRS from LocalStorage
    let savedCRS = null;
    if (isLocalStorageAvailable) {
        savedCRS = safeLocalStorageGet('selectedCRS');
    }
    if (savedCRS) {
        $('#target_crs_select').val(savedCRS);
        // Trigger change to apply the loaded CRS and update map/UI accordingly
        $('#target_crs_select').trigger('change'); 
    }

    // --- DATA MANAGEMENT & PREVIEW ---

    function validateSurveyDataObject(dataObject, sourceName = 'loaded/imported data') {
        if (typeof dataObject !== 'object' || dataObject === null) {
            console.error(`Validation failed for ${sourceName}: Data is not an object.`);
            return false;
        }

        for (const key in dataObject) {
            if (dataObject.hasOwnProperty(key)) {
                const lot = dataObject[key];
                if (typeof lot !== 'object' || lot === null) {
                    console.error(`Validation failed for ${sourceName}: Lot '${key}' is not an object.`);
                    return false;
                }
                if (typeof lot.id !== 'string') {
                    console.error(`Validation failed for ${sourceName}, Lot '${key}': Property 'id' is not a string.`);
                    return false;
                }
                if (typeof lot.name !== 'string') {
                    console.error(`Validation failed for ${sourceName}, Lot '${key}': Property 'name' is not a string.`);
                    return false;
                }
                if (typeof lot.lines_text !== 'string') {
                    console.error(`Validation failed for ${sourceName}, Lot '${key}': Property 'lines_text' is not a string.`);
                    return false;
                }
                if (typeof lot.num !== 'number') {
                    console.error(`Validation failed for ${sourceName}, Lot '${key}': Property 'num' is not a number.`);
                    return false;
                }
                // Optional: Basic lines_text format check (omitted for now as per instructions)
            }
        }
        return true; // All checks passed
    }

    function formatDataLine(ns, deg, min, ew, dist) {
        const degStr = String(deg).padStart(2, '0');
        const minStr = String(min).padStart(2, '0');
        const distStr = parseFloat(dist).toFixed(2);
        return `${ns} ${degStr}D ${minStr}${primeSymbol} ${ew};${distStr}`;
    }

    function persistActiveLotData() {
        if (!activeLotId || !surveyLotsStore[activeLotId]) {
            return;
        }

        const lotNameInput = activeLotEditorArea.find('.lot-name-input');
        const defaultName = lotNameInput.length ? 
                            (lotNameInput.data('default-name') || `Lot ${surveyLotsStore[activeLotId].num}`) : 
                            `Lot ${surveyLotsStore[activeLotId].num}`;
        
        let lotName = lotNameInput.length ? (lotNameInput.val() || defaultName) : defaultName;
        lotName = lotName.trim();
        if (lotName === "") {
            lotName = defaultName;
        }

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
                const deg = parseInt(degVal, 10);
                const min = parseInt(minVal, 10);
                const dist = parseFloat(distVal);
                if (!isNaN(deg) && deg >= 0 && deg <= 89 && 
                    !isNaN(min) && min >= 0 && min <= 59 && 
                    !isNaN(dist) && dist > 0) {
                    dataLines.push(formatDataLine(ns, deg, min, ew, dist)); // Reverted call
                }
            }
        });
        surveyLotsStore[activeLotId].lines_text = dataLines.join('\n');
        
        hasUnsavedChanges = true; 
        updateActiveSaveStatusDisplay(); 

        if (activeLotId) {
            // Autosave the current state (default or named context) after persisting UI changes.
            saveCurrentSurvey(window.currentLoadedSaveName || undefined, false); // isSaveAs is false for autosaves
        }
    }

    // Saves the current state of the global surveyLotsStore to localStorage.
    function saveCurrentSurvey(name, isSaveAs = false) {
        // DO NOT call persistActiveLotData() here to prevent recursion.
        // surveyLotsStore is assumed to be up-to-date by the caller.

        let targetSaveName;
        if (name === null || name === undefined) {
            targetSaveName = window.currentLoadedSaveName || EXPLICIT_DEFAULT_SAVE_NAME;
        } else {
            targetSaveName = name;
        }

        const specificSaveKey = `surveyLotsStore_data_${targetSaveName}`;
        let namedSavesIndex = safeLocalStorageGetJson(NAMED_SAVES_INDEX_KEY, {});

        // Handle 'Save As' confirmation
        if (isSaveAs && (safeLocalStorageGet(specificSaveKey) !== null || namedSavesIndex[targetSaveName])) {
            if (!confirm(`A survey named "${targetSaveName}" already exists. Overwrite it?`)) {
                displayMessage('info', `Save As for "${targetSaveName}" cancelled.`);
                // If dropdown was manipulated by prompt, ensure it reflects current state
                if (window.currentLoadedSaveName) {
                    populateNamedSavesDropdown(); // Reselects current or re-populates
                } else {
                     $('#savedSurveysDropdown').val(''); // Reset dropdown if no current save name
                }
                return;
            }
        }

        let overallSaveSuccess = true;

        // Save to the target specific key
        if (!safeLocalStorageSet(specificSaveKey, JSON.stringify(surveyLotsStore))) {
            overallSaveSuccess = false;
        }

        // Update named saves index
        // Ensure even EXPLICIT_DEFAULT_SAVE_NAME is in the index if it's the target
        namedSavesIndex[targetSaveName] = true;
        if (!safeLocalStorageSet(NAMED_SAVES_INDEX_KEY, JSON.stringify(namedSavesIndex))) {
            overallSaveSuccess = false;
        }

        // Always update the DEFAULT_SAVE_KEY as a backup
        if (!safeLocalStorageSet(DEFAULT_SAVE_KEY, JSON.stringify(surveyLotsStore))) {
            overallSaveSuccess = false;
        }

        if (overallSaveSuccess) {
            window.currentLoadedSaveName = targetSaveName; // Update current loaded save name
            hasUnsavedChanges = false;

            if (isSaveAs) {
                displayMessage('success', `Survey saved as "${targetSaveName}".`);
            } else {
                if (targetSaveName === EXPLICIT_DEFAULT_SAVE_NAME) {
                    displayMessage('success', `Default survey updated.`);
                } else {
                    displayMessage('success', `Survey "${targetSaveName}" updated.`);
                }
            }
        } else {
            displayMessage('error', `Failed to fully save survey "${targetSaveName}". Check console for details.`);
        }

        populateNamedSavesDropdown(); // Refresh dropdown
        updateActiveSaveStatusDisplay(); // Update display
    }

    function populateNamedSavesDropdown() {
        const dropdown = $('#savedSurveysDropdown');
        const currentlySelected = dropdown.val(); 
        dropdown.empty().append('<option value="" disabled selected>Select a survey...</option>'); 

        const namedSavesIndex = safeLocalStorageGetJson(NAMED_SAVES_INDEX_KEY, {});
        const names = Object.keys(namedSavesIndex);
        if (names.length === 0) {
                dropdown.append('<option value="" disabled>No saved surveys yet.</option>');
            } else {
                names.sort().forEach(name => {
                    dropdown.append($('<option>', {
                        value: name,
                        text: name
                    }));
                });
            }
            // Try to reselect previous value, or set to current loaded if available
            if (window.currentLoadedSaveName && names.includes(window.currentLoadedSaveName)) {
                 dropdown.val(window.currentLoadedSaveName);
            } else if (currentlySelected && names.includes(currentlySelected)) {
                dropdown.val(currentlySelected);
            } else {
                dropdown.val(""); // Default to placeholder
            }
        // Error messages are handled by safeLocalStorageGetJson if issues occur during its execution.
        // The orphaned catch block that was here has been removed.
        // Trigger change to update button states if needed
        dropdown.trigger('change');
    }

    function deleteSurvey(name) {
        if (!name) {
            displayMessage('error', 'No survey name provided for deletion.');
            return;
        }

        safeLocalStorageRemove(`surveyLotsStore_data_${name}`);
        let namedSavesIndex = safeLocalStorageGetJson(NAMED_SAVES_INDEX_KEY, {});
        if (namedSavesIndex && namedSavesIndex[name]) { // Check if index and name exist before delete
            delete namedSavesIndex[name];
            safeLocalStorageSet(NAMED_SAVES_INDEX_KEY, JSON.stringify(namedSavesIndex));
        }
        populateNamedSavesDropdown(); // Refresh the dropdown first

        if (window.currentLoadedSaveName === name) {
            window.currentLoadedSaveName = null; // Clear the active save name
            displayMessage('info', `Deleted active survey "${name}". Loading next available survey...`);
            loadSurvey(); // Call with no arguments to trigger default loading logic
                           // This will also call updateActiveSaveStatusDisplay()
        } else {
            displayMessage('success', `Survey "${name}" deleted successfully.`);
            // updateActiveSaveStatusDisplay() is not needed here as the active survey hasn't changed.
        }
        // No specific catch here as safe utils handle their errors.
    }

    // --- LOT MANAGEMENT UI (MASTER-DETAIL) ---

    function loadSurvey(name) {
        let surveyDataToLoad = null;
        let sourceDescription = '';
        let loadedNameForGlobal = null; // Used to set window.currentLoadedSaveName at the end

        if (name === null || name === undefined) { // Initial page load or explicit load of default context
            // Try loading from EXPLICIT_DEFAULT_SAVE_NAME first
            surveyDataToLoad = safeLocalStorageGetJson(`surveyLotsStore_data_${EXPLICIT_DEFAULT_SAVE_NAME}`);
            if (surveyDataToLoad) {
                sourceDescription = EXPLICIT_DEFAULT_SAVE_NAME;
                loadedNameForGlobal = EXPLICIT_DEFAULT_SAVE_NAME;
            } else {
                // Fallback to DEFAULT_SAVE_KEY (legacy default)
                surveyDataToLoad = safeLocalStorageGetJson(DEFAULT_SAVE_KEY);
                if (surveyDataToLoad) {
                    sourceDescription = 'Default Survey (legacy)';
                    loadedNameForGlobal = null; // Signifies old implicit default
                } else {
                    sourceDescription = 'New Survey'; // No data found in either default location
                    loadedNameForGlobal = null; // Will become EXPLICIT_DEFAULT_SAVE_NAME on first save
                }
            }
        } else { // Loading a specifically named survey (could be EXPLICIT_DEFAULT_SAVE_NAME from dropdown)
            sourceDescription = name; // Use the provided name for description
            surveyDataToLoad = safeLocalStorageGetJson(`surveyLotsStore_data_${name}`);
            if (surveyDataToLoad) {
                loadedNameForGlobal = name;
            } else {
                // Named survey not found, sourceDescription remains 'name' for error message
                loadedNameForGlobal = null;
            }
        }

        // Validate the loaded data (if any)
        if (surveyDataToLoad && !validateSurveyDataObject(surveyDataToLoad, sourceDescription)) {
            displayMessage('error', `Data for '${sourceDescription}' is invalid or corrupted and cannot be loaded.`);
            surveyDataToLoad = null; // Prevent use of corrupted data
            // Potentially offer to delete if 'name' was provided and it's corrupted
            if (name && name !== EXPLICIT_DEFAULT_SAVE_NAME && name !== DEFAULT_SAVE_KEY) {
                 if (confirm(`The named save '${name}' is corrupted. Would you like to remove it?`)) {
                     deleteSurvey(name); // This will also refresh dropdown and might load default
                     return; // Exit loadSurvey as deleteSurvey might trigger a new load
                 }
            }
            loadedNameForGlobal = null; // Reset as data is unusable
        }

        window.currentLoadedSaveName = loadedNameForGlobal; // Set global context based on successful load

        if (surveyDataToLoad) {
            surveyLotsStore = surveyDataToLoad;
            // Refresh UI - This is a critical part and needs to correctly reset and repopulate
            lotListUL.empty();
            activeLotEditorArea.html('<div class="active-lot-editor-container placeholder">Select a lot from the list or add a new one to start editing.</div>').addClass('placeholder');
            activeLotId = null;
            lotCounter = 0; // Reset counter, will be updated by re-adding lots

            let firstLotId = null;
            let maxLotNum = 0;

            if (Object.keys(surveyLotsStore).length > 0) {
                for (const lotId in surveyLotsStore) {
                    if (surveyLotsStore.hasOwnProperty(lotId)) {
                        const lotData = surveyLotsStore[lotId];
                        const lotNum = lotData.num || (parseInt(lotId.split('_')[1],10) || ++maxLotNum);
                        maxLotNum = Math.max(maxLotNum, lotNum);

                        const listItemHTML = `<li data-lot-id="${lotId}">` +
                                            `<span class="lot-name-display">${$('<div/>').text(lotData.name).html()}</span>` +
                                            `<button class="btn-remove-lot-list" title="Remove ${$('<div/>').text(lotData.name).html()}">×</button>` +
                                         `</li>`;
                        lotListUL.append(listItemHTML);
                        if (!firstLotId) firstLotId = lotId;

                        // Ensure feature groups are ready for plotting
                        if (map && !plottedFeatureGroups[lotId]) {
                            plottedFeatureGroups[lotId] = L.featureGroup().addTo(map);
                        } else if (map && plottedFeatureGroups[lotId]) {
                            plottedFeatureGroups[lotId].clearLayers(); // Clear existing layers if any
                        }
                    }
                }
                lotCounter = maxLotNum; // Set lotCounter to the highest existing lot number
                if (firstLotId) {
                    setActiveLot(firstLotId); // This will also render the editor
                }
            } else { // No lots in the loaded data, effectively a clear state or data was invalid
                surveyLotsStore = {}; // Ensure store is empty if data was invalid/null
                addLot(); // Add a fresh "Lot 1"
            }

            // Display message based on what was actually loaded or attempted
            if (name === null || name === undefined) { // Initial load attempt
                if (sourceDescription === EXPLICIT_DEFAULT_SAVE_NAME) {
                    displayMessage('success', `${EXPLICIT_DEFAULT_SAVE_NAME} loaded.`);
                } else if (sourceDescription === 'Default Survey (legacy)') {
                    displayMessage('info', `Legacy default survey loaded. Consider re-saving.`);
                } else {
                    // New survey, no message or a subtle "Welcome"
                }
            } else { // Attempt to load a specific name
                 displayMessage('success', `Survey "${sourceDescription}" loaded.`);
            }

        } else { // surveyDataToLoad is null (either not found or invalidated)
            surveyLotsStore = {}; // Clear data
            window.currentLoadedSaveName = null; // Ensure no named context if load failed

            lotListUL.empty();
            activeLotEditorArea.html('<div class="active-lot-editor-container placeholder">Select a lot or add a new one.</div>').addClass('placeholder');
            activeLotId = null;
            lotCounter = 0;

            if (name && name !== DEFAULT_SAVE_KEY && name !== EXPLICIT_DEFAULT_SAVE_NAME) { // Specific named survey not found and not due to corruption handled above
                displayMessage('error', `Could not find saved survey "${name}". Starting fresh.`);
            } else if ((name === null || name === undefined) && sourceDescription === 'New Survey') {
                 // This is a fresh start, no specific message needed beyond UI state.
                 // displayMessage('info', 'No default survey found. Starting fresh.');
            }
            addLot(); // Initialize with a fresh lot
        }

        populateNamedSavesDropdown(); // Refresh dropdown
        updateActiveSaveStatusDisplay(); // Update status display based on window.currentLoadedSaveName
        triggerMapUpdateWithDebounce(); // Update map
    }

    function clearAllLots() {
        if (!confirm('Are you sure you want to clear all lots? This will remove all entered data and cannot be undone.')) {
            return;
        }

        // Discard current unsaved edits in the active editor if any, then clear.
        surveyLotsStore = {};
        window.currentLoadedSaveName = null; // Reset active save context.
        
        lotListUL.empty(); 
        clearAllLotMapLayers(true); 
        lotCounter = 0; 
        activeLotId = null;
        activeLotEditorArea.html('<div class="active-lot-editor-container placeholder">All lots cleared. Add a new lot to begin.</div>').addClass('placeholder');
        activeLotEditorArea.removeClass('editor-minimized');
        
        saveCurrentSurvey(null, false); // Saves empty state, sets hasUnsavedChanges=false (if successful), updates display.
        
        addLot(); // Adds Lot 1, its saveCurrentSurvey call will set hasUnsavedChanges=false and update display.
        
        displayMessage('info', 'All lots have been cleared and a new Lot 1 started.');
        // Explicitly ensure it's false after the whole operation, as addLot's save is the last one.
        // saveCurrentSurvey within addLot should make hasUnsavedChanges false.
        // updateActiveSaveStatusDisplay() is called by the save operations within.
        hasUnsavedChanges = false; 
        updateActiveSaveStatusDisplay(); 
    }

    function addLot() {
        // Persist data of the currently active lot *before* adding a new one and changing activeLotId
        // setActiveLot (called below) handles persisting the *previously* active lot.
        // So, no explicit persistActiveLotData() needed here before creating new lot.

        lotCounter++;
        const newLotId = `lot_${lotCounter}`;
        const lotNum = lotCounter;
        const defaultLotName = `Lot ${lotNum}`;

        surveyLotsStore[newLotId] = { id: newLotId, name: defaultLotName, lines_text: "", num: lotNum };
        
        const listItemHTML = `<li data-lot-id="${newLotId}">` +
                                `<span class="lot-name-display">${defaultLotName}</span>` +
                                `<button class="btn-remove-lot-list" title="Remove ${defaultLotName}">×</button>` +
                             `</li>`;
        lotListUL.append(listItemHTML);

        if (map && !plottedFeatureGroups[newLotId]) {
            plottedFeatureGroups[newLotId] = L.featureGroup().addTo(map);
        }
        
        setActiveLot(newLotId); // This persists previous lot (if any), renders new one.
                               // persistActiveLotData (for prev lot) calls saveCurrentSurvey with isSaveAs=false.
                               // Then, we save the state *after* this new lot is added.
        saveCurrentSurvey(window.currentLoadedSaveName || undefined, false); // isSaveAs is false
        triggerMapUpdateWithDebounce(); // Plot the new empty lot.
    }

    function removeLot(lotIdToRemove) {
        if (!lotIdToRemove) {
            return;
        }

        // If the lot being removed is not the currently active one,
        // and there IS an active lot, persist the active lot's data first.
        if (activeLotId && activeLotId !== lotIdToRemove) {
            persistActiveLotData(); // This will also autosave current context.
        }
        // If the lot being removed IS the active one, its data in editor is lost.

        lotListUL.find(`li[data-lot-id="${lotIdToRemove}"]`).remove();
        delete surveyLotsStore[lotIdToRemove];

        if (plottedFeatureGroups[lotIdToRemove]) {
            if (map.hasLayer(plottedFeatureGroups[lotIdToRemove])) {
                map.removeLayer(plottedFeatureGroups[lotIdToRemove]);
            }
            delete plottedFeatureGroups[lotIdToRemove];
        }

        if (activeLotId === lotIdToRemove) {
            activeLotId = null;
            activeLotEditorArea.html('<div class="active-lot-editor-container placeholder">Select a lot from the list or add a new one.</div>').addClass('placeholder');
            activeLotEditorArea.removeClass('editor-minimized');
            
            const firstRemainingLot = lotListUL.find('li:first-child').data('lot-id');
            if (firstRemainingLot) {
                setActiveLot(firstRemainingLot); // This will persist old (null), render new, and its persist will save.
            }
            // If no lots remain, activeLotId is null, editor is placeholder.
        }
        
        // Save the state after removal and potential change of active lot.
        saveCurrentSurvey(window.currentLoadedSaveName || undefined, false); // isSaveAs is false
        triggerMapUpdateWithDebounce(); // Update map display.
    }

    function setActiveLot(lotIdToActivate) {
        if (!lotIdToActivate || !surveyLotsStore[lotIdToActivate]) {
            activeLotEditorArea.html('<div class="active-lot-editor-container placeholder">Lot data not found. Please add or select another lot.</div>').addClass('placeholder');
            activeLotEditorArea.removeClass('editor-minimized');
            activeLotId = null;
            // Auto-select first lot if current selection becomes invalid
            if (lotListUL.find('li.active').length === 0 && lotListUL.find('li').length > 0) {
                const firstLotId = lotListUL.find('li:first-child').data('lot-id');
                if (firstLotId && surveyLotsStore[firstLotId]) { // Check if first lot is valid before activating
                    lotIdToActivate = firstLotId;
                } else {
                    return; // No valid lot to activate
                }
            } else if (!lotListUL.find('li').length || !lotIdToActivate || !surveyLotsStore[lotIdToActivate]) {
                 return; // No lots or invalid target lotId
            }
        }

        if (activeLotId === lotIdToActivate && !activeLotEditorArea.hasClass('placeholder')) {
            return; // Already active and editor is visible
        }

        persistActiveLotData(); // Persist data of the *previously* active lot

        activeLotId = lotIdToActivate;
        lotListUL.find('li').removeClass('active');
        lotListUL.find(`li[data-lot-id="${activeLotId}"]`).addClass('active');

        renderActiveLotEditor();
    }

    function renderActiveLotEditor() {
        if (!activeLotId || !surveyLotsStore[activeLotId]) {
            activeLotEditorArea.html('<div class="active-lot-editor-container placeholder">Select a lot or add a new one to begin.</div>').addClass('placeholder');
            activeLotEditorArea.removeClass('editor-minimized');
            return;
        }

        activeLotEditorArea.removeClass('placeholder').empty();
        const lotData = surveyLotsStore[activeLotId];
        const sanitizedLotName = $('<div/>').text(lotData.name).html(); // Sanitize name for display
        const buttonTextContent = `Add Point to ${sanitizedLotName}`;

        const editorHtml = `
            <div class="lot-editor-header">
                <button type="button" class="btn-toggle-editor" title="Minimize Editor">－</button>
                <label for="${activeLotId}_name_editor">Lot:</label> 
                <input type="text" id="${activeLotId}_name_editor" class="lot-name-input" value="${sanitizedLotName}" data-default-name="Lot ${lotData.num}">
            </div>
            <div class="survey-point-editor">
                <h3>Survey Data Points for "<span class="dynamic-lot-name-header">${sanitizedLotName}</span>"</h3>
                <div class="survey-point-table-content">
                    <div class="point-headers">
                        <span class="header-label">Line</span>
                        <span class="header-ns">N/S</span>
                        <span class="header-deg">Deg</span>
                        <span class="header-min">Min</span>
                        <span class="header-ew">E/W</span>
                        <span class="header-dist">Dist (m)</span>
                        <span class="header-action"></span>
                    </div>
                    <div class="surveyPointsListContainer"></div>
                </div>
            </div>
            <div class="misclosure-display-section">
                <h4>Lot Misclosure</h4>
                <p><strong>Distance:</strong> <span id="misclosureDistanceDisplay">-</span></p>
                <p><strong>Bearing:</strong> <span id="misclosureBearingDisplay">-</span></p>
            </div>
            <div class="area-display-section">
                <h4>Lot Area</h4>
                <p><strong>Square meters:</strong> <span id="areaSqmDisplay">-</span></p>
                <p><strong>Hectares:</strong> <span id="areaHectaresDisplay">-</span></p>
            </div>
            <button type="button" class="btn btn-primary btn-add-point-to-lot">${buttonTextContent}</button>
        `;
        activeLotEditorArea.html(editorHtml);

        // Populate misclosure data
        if (lotData && lotData.misclosure) {
            $('#misclosureDistanceDisplay').text(lotData.misclosure.distance || '-');
            $('#misclosureBearingDisplay').text(lotData.misclosure.bearing || '-');
        } else {
            $('#misclosureDistanceDisplay').text('-');
            $('#misclosureBearingDisplay').text('-');
        }

        // Populate area data (simplified)
        if (lotData && lotData.areas) {
            $('#areaSqmDisplay').text(lotData.areas.sqm || '-');
            $('#areaHectaresDisplay').text(lotData.areas.hectares || '-');
        } else {
            $('#areaSqmDisplay').text('-');
            $('#areaHectaresDisplay').text('-');
        }

        if (isEditorMinimized) {
            activeLotEditorArea.addClass('editor-minimized');
            activeLotEditorArea.find('.btn-toggle-editor').text('＋').attr('title', 'Maximize Editor');
        } else {
            activeLotEditorArea.removeClass('editor-minimized');
            activeLotEditorArea.find('.btn-toggle-editor').text('－').attr('title', 'Minimize Editor');
        }

        const nameInput = activeLotEditorArea.find('.lot-name-input');
        nameInput.on('input', function () {
            const currentName = $(this).val().trim();
            const defaultName = $(this).data('default-name');
            const displayedName = currentName || defaultName;
            activeLotEditorArea.find('.dynamic-lot-name-header').text(displayedName);
            activeLotEditorArea.find('.btn-add-point-to-lot').text(`Add Point to ${displayedName}`);
            hasUnsavedChanges = true;
            updateActiveSaveStatusDisplay();
        });

        const surveyPointsListContainer = activeLotEditorArea.find('.surveyPointsListContainer');
        const lines = lotData.lines_text.split('\n').filter(line => line.trim() !== '');
        if (lines.length > 0) {
            lines.forEach(line => {
                const parts = line.split(';');
                const bearingDistance = (parts.length >= 2) ? [parts[0], parts[1]] : null;
                if (bearingDistance) {
                    addSurveyPointRowToActiveEditor(surveyPointsListContainer, bearingDistance);
                }
            });
        } else {
            addSurveyPointRowToActiveEditor(surveyPointsListContainer, null); // Add one empty row if no lines
        }
    }

    // --- SURVEY POINT ROW MANAGEMENT ---

    function addSurveyPointRowToActiveEditor(surveyPointsListContainer, data = null) {
        if (!activeLotId) {
            return;
        }
        const lotSpecificPointIndex = surveyPointsListContainer.children().length + 1;
        let nsVal = 'N', degVal = '', minVal = '', ewVal = 'E', distVal = '';

        if (data && data[0] && typeof data[1] !== 'undefined') { // data[1] (distance) can be "0"
            const bearingParts = parseBearing(data[0]);
            if (bearingParts) {
                nsVal = bearingParts.ns;
                degVal = bearingParts.deg;
                minVal = bearingParts.min;
                ewVal = bearingParts.ew;
            }
            distVal = parseFloat(data[1]).toFixed(2);
        }

        const inputNamePrefix = `${activeLotId}_line${lotSpecificPointIndex}`;
        const newRowHtml = `
            <div class="survey-point-row" data-row-index="${lotSpecificPointIndex}">
                <span class="point-label">Line ${lotSpecificPointIndex}</span>
                <select class="point-input point-ns" name="${inputNamePrefix}_ns">
                    <option value="N" ${nsVal === 'N' ? 'selected' : ''}>N</option>
                    <option value="S" ${nsVal === 'S' ? 'selected' : ''}>S</option>
                </select>
                <input type="number" class="point-input point-deg" min="0" max="89" placeholder="Deg" value="${degVal}" name="${inputNamePrefix}_deg">
                <input type="number" class="point-input point-min" min="0" max="59" placeholder="Min" value="${minVal}" name="${inputNamePrefix}_min">
                <select class="point-input point-ew" name="${inputNamePrefix}_ew">
                    <option value="E" ${ewVal === 'E' ? 'selected' : ''}>E</option>
                    <option value="W" ${ewVal === 'W' ? 'selected' : ''}>W</option>
                </select>
                <input type="number" class="point-input point-dist" step="0.01" min="0.01" placeholder="Dist (m)" value="${distVal}" name="${inputNamePrefix}_dist">
                <div class="btn-remove-point-container">
                    <button type="button" class="btn-remove-point" title="Remove this point">×</button>
                </div>
            </div>`;
        surveyPointsListContainer.append(newRowHtml);
        updateRowLabelsForActiveEditor(surveyPointsListContainer);
        hasUnsavedChanges = true;
        updateActiveSaveStatusDisplay();
    }

    function updateRowLabelsForActiveEditor(surveyPointsListContainer) {
        if (!activeLotId) {
            return;
        }
        surveyPointsListContainer.children('.survey-point-row').each(function (index) {
            const pointRow = $(this);
            const newIndex = index + 1;
            pointRow.find('.point-label').text(`Line ${newIndex}`);
            pointRow.attr('data-row-index', newIndex);
            
            const inputNamePrefix = `${activeLotId}_line${newIndex}`;
            pointRow.find('.point-ns').attr('name', `${inputNamePrefix}_ns`);
            pointRow.find('.point-deg').attr('name', `${inputNamePrefix}_deg`);
            pointRow.find('.point-min').attr('name', `${inputNamePrefix}_min`);
            pointRow.find('.point-ew').attr('name', `${inputNamePrefix}_ew`);
            pointRow.find('.point-dist').attr('name', `${inputNamePrefix}_dist`);
        });
    }

    function parseBearing(bearingStr) {
        const match = bearingStr.match(/([NS])\s*(\d+)D\s*(\d+)['′]\s*([EW])/i);
        if (match) {
            return {
                ns: match[1].toUpperCase(),
                deg: parseInt(match[2], 10),
                min: parseInt(match[3], 10),
                ew: match[4].toUpperCase()
            };
        }
        return null;
    }

    // --- EVENT HANDLERS ---

    $('#addLotBtnSidebar').on('click', addLot);
    $('#clearAllLotsBtn').on('click', clearAllLots);

    lotListUL.on('click', 'li', function () {
        setActiveLot($(this).data('lot-id'));
    });

    lotListUL.on('click', '.btn-remove-lot-list', function (e) {
        e.stopPropagation(); // Prevent li click event from firing
        if (confirm('Are you sure you want to remove this lot? All its data will be lost.')) {
            removeLot($(this).closest('li').data('lot-id'));
        }
    });

    $('#importSurveyDataBtn').on('click', function() {
        $('#importSurveyFile').click(); // Trigger hidden file input
    });

    $('#importSurveyFile').on('change', function(event) {
        const file = event.target.files[0];
        if (!file) {
            return; // No file selected
        }

        const reader = new FileReader();

        reader.onload = (e) => {
            let importedData;
            try {
                importedData = JSON.parse(e.target.result);
            } catch (err) {
                displayMessage('error', 'Invalid file format: Not a valid JSON file.');
                $(this).val(null); // Reset file input
                return;
            }

            // Basic validation of the imported data structure
            if (typeof importedData !== 'object' || importedData === null) {
                displayMessage('error', 'Invalid data structure: Expected an object.');
                $(this).val(null);
                return;
            }

            let maxLotNumFromFile = 0;
            
            if (!validateSurveyDataObject(importedData, 'imported file')) {
                displayMessage('error', 'Imported file contains invalid or corrupted survey data. Cannot import.');
                $(this).val(null); // Reset file input
                return;
            }
            
            // Ask user how to import
            const importChoice = confirm("Choose import mode:\n\n" +  // Message updated for clarity
                                     "OK = Overwrite Current Survey (unsaved changes will be lost)\n" +
                                     "Cancel = Import as New Named Save");

            if (importChoice) { // User chose "Overwrite Current Survey"
                // Second confirmation specifically for overwriting default
                if (!confirm("Are you sure you want to overwrite your current default survey data? This action cannot be undone.")) {
                    displayMessage('info', 'Import operation to overwrite default cancelled.');
                    $(this).val(null); // Reset file input
                    return; // Abort the import
                }

                surveyLotsStore = importedData; // Replace in-memory store
                window.currentLoadedSaveName = null; // Clear active named save context
                saveCurrentSurvey(null, false); // Save imported data to default, not a "Save As"
                                     // updateActiveSaveStatusDisplay is called within saveCurrentSurvey
                displayMessage('success', 'Survey data imported and replaced current survey (saved to default).');

            } else { // User chose "Import as New Named Save"
                const newSaveName = prompt("Enter a name for the new imported survey save:");
                if (newSaveName && newSaveName.trim() !== "") {
                    surveyLotsStore = importedData; // Replace in-memory store
                    // saveCurrentSurvey with a name and isSaveAs=true will handle potential overwrite of existing named save
                    // and will set window.currentLoadedSaveName
                    saveCurrentSurvey(newSaveName.trim(), true); 
                    // displayMessage is handled by saveCurrentSurvey
                } else {
                    displayMessage('info', 'Import as new save cancelled or no name provided.');
                    $(this).val(null); // Reset file input
                    return;
                }
            }

            // Common UI Refresh logic after import choice processed
            lotListUL.empty();
            activeLotEditorArea.html('<div class="active-lot-editor-container placeholder">Select a lot or add a new one.</div>').addClass('placeholder');
            activeLotId = null;
            lotCounter = 0; // Reset counter

            let firstLotId = null;
            // Update lotCounter based on max 'num' from imported data
            // This was already done by maxLotNumFromFile, so lotCounter can be set to it.
            lotCounter = maxLotNumFromFile;


            if (Object.keys(surveyLotsStore).length > 0) {
                for (const lotId in surveyLotsStore) {
                    if (surveyLotsStore.hasOwnProperty(lotId)) {
                        const lotData = surveyLotsStore[lotId];
                        // Ensure 'num' exists, fallback if necessary (though validation should catch this)
                        lotData.num = lotData.num || (parseInt(lotId.split('_')[1], 10) || (lotCounter + 1));
                        lotCounter = Math.max(lotCounter, lotData.num);


                        const listItemHTML = `<li data-lot-id="${lotId}">` +
                                            `<span class="lot-name-display">${$('<div/>').text(lotData.name).html()}</span>` +
                                            `<button class="btn-remove-lot-list" title="Remove ${$('<div/>').text(lotData.name).html()}">×</button>` +
                                         `</li>`;
                        lotListUL.append(listItemHTML);
                        if (!firstLotId) firstLotId = lotId;

                        if (map && !plottedFeatureGroups[lotId]) {
                            plottedFeatureGroups[lotId] = L.featureGroup().addTo(map);
                        } else if (map && plottedFeatureGroups[lotId]) {
                            plottedFeatureGroups[lotId].clearLayers();
                        }
                    }
                }
                if (firstLotId) {
                    setActiveLot(firstLotId);
                }
            } else { // No lots in imported data
                addLot(); // Add a fresh "Lot 1"
            }
            
            populateNamedSavesDropdown(); // Refresh dropdown
            triggerMapUpdateWithDebounce(); // Update map

            $(this).val(null); // Reset file input
        };

        reader.onerror = () => {
            displayMessage('error', 'Error reading file.');
            $(this).val(null); // Reset file input
        };

        reader.readAsText(file);
    });

    $('#exportSurveyDataBtn').on('click', function() {
        persistActiveLotData(); // Ensure current lot data is saved to surveyLotsStore

        if (Object.keys(surveyLotsStore).length === 0) {
            displayMessage('info', 'No survey data to export.');
            return;
        }

        let hasMeaningfulData = false;
        for (const lotId in surveyLotsStore) {
            if (surveyLotsStore.hasOwnProperty(lotId)) {
                const lot = surveyLotsStore[lotId];
                // A lot has meaningful data if it has lines or its name has been changed from the default
                if ((lot.lines_text && lot.lines_text.trim() !== "") ||
                    (lot.name && lot.name.trim() !== `Lot ${lot.num}`)) {
                    hasMeaningfulData = true;
                    break;
                }
            }
        }

        if (!hasMeaningfulData) {
            displayMessage('info', 'No actual survey data to export. Add lines to lots or change their default names.');
            return;
        }

        try {
            const surveyDataJson = JSON.stringify(surveyLotsStore, null, 2);
            const blob = new Blob([surveyDataJson], { type: 'application/json' });
            // Assuming triggerDownload exists and is suitable:
            // triggerDownload(blob, 'survey_data.llph', 'Survey data file'); 
            // Let's define a local version for clarity or use the global one if confirmed it's perfectly suitable.
            // The global triggerDownload is designed for fetch responses. This is simpler.

            const filename = 'survey_data.llph';
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
            displayMessage('success', `Survey data exported as '${filename}'.`);

        } catch (error) {
            console.error('Error exporting survey data:', error);
            displayMessage('error', 'Could not export survey data.');
        }
    });

    activeLotEditorArea.on('click', '.btn-toggle-editor', function () {
        isEditorMinimized = !isEditorMinimized;
        const editor = $(this).closest('.active-lot-editor-container');
        const button = $(this);

        if (isEditorMinimized) {
            editor.addClass('editor-minimized');
            button.text('＋').attr('title', 'Maximize Editor');
        } else {
            editor.removeClass('editor-minimized');
            button.text('－').attr('title', 'Minimize Editor');
        }

        if (map) {
            setTimeout(() => {
                map.invalidateSize();
            }, 350); // Match CSS transition duration + a bit
        }
    });

    activeLotEditorArea.on('click', '.btn-add-point-to-lot', function () {
        const surveyPointsListContainer = activeLotEditorArea.find('.surveyPointsListContainer');
        addSurveyPointRowToActiveEditor(surveyPointsListContainer, null);
        triggerMapUpdateWithDebounce();
    });

    activeLotEditorArea.on('click', '.btn-remove-point', function () {
        const pointRow = $(this).closest('.survey-point-row');
        const surveyPointsListContainer = pointRow.parent();
        pointRow.remove();
        updateRowLabelsForActiveEditor(surveyPointsListContainer); // Renumber remaining rows
        hasUnsavedChanges = true;
        updateActiveSaveStatusDisplay();
        triggerMapUpdateWithDebounce();
    });

    activeLotEditorArea.on('input change', '.point-input, .lot-name-input', function () {
        triggerMapUpdateWithDebounce();
    });

    // --- MESSAGING, VALIDATION, PAYLOAD, SERVER CALLS ---

    function showLoading(message = "Processing...") {
        // Clear any existing timer to prevent multiple overlays or premature showing
        if (loadingOverlayTimerId) {
            clearTimeout(loadingOverlayTimerId);
        }

        // Set a new timer to show the overlay after a delay
        loadingOverlayTimerId = setTimeout(() => {
            const overlay = $('#loadingOverlay');
            const messageElement = $('#loadingMessage');
            
            if (messageElement.length && overlay.length) { // Ensure elements exist
                messageElement.text(message);
                overlay.css('display', 'flex'); // Show the overlay
            }
            loadingOverlayTimerId = null; // Clear the timer ID once the overlay is shown
        }, LOADING_OVERLAY_DELAY);
    }

    function hideLoading() {
        // If there's a pending timer to show the overlay, clear it
        if (loadingOverlayTimerId) {
            clearTimeout(loadingOverlayTimerId);
            loadingOverlayTimerId = null;
        }
        
        // Hide the overlay element itself
        const overlay = $('#loadingOverlay');
        if (overlay.length) { // Ensure element exists
            overlay.css('display', 'none');
        }
    }

    function displayMessage(type, message) {
        if (messageFadeTimeoutId) {
            clearTimeout(messageFadeTimeoutId);
        }
        formMessagesArea.empty(); // Clear previous message content

        const messageDiv = $(`<div class="message ${type}">${message}</div>`);
        formMessagesArea.append(messageDiv);

        messageFadeTimeoutId = setTimeout(function () {
            messageDiv.fadeOut(500, function () {
                $(this).remove();
            });
            messageFadeTimeoutId = null;
        }, 5000); // Message disappears after 5 seconds
    }

    function clearMessages() {
        if (messageFadeTimeoutId) {
            clearTimeout(messageFadeTimeoutId);
            messageFadeTimeoutId = null;
        }
        formMessagesArea.empty();
    }

    function validateSurveyInputs(showAlerts = true, eventTargetId = null) {
        let formIsValid = true;
        if ($('#target_crs_select').val() === "") {
            if (showAlerts) {
                displayMessage('error', "CRS not selected.");
            }
            formIsValid = false;
        }

        const lotsForPayload = getLotsForPayload();
        if ($('#reference_point_select').val() === "" && 
            lotsForPayload.length > 0 && 
            lotsForPayload.some(l => l.lines_text.trim() !== "")) {
            if (showAlerts) {
                displayMessage('error', "Please select a Reference Point when lot data exists.");
            }
            formIsValid = false;
        }

        let specificErrorMessage = null; // Used to store the first specific error found

        // Using a traditional for loop to allow breaking out of it
        const lotIds = Object.keys(surveyLotsStore);
        for (let i = 0; i < lotIds.length; i++) {
            const lotId = lotIds[i];
            const lot = surveyLotsStore[lotId];
            const lines = lot.lines_text.split('\n').filter(l => l.trim() !== '');

            if (lines.length > 0) {
                for (let j = 0; j < lines.length; j++) {
                    const line = lines[j];
                    const lineNum = j + 1;
                    const parts = line.split(';');

                    if (parts.length < 2) {
                        specificErrorMessage = `Lot "${lot.name}", Line ${lineNum}: Incomplete line data. Expected bearing and distance.`;
                        formIsValid = false;
                        break; // Exit lines loop for this lot
                    }

                    const bearingData = parseBearing(parts[0]);
                    const distStr = parts[1].trim(); // Get the distance string for detailed error reporting
                    const dist = parseFloat(distStr);

                    if (!bearingData) {
                        specificErrorMessage = `Lot "${lot.name}", Line ${lineNum}: Invalid bearing format.`;
                        formIsValid = false;
                        break; 
                    }
                    
                    // Validate Degrees
                    if (typeof bearingData.deg !== 'number' || !Number.isInteger(bearingData.deg) || bearingData.deg < 0 || bearingData.deg > 89) {
                        specificErrorMessage = `Lot "${lot.name}", Line ${lineNum}: Degrees must be an integer between 0 and 89. Found: '${bearingData.deg}'.`;
                        formIsValid = false;
                        break;
                    }

                    // Validate Minutes
                    if (typeof bearingData.min !== 'number' || !Number.isInteger(bearingData.min) || bearingData.min < 0 || bearingData.min > 59) {
                        specificErrorMessage = `Lot "${lot.name}", Line ${lineNum}: Minutes must be an integer between 0 and 59. Found: '${bearingData.min}'.`;
                        formIsValid = false;
                        break;
                    }
                    
                    // Validate Distance
                    if (isNaN(dist) || dist <= 0) {
                        specificErrorMessage = `Lot "${lot.name}", Line ${lineNum}: Distance must be a positive number. Found: '${distStr}'.`;
                        formIsValid = false;
                        break;
                    }
                }
            }
            if (!formIsValid) break; // Exit lots loop if an error was found in any lot
        }

        if (!formIsValid && specificErrorMessage && showAlerts) {
            displayMessage('error', specificErrorMessage);
        } else if (!formIsValid && showAlerts && !specificErrorMessage) {
            // This case handles general errors like missing CRS/Ref Point if no specific line error was set
            // displayMessage('error', "Please correct the highlighted errors."); // Or a more generic message
            // No change needed here if existing messages for CRS/Ref point are sufficient
        }
        
        const isExportAction = (targetId) => ['exportShapefileBtn', 'exportKmzBtn', 'exportDxfBtn', 'exportGeoJsonBtn'].includes(targetId);
        if (isExportAction(eventTargetId) && 
            lotsForPayload.filter(l => l.lines_text.trim() !== "").length === 0 && 
            !$('#reference_point_select').val()) {
            if (showAlerts) {
                displayMessage('error', "Cannot export: No reference point selected and no lot data with lines provided.");
            }
            formIsValid = false;
        } else if (isExportAction(eventTargetId) && 
                   lotsForPayload.filter(l => l.lines_text.trim() !== "").length === 0 && 
                   $('#reference_point_select').val()) {
            // This case might be acceptable for some formats if only ref point is exported
            if (showAlerts) {
                 displayMessage('info', "No lot data with lines. Export will only include the reference point if applicable for the chosen format.");
            }
        }
        return formIsValid;
    }

    function triggerMapUpdateWithDebounce() {
        clearTimeout(debounceTimeout);
        persistActiveLotData(); // Persist data before scheduling update
        debounceTimeout = setTimeout(() => {
            fetchAndPlotMapData();
        }, 700); // Debounce time of 700ms
    }

    function getLotsForPayload() {
        const payloadLots = [];
        for (const lotId in surveyLotsStore) {
            if (surveyLotsStore.hasOwnProperty(lotId)) {
                const lot = surveyLotsStore[lotId];
                // Include lot if it has lines, or if its name has changed from default, 
                // or if it's the only lot (even if empty, to allow plotting just a ref point with a named lot context)
                if (lot.lines_text.trim() !== "" || 
                    lot.name.trim() !== `Lot ${lot.num}` || 
                    Object.keys(surveyLotsStore).length === 1) {
                    payloadLots.push({ id: lot.id, name: lot.name, lines_text: lot.lines_text });
                }
            }
        }
        return payloadLots;
    }

    function getPayloadForServer() {
        persistActiveLotData(); // Ensure latest data is captured
        const payload = {
            target_crs_select: $('#target_crs_select').val(),
            reference_point_select: $('#reference_point_select').val(),
            lots: getLotsForPayload()
        };

        if (currentModifiedMainRefEN && currentModifiedMainRefEN.easting !== undefined && currentModifiedMainRefEN.northing !== undefined) {
            payload.main_ref_e = currentModifiedMainRefEN.easting;
            payload.main_ref_n = currentModifiedMainRefEN.northing;
            // If modified E/N are sent, the server should ideally ignore 'reference_point_select' for coordinates
            // or this client-side logic should ensure 'reference_point_select' is not used by the server
            // for coordinate lookup if these are provided. For now, we send both.
            // The backend currently uses selected_display_name to find the point details,
            // then extracts E/N from it. If main_ref_e/n are in payload, it should use them.
            // This needs coordination with backend logic if not already handled.
            // For this task, we just add them to the payload.
        }
        return payload;
    }

    function fetchAndPlotMapData() {
        clearMessages();
        if (!validateSurveyInputs(false, null)) { // Validate without showing alerts here, as it's for map update
            displayMessage('warning', "Map not updated due to invalid or incomplete inputs.");
            return;
        }

        const payload = getPayloadForServer();
        const hasLotsWithLines = payload.lots.some(l => l.lines_text.trim() !== "");

        // Avoid API call if there's nothing to plot or calculate
        if (!payload.reference_point_select && !hasLotsWithLines && payload.lots.length === 0) {
            clearAllLotMapLayers(true); // Clear map if no data
            return;
        }
        if (hasLotsWithLines && !payload.reference_point_select) {
            clearAllLotMapLayers(true); // Clear map
            displayMessage('error', "A reference point must be selected to plot lot data.");
            return;
        }

        // displayMessage('info', 'Updating map...'); // Replaced by showLoading
        showLoading('Updating map...');
        fetch('/calculate_plot_data_multi', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
        .then(response => response.json())
        .then(result => {
            clearMessages();
            if (result.status === 'success' || result.status === 'success_with_errors') {
                // Store misclosure data and then plot
                // Store misclosure and area data then plot
                (result.data_per_lot || []).forEach(lotResult => {
                    if (surveyLotsStore[lotResult.lot_id]) {
                        if (lotResult.misclosure) {
                            surveyLotsStore[lotResult.lot_id].misclosure = lotResult.misclosure;
                        }
                        if (lotResult.areas) { // Store area data
                            surveyLotsStore[lotResult.lot_id].areas = lotResult.areas;
                        }
                    }
                });

                plotMultiLotDataOnMap(result.data_per_lot, result.reference_plot_data);

                // Update misclosure display for the currently active lot
                if (activeLotId && surveyLotsStore[activeLotId] && surveyLotsStore[activeLotId].misclosure) {
                    $('#misclosureDistanceDisplay').text(surveyLotsStore[activeLotId].misclosure.distance || '-');
                    $('#misclosureBearingDisplay').text(surveyLotsStore[activeLotId].misclosure.bearing || '-');
                } else if (activeLotId) {
                    $('#misclosureDistanceDisplay').text('-');
                    $('#misclosureBearingDisplay').text('-');
                }

                // Update area display for the currently active lot
                if (activeLotId && surveyLotsStore[activeLotId] && surveyLotsStore[activeLotId].areas) {
                    $('#areaSqmDisplay').text(surveyLotsStore[activeLotId].areas.sqm || '-');
                    $('#areaHectaresDisplay').text(surveyLotsStore[activeLotId].areas.hectares || '-');
                } else if (activeLotId) { // Active lot might not have area if it had errors or no data to compute area
                    $('#areaSqmDisplay').text('-');
                    $('#areaHectaresDisplay').text('-');
                }
                
                if (result.status === 'success_with_errors') {
                    let errorMessages = ["Map updated. Some lots may have issues:"];
                    (result.data_per_lot || []).forEach(lr => { // lr is lotResult here
                        if (lr.status === 'error') {
                            errorMessages.push(`Lot '${lr.lot_name}': ${lr.message}`);
                        } else if (lr.status === 'nodata' && 
                                   payload.lots.find(l => l.id === lr.lot_id && l.lines_text.trim() !== "")) {
                            // Only show "no plottable geometry" if there were lines to begin with
                            errorMessages.push(`Lot '${lr.lot_name}': No plottable geometry from provided lines.`);
                        }
                    });
                    if (errorMessages.length > 1) {
                        displayMessage('warning', errorMessages.join('<br>'));
                    } else {
                        displayMessage('info', 'Map updated.'); // Or if only one lot and it was fine
                    }
                } else {
                    displayMessage('info', 'Map updated successfully.');
                }
            } else {
                displayMessage('error', 'Plotting Error: ' + (result.message || "Unknown server error."));
                clearAllLotMapLayers(true); // Clear map on plotting error
            }
        })
        .catch(error => {
            clearMessages();
            console.error('Plot Fetch Error:', error);
            displayMessage('error', 'Failed to update map. Check console or server logs.');
            clearAllLotMapLayers(true); // Clear map on fetch error
        })
        .finally(() => {
            hideLoading();
        });
    }

    function clearAllLotMapLayers(clearMainRef = false) {
        for (const lotId in plottedFeatureGroups) {
            if (plottedFeatureGroups[lotId] && map.hasLayer(plottedFeatureGroups[lotId])) {
                map.removeLayer(plottedFeatureGroups[lotId]);
            }
        }
        plottedFeatureGroups = {}; // Reset the store

        if (clearMainRef && mainReferenceMarker && map.hasLayer(mainReferenceMarker)) {
            map.removeLayer(mainReferenceMarker);
            mainReferenceMarker = null;
        }
    }

    const lotColors = ['#007bff', '#6f42c1', '#fd7e14', '#28a745', '#dc3545', '#17a2b8', '#ffc107', '#6c757d'];

    function plotMultiLotDataOnMap(dataPerLot, referencePlotData) {
        if (!map) {
            initMap(); // Should already be initialized, but as a fallback
        }
        clearAllLotMapLayers(false); // Clear previous lot layers but keep main ref if any

        const showTieLines = $('#toggleTieLines').is(':checked');
        const showPobMarkers = $('#togglePobMarkers').is(':checked');
        const showParcelVertices = $('#toggleParcelVertices').is(':checked');

        let allLatLngsForBounds = [];

        // Handle Main Reference Marker
        if (mainReferenceMarker && map.hasLayer(mainReferenceMarker)) {
            map.removeLayer(mainReferenceMarker);
            mainReferenceMarker = null;
        }
        if (referencePlotData && referencePlotData.reference_marker_latlng) {
            mainReferenceMarker = L.marker(
                referencePlotData.reference_marker_latlng, 
                { 
                    title: "Reference Point (Drag to modify)", // Updated title
                    draggable: true // Ensure marker is draggable
                }
            ).bindPopup("Reference Point (Drag to modify location)");
            
            mainReferenceMarker.on('dragend', function(event) {
                const newLatLng = event.target.getLatLng();
                const targetCrs = $('#target_crs_select').val();

                if (!targetCrs) {
                    displayMessage('error', 'Target CRS not selected. Cannot transform coordinates.');
                    // Optionally, revert marker position here if you store its original position
                    // For now, we leave it where the user dragged it.
                    return;
                }

                showLoading('Transforming reference point...');
                fetch('/api/transform_to_projected', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        latitude: newLatLng.lat,
                        longitude: newLatLng.lng,
                        target_crs_epsg: targetCrs
                    })
                })
                .then(response => response.json())
                .then(result => {
                    if (result.status === "success") {
                        currentModifiedMainRefEN = { easting: result.easting, northing: result.northing };
                        displayMessage('info', `Reference point E/N updated to: ${result.easting.toFixed(3)}, ${result.northing.toFixed(3)}. Recalculating lots...`);
                        // Clear the reference_point_select dropdown's text but not its value
                        // to indicate that the coordinates are now custom.
                        // This is tricky with select2. A visual cue might be better.
                        // For now, we rely on currentModifiedMainRefEN to override.
                        // $('#reference_point_select').val(null).trigger('change.select2'); // This would clear selection
                        fetchAndPlotMapData(); // This will use the new currentModifiedMainRefEN
                    } else {
                        currentModifiedMainRefEN = null;
                        displayMessage('error', `Failed to transform reference point: ${result.message}`);
                        // Optionally revert marker position
                        // event.target.setLatLng(originalLatLngBeforeDrag); // Needs originalLatLngBeforeDrag
                    }
                })
                .catch(error => {
                    currentModifiedMainRefEN = null;
                    console.error('Transform API Error:', error);
                    displayMessage('error', 'Failed to transform reference point coordinates due to a network or server error.');
                    // Optionally revert marker position
                })
                .finally(() => {
                    hideLoading();
                });
            });
            mainReferenceMarker.addTo(map);
            allLatLngsForBounds.push(referencePlotData.reference_marker_latlng);
        }

        (dataPerLot || []).forEach((lotResult, index) => {
            const lotId = lotResult.lot_id;
            const lotName = lotResult.lot_name;

            if (lotResult.status !== 'success') {
                // If a feature group for this errored lot exists, remove it
                if (plottedFeatureGroups[lotId] && map.hasLayer(plottedFeatureGroups[lotId])) {
                    map.removeLayer(plottedFeatureGroups[lotId]);
                    delete plottedFeatureGroups[lotId]; // Clean up
                }
                return; // Skip to next lot
            }

            const plotData = lotResult.plot_data;
            const color = lotColors[index % lotColors.length];

            if (!plottedFeatureGroups[lotId]) {
                plottedFeatureGroups[lotId] = L.featureGroup();
            } else {
                plottedFeatureGroups[lotId].clearLayers(); // Clear before adding new layers
            }
            let currentLotFeatureGroup = plottedFeatureGroups[lotId];

            let lotHasDrawableData = false;
            if (showTieLines && plotData.tie_line_latlngs && plotData.tie_line_latlngs.length > 0) {
                const tieLine = L.polyline(plotData.tie_line_latlngs, { 
                    color: '#e60000', dashArray: '6, 6', weight: 2.5, opacity: 0.8 
                }).bindPopup(`Tie-Line for ${lotName}`);
                currentLotFeatureGroup.addLayer(tieLine);
                plotData.tie_line_latlngs.forEach(p => allLatLngsForBounds.push(p));
                lotHasDrawableData = true;
            }

            if (plotData.parcel_polygon_latlngs && plotData.parcel_polygon_latlngs.length > 0) {
                let parcelPath = plotData.parcel_polygon_latlngs;
                const parcelPolyline = L.polyline(parcelPath, { 
                    color: color, weight: 3.5, opacity: 0.9 
                }).bindPopup(`Boundary: ${lotName}`);
                currentLotFeatureGroup.addLayer(parcelPolyline); // Parcel boundary line always shown
                parcelPath.forEach(p => allLatLngsForBounds.push(p));
                lotHasDrawableData = true;

                parcelPath.forEach((point, pIndex) => {
                    let label = (pIndex === 0) ? `POB: ${lotName}` : `Pt ${pIndex + 1}: ${lotName}`;
                    const isPobPoint = pIndex === 0;
                    const isClosingPoint = pIndex === parcelPath.length - 1 && pIndex > 0 &&
                                           parcelPath[0][0] === point[0] && parcelPath[0][1] === point[1];

                    if (isClosingPoint) {
                        // Skip if it's a closing point identical to POB, to avoid duplicate markers
                        // (especially if POB markers are on and vertex markers are off)
                    } else if (isPobPoint && showPobMarkers) {
                        const pobMarker = L.circleMarker(point, { 
                            radius: 5, // Slightly larger or different style for POB
                            color: color, 
                            weight: 1, 
                            fillColor: '#FFD700', // Gold color for POB
                            fillOpacity: 0.9, 
                            title: label 
                        }).bindPopup(label);
                        currentLotFeatureGroup.addLayer(pobMarker);
                    } else if (!isPobPoint && showParcelVertices) {
                        const vertexMarker = L.circleMarker(point, { 
                            radius: 4.5, 
                            color: color, 
                            weight: 1, 
                            fillColor: color, 
                            fillOpacity: 0.7, 
                            title: label 
                        }).bindPopup(label);
                        currentLotFeatureGroup.addLayer(vertexMarker);
                    }
                });
            }

            if (lotHasDrawableData && !map.hasLayer(currentLotFeatureGroup)) {
                currentLotFeatureGroup.addTo(map);
            } else if (!lotHasDrawableData && map.hasLayer(currentLotFeatureGroup)) {
                // Should not happen if status is 'success' and plotData is present, but defensive
                map.removeLayer(currentLotFeatureGroup);
            }
        });

        if (allLatLngsForBounds.length > 0) {
            map.fitBounds(L.latLngBounds(allLatLngsForBounds), { padding: [40, 40], maxZoom: 19 });
        } else if (mainReferenceMarker) {
            // If only a reference marker exists, center on it with a default zoom
            map.setView(mainReferenceMarker.getLatLng(), 17);
        }
    }

    function handleFileDownload(response, defaultFilename) {
        if (!response.ok) {
            return response.json().then(err => { 
                throw new Error(err.message || `Server error: ${response.status}`); 
            });
        }
        const disposition = response.headers.get('Content-Disposition');
        let filename = defaultFilename;
        if (disposition && disposition.indexOf('attachment') !== -1) {
            const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;
            const matches = filenameRegex.exec(disposition);
            if (matches != null && matches[1]) {
                filename = matches[1].replace(/['"]/g, '');
            }
        }
        return response.blob().then(blob => ({ blob, filename }));
    }

    function triggerDownload(blob, filename, successMessageBase) {
        clearMessages();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        displayMessage('info', `${successMessageBase} '${filename}' downloaded.`);
    }

    // Attach to parent for dynamically added elements if necessary,
    // but these export buttons are static.
    $('#exportShapefileBtn').on('click', function (e) {
        clearMessages();
        persistActiveLotData();
        if (!validateSurveyInputs(true, e.target.id)) { return; }
        
        const payload = getPayloadForServer();
        if (!payload.reference_point_select && payload.lots.filter(l => l.lines_text.trim() !== "").length === 0) {
            displayMessage('error', "Select Reference Point or add Lot Data for export.");
            return;
        }
        if (payload.lots.filter(l => l.lines_text.trim() !== "").length > 0 && !payload.reference_point_select) {
            displayMessage('error', "Reference Point must be selected to export lot data.");
            return;
        }
        
        // displayMessage('info', 'Preparing Shapefile export...'); // Replaced by showLoading
        showLoading('Preparing Shapefile export...');
        $('.btn-export').prop('disabled', true);
        fetch('/export_shapefile_multi', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
        .then(response => handleFileDownload(response, 'survey_export_multi.zip'))
        .then(({ blob, filename }) => { triggerDownload(blob, filename, 'Shapefile layers'); })
        .catch(error => {
            clearMessages();
            console.error('Shapefile Export Error:', error);
            displayMessage('error', 'Shapefile Export Failed: ' + error.message);
        })
        .finally(() => {
            hideLoading();
            $('.btn-export').prop('disabled', false);
        });
    });

    $('#exportKmzBtn').on('click', function (e) {
        clearMessages();
        persistActiveLotData();
        if (!validateSurveyInputs(true, e.target.id)) { return; }

        const payload = getPayloadForServer();
        if (!payload.reference_point_select && payload.lots.filter(l => l.lines_text.trim() !== "").length === 0) {
            displayMessage('error', "Select Reference Point or add Lot Data for export.");
            return;
        }
        if (payload.lots.filter(l => l.lines_text.trim() !== "").length > 0 && !payload.reference_point_select) {
            displayMessage('error', "Reference Point must be selected to export lot data.");
            return;
        }

        // displayMessage('info', 'Preparing KMZ export...'); // Replaced by showLoading
        showLoading('Preparing KMZ export...');
        $('.btn-export').prop('disabled', true);
        fetch('/export_kmz_multi', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
        .then(response => handleFileDownload(response, 'survey_export_multi.kmz'))
        .then(({ blob, filename }) => { triggerDownload(blob, filename, 'KMZ file'); })
        .catch(error => {
            clearMessages();
            console.error('KMZ Export Error:', error);
            displayMessage('error', 'KMZ Export Failed: ' + error.message);
        })
        .finally(() => {
            hideLoading();
            $('.btn-export').prop('disabled', false);
        });
    });

    $('#exportDxfBtn').on('click', function (e) {
        clearMessages();
        persistActiveLotData();
        if (!validateSurveyInputs(true, e.target.id)) { return; }

        const payload = getPayloadForServer();
        if (!payload.reference_point_select && payload.lots.filter(l => l.lines_text.trim() !== "").length === 0) {
            displayMessage('error', "Select Reference Point or add Lot Data for DXF export.");
            return;
        }
        if (payload.lots.filter(l => l.lines_text.trim() !== "").length > 0 && !payload.reference_point_select) {
            displayMessage('error', "Reference Point must be selected to export lot data to DXF.");
            return;
        }
        
        // displayMessage('info', 'Preparing DXF export...'); // Replaced by showLoading
        showLoading('Preparing DXF export...');
        $('.btn-export').prop('disabled', true);
        fetch('/export_dxf_multi', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
        .then(response => handleFileDownload(response, 'survey_export_multi.dxf'))
        .then(({ blob, filename }) => { triggerDownload(blob, filename, 'DXF file'); })
        .catch(error => {
            clearMessages();
            console.error('DXF Export Error:', error);
            displayMessage('error', 'DXF Export Failed: ' + error.message);
        })
        .finally(() => {
            hideLoading();
            $('.btn-export').prop('disabled', false);
        });
    });

    $('#exportGeoJsonBtn').on('click', function (e) {
        clearMessages();
        persistActiveLotData();
        if (!validateSurveyInputs(true, e.target.id)) { return; }

        const payload = getPayloadForServer();
        if (!payload.reference_point_select && payload.lots.filter(l => l.lines_text.trim() !== "").length === 0) {
            displayMessage('error', "Select Reference Point or add Lot Data for GeoJSON export.");
            return;
        }
        if (payload.lots.filter(l => l.lines_text.trim() !== "").length > 0 && !payload.reference_point_select) {
            displayMessage('error', "Reference Point must be selected to export lot data to GeoJSON.");
            return;
        }

        // displayMessage('info', 'Preparing GeoJSON export...'); // Replaced by showLoading
        showLoading('Preparing GeoJSON export...');
        $('.btn-export').prop('disabled', true);
        fetch('/export_geojson_multi', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
        .then(response => handleFileDownload(response, 'survey_export_multi.geojson'))
        .then(({ blob, filename }) => { triggerDownload(blob, filename, 'GeoJSON file'); })
        .catch(error => {
            clearMessages();
            console.error('GeoJSON Export Error:', error);
            displayMessage('error', 'GeoJSON Export Failed: ' + error.message);
        })
        .finally(() => {
            hideLoading();
            $('.btn-export').prop('disabled', false);
        });
    });

    // Initial setup

    // Event Handlers for Save/Load System
    $('#saveSurveyBtn').on('click', function() {
        // Persist data from active editor (if any) into surveyLotsStore, 
        // then save surveyLotsStore to localStorage (default or active named).
        // persistActiveLotData itself now calls saveCurrentSurvey.
        if (activeLotId) {
            persistActiveLotData(); // This itself calls saveCurrentSurvey(context, false)
        } else {
            // If no lot is active, there are no UI fields to persist.
            // Just save the current state of surveyLotsStore to the current context.
            saveCurrentSurvey(window.currentLoadedSaveName || undefined, false);
        }
        // displayMessage is handled by the saveCurrentSurvey call within persistActiveLotData or the direct call.
    });

    $('#saveAsSurveyBtn').on('click', function() {
        if (activeLotId) { // Persist data if a lot is active in editor
            persistActiveLotData(); // This autosaves to the *current* context (isSaveAs=false)
        }
        // surveyLotsStore is now up-to-date with any active editor changes.
        const name = prompt("Enter a name for this survey save (current survey will be saved under this new name):");
        if (name && name.trim() !== "") {
            saveCurrentSurvey(name.trim(), true); // Explicitly a "Save As" operation
        } else if (name !== null) { 
            displayMessage('warning', 'Save As name cannot be empty.');
        }
    });

    $('#savedSurveysDropdown').on('change', function() {
        const selectedName = $(this).val();
        if (selectedName) {
            $('#loadSelectedSurveyBtn').prop('disabled', false);
            $('#deleteSelectedSurveyBtn').prop('disabled', false);
        } else {
            $('#loadSelectedSurveyBtn').prop('disabled', true);
            $('#deleteSelectedSurveyBtn').prop('disabled', true);
        }
    });

    $('#loadSelectedSurveyBtn').on('click', function() {
        const selectedName = $('#savedSurveysDropdown').val();
        if (selectedName) {
            loadSurvey(selectedName);
        } else {
            displayMessage('warning', 'Please select a survey to load.');
        }
    });

    $('#deleteSelectedSurveyBtn').on('click', function() {
        const selectedName = $('#savedSurveysDropdown').val();
        if (selectedName) {
            if (confirm(`Are you sure you want to delete the survey "${selectedName}"? This cannot be undone.`)) {
                deleteSurvey(selectedName);
            }
        } else {
            displayMessage('warning', 'Please select a survey to delete.');
        }
    });

    // Initial population of dropdown and load default survey
    if (isLocalStorageAvailable) {
        populateNamedSavesDropdown(); 
        loadSurvey(); 
        updateActiveSaveStatusDisplay(); 
    } else {
        // If localStorage is not available, still need to init some basic app state
        // The UI elements that depend on localStorage are already disabled.
        // We still need to allow adding lots in-memory for the current session.
        surveyLotsStore = {};
        window.currentLoadedSaveName = null;
        activeLotId = null;
        lotCounter = 0;
        populateNamedSavesDropdown(); // Will show "no saves"
        updateActiveSaveStatusDisplay(); // Will show "Default Survey"
        addLot(); // Add a fresh "Lot 1" for in-memory use
        displayMessage('error', 'Warning: Browser storage is unavailable or disabled. Saving, loading, and survey preferences will not work. Please check your browser settings.', 0); // 0 for non-fading

        const UIElementsToDisable = [
            '#saveSurveyBtn', '#saveAsSurveyBtn', '#savedSurveysDropdown',
            '#loadSelectedSurveyBtn', '#deleteSelectedSurveyBtn',
            '#importSurveyDataBtn', '#importSurveyFile', 
            '#resetApplicationDataBtn',
            '#basemapSelect', 
            '#target_crs_select'
        ];
        UIElementsToDisable.forEach(selector => {
            $(selector).prop('disabled', true).css('opacity', 0.5).attr('title', 'Feature disabled: Browser storage unavailable.');
        });
    }


    $('#resetApplicationDataBtn').on('click', function() {
        if (!isLocalStorageAvailable) {
            displayMessage('error', 'Browser storage is unavailable. Reset is not applicable.');
            return;
        }
        if (!confirm("WARNING: This will delete ALL survey data, including all named saves and the default survey, from your browser's storage. This action cannot be undone. Are you absolutely sure you want to proceed?")) {
            return; 
        }

        // Delete individual named saves
        const namedSavesIndex = safeLocalStorageGetJson(NAMED_SAVES_INDEX_KEY, {});
        for (const name in namedSavesIndex) {
            if (namedSavesIndex.hasOwnProperty(name)) {
                safeLocalStorageRemove(`surveyLotsStore_data_${name}`);
            }
        }

        // Delete the index itself
        safeLocalStorageRemove(NAMED_SAVES_INDEX_KEY);
        
        // Delete the default save
        safeLocalStorageRemove(DEFAULT_SAVE_KEY);

        // Delete other app-specific settings
        safeLocalStorageRemove('selectedBasemap');
        safeLocalStorageRemove('selectedCRS');

        // Reset application state variables
        surveyLotsStore = {};
        window.currentLoadedSaveName = null;
        activeLotId = null;
        lotCounter = 0;

        // Reset UI
        $('#lotList').empty();
        activeLotEditorArea.html('<div class="active-lot-editor-container placeholder">Select a lot from the list or add a new one to start editing.</div>').addClass('placeholder');
        
        populateNamedSavesDropdown(); 
        updateActiveSaveStatusDisplay(); 
        
        addLot(); // This will eventually set hasUnsavedChanges = false via its save.
        
        triggerMapUpdateWithDebounce(); 
        
        displayMessage('info', 'All application data has been reset. Starting with a fresh survey.');
        // Ensure clean state after all reset operations
        hasUnsavedChanges = false;
        updateActiveSaveStatusDisplay();
    });


    // Fallback: if after loading default, no lots are present (e.g. fresh start, no default save)
    // Ensure there's at least one lot to work with.
    // loadSurvey() already handles adding a new lot if the loaded data is empty or no data found.
    // However, if loadSurvey() itself isn't called (e.g. if we change logic later),
    // this explicit addLot() call AFTER populate and loadSurvey might be a safety net.
    // For now, loadSurvey() should handle it.
    // if (Object.keys(surveyLotsStore).length === 0) {
    //    addLot();
    // }
    // The existing addLot() at the end of document.ready might conflict or be redundant.
    // It should be removed or integrated into this initial load logic.
    // Let's remove the standalone addLot() at the end.

    initMap();
    // addLot(); // Start with one empty lot - REMOVED, handled by loadSurvey() or initial state.

    // Hamburger Menu Functionality
    const hamburgerButton = document.getElementById('hamburger-button');
    const sidebar = document.querySelector('.sidebar'); // Target by class

    if (hamburgerButton && sidebar) {
        hamburgerButton.addEventListener('click', function() {
            sidebar.classList.toggle('sidebar-open');
            hamburgerButton.classList.toggle('active');
            
            // Update aria-expanded
            const isExpanded = hamburgerButton.getAttribute('aria-expanded') === 'true' || false;
            hamburgerButton.setAttribute('aria-expanded', !isExpanded);
        });
    }
});