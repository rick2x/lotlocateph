
$(document).ready(function () {
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

    let uploadedGeodataLayers = {}; // For layers from ZIP upload
    let isEditorMinimized = false; // State for editor minimize/maximize

    // Basemap Persistence - Load
    let initialBasemapKey = localStorage.getItem('selectedBasemap') || 'esriImagery'; // Default to 'esriImagery'
    $('#basemapSelect').val(initialBasemapKey); // Set dropdown to reflect loaded/default choice

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
    }

    // Basemap selector change event
    $('#basemapSelect').on('change', function() {
        const selectedKey = $(this).val();
        updateBasemap(selectedKey);
        localStorage.setItem('selectedBasemap', selectedKey); // Basemap Persistence - Save
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
        localStorage.setItem('selectedCRS', $(this).val());
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
    const savedCRS = localStorage.getItem('selectedCRS');
    if (savedCRS) {
        $('#target_crs_select').val(savedCRS);
        // Trigger change to apply the loaded CRS and update map/UI accordingly
        $('#target_crs_select').trigger('change'); 
    }

    // --- DATA MANAGEMENT & PREVIEW ---

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
    }

    // --- LOT MANAGEMENT UI (MASTER-DETAIL) ---

    function clearAllLots() {
        if (!confirm('Are you sure you want to clear all lots? This will remove all entered data and cannot be undone.')) {
            return;
        }

        persistActiveLotData(); // Save current active lot's data if any

        surveyLotsStore = {}; // Clear the client-side store
        lotListUL.empty(); // Remove all lot items from UI

        clearAllLotMapLayers(true); // Clear all map layers including reference marker

        lotCounter = 0; // Reset lot counter

        activeLotId = null;
        activeLotEditorArea.html('<div class="active-lot-editor-container placeholder">All lots cleared. Add a new lot to begin.</div>').addClass('placeholder');
        activeLotEditorArea.removeClass('editor-minimized'); // Ensure editor is not stuck in minimized state

        addLot(); // Add a fresh "Lot 1"

        triggerMapUpdateWithDebounce(); // Refresh map state

        displayMessage('info', 'All lots have been cleared.');
    }

    function addLot() {
        lotCounter++;
        const newLotId = `lot_${lotCounter}`;
        const lotNum = lotCounter;
        const defaultLotName = `Lot ${lotNum}`;

        surveyLotsStore[newLotId] = { id: newLotId, name: defaultLotName, lines_text: "", num: lotNum };
        
        const listItemHTML = `<li data-lot-id="${newLotId}">` +
                                `<span class="lot-name-display">${defaultLotName}</span>` +
                                `<button class="btn-remove-lot-list" title="Remove ${defaultLotName}">×</button>` +
                             `</li>`;
        const listItem = $(listItemHTML);
        lotListUL.append(listItem);

        if (map && !plottedFeatureGroups[newLotId]) {
            plottedFeatureGroups[newLotId] = L.featureGroup().addTo(map);
        }
        setActiveLot(newLotId);
        triggerMapUpdateWithDebounce(); // This will also persist and plot
    }

    function removeLot(lotIdToRemove) {
        if (!lotIdToRemove) {
            return;
        }

        if (activeLotId && activeLotId !== lotIdToRemove) {
            persistActiveLotData(); // Persist current active lot before removing another
        }

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
                setActiveLot(firstRemainingLot);
            } else {
                triggerMapUpdateWithDebounce(); // Update map if no lots are left
            }
        } else {
            triggerMapUpdateWithDebounce(); // Update map if a non-active lot was removed
        }
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
        triggerMapUpdateWithDebounce();
    });

    activeLotEditorArea.on('input change', '.point-input, .lot-name-input', function () {
        triggerMapUpdateWithDebounce();
    });

    // --- MESSAGING, VALIDATION, PAYLOAD, SERVER CALLS ---

    function showLoading(message = "Processing...") {
        const overlay = $('#loadingOverlay');
        const messageElement = $('#loadingMessage');
        
        messageElement.text(message);
        overlay.css('display', 'flex');
    }

    function hideLoading() {
        const overlay = $('#loadingOverlay');
        overlay.css('display', 'none');
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

    const uploadedLayersListUL = $('#uploadedLayersList'); 
    const noUploadedLayersMsg = $('#noUploadedLayersMessage');

    // Initial setup
    initMap();
    addLot(); // Start with one empty lot

    // Initial state for "No Layers" message
    if (uploadedLayersListUL.children().length === 0) {
        noUploadedLayersMsg.show();
    } else {
        noUploadedLayersMsg.hide();
    }

    // --- Event Listener for Clearing Uploaded Layers ---
    // This button was removed in the previous HTML step, will be re-added if functionality is merged later.
    // For now, keeping it commented or removing if truly deprecated by new manager.
    // Based on previous HTML changes, this button is gone. The new manager will have per-layer delete.
    // $('#clearUploadedLayersBtn').on('click', function() { 
    //     clearUploadedGeodataLayers(); 
    // });

    // --- Drag and Drop for ZIP files on Map ---
    const mapContainer = document.getElementById('map');

    // --- Uploaded Layer Manager Event Listeners ---
    uploadedLayersListUL.on('click', '.btn-layer-visibility', function() {
        const button = $(this);
        const layerItem = button.closest('.layer-item');
        const layerId = layerItem.data('layer-id'); // Get the layer ID (name)

        if (!layerId || !uploadedGeodataLayers[layerId]) {
            console.error('Layer or layer data not found for ID:', layerId);
            return;
        }

        const leafletLayerGroup = uploadedGeodataLayers[layerId];

        if (map.hasLayer(leafletLayerGroup)) {
            map.removeLayer(leafletLayerGroup);
            layerItem.addClass('layer-hidden');
            // button.text('🙈'); // Using CSS classes for icons now
            button.attr('title', 'Show Layer');
            button.removeClass('layer-visible-icon').addClass('layer-hidden-icon'); 
        } else {
            map.addLayer(leafletLayerGroup);
            layerItem.removeClass('layer-hidden');
            // button.text('👁️'); // Using CSS classes for icons now
            button.attr('title', 'Hide Layer');
            button.removeClass('layer-hidden-icon').addClass('layer-visible-icon');
        }
    });

    // Placeholder for Zoom and Delete functionality - to be implemented in next steps
    uploadedLayersListUL.on('click', '.btn-layer-zoom', function() {
        const button = $(this); // 'this' refers to the clicked button
        const layerItem = button.closest('.layer-item');
        const layerId = layerItem.data('layer-id');

        if (!layerId || !uploadedGeodataLayers[layerId]) {
            console.error('Layer or layer data not found for ID:', layerId);
            displayMessage('error', 'Could not find layer data to zoom.');
            return;
        }

        const leafletLayerGroup = uploadedGeodataLayers[layerId];

        // If hidden, make it visible, then zoom.
        if (!map.hasLayer(leafletLayerGroup)) {
            map.addLayer(leafletLayerGroup);
            // Update UI to reflect it's now visible
            layerItem.removeClass('layer-hidden');
            layerItem.find('.btn-layer-visibility') // Find the specific button
                     .attr('title', 'Hide Layer')  // Update title
                     .removeClass('layer-hidden-icon') // Update icon via CSS classes
                     .addClass('layer-visible-icon');
        }
        
        // Get bounds and fit map
        try {
            const bounds = leafletLayerGroup.getBounds();
            if (bounds && bounds.isValid()) {
                map.fitBounds(bounds, { padding: [20, 20], maxZoom: 18 });
            } else {
                // This can happen if the layer is empty or contains only single points without a spread
                displayMessage('info', `Layer '${layerId}' has no valid bounds to zoom to (it might be empty or contain only a single point).`);
                const layersInGroup = leafletLayerGroup.getLayers();
                if (layersInGroup.length === 1 && (layersInGroup[0] instanceof L.Marker || layersInGroup[0] instanceof L.CircleMarker)) {
                    map.setView(layersInGroup[0].getLatLng(), 18); // Zoom to a fixed level for single points
                }
            }
        } catch (e) {
            console.error("Error getting bounds or zooming:", e);
            displayMessage('error', `Could not zoom to layer '${layerId}'. It may not have plottable features.`);
        }
    });

    uploadedLayersListUL.on('click', '.btn-layer-delete', function() {
        // 'this' refers to the clicked button
        const button = $(this);
        const layerItem = button.closest('.layer-item');
        const layerId = layerItem.data('layer-id');

        if (!layerId) { // No layerId usually means something is wrong with the item
            console.error('Could not identify layer to delete.');
            displayMessage('error', 'Error identifying layer for deletion.');
            return;
        }

        // Confirmation dialog
        if (!confirm(`Are you sure you want to delete the layer: "${layerId}"? This action cannot be undone.`)) {
            return; // User cancelled
        }

        // Check if the layer exists in our tracking object
        if (uploadedGeodataLayers[layerId]) {
            const leafletLayerGroup = uploadedGeodataLayers[layerId];
            // Remove from map if it's currently there
            if (map.hasLayer(leafletLayerGroup)) {
                map.removeLayer(leafletLayerGroup);
            }
            // Delete from our tracking object
            delete uploadedGeodataLayers[layerId];
        } else {
            // Layer might be in UI but not in JS objects (should not happen with current logic)
            console.warn('Layer data not found in uploadedGeodataLayers for ID:', layerId, 'but attempting to remove UI item.');
        }

        // Remove the layer item from the UI list
        layerItem.remove();

        // Check if the list is now empty and show the "No layers" message if needed
        // const uploadedLayersListUL = $('#uploadedLayersList'); // Already available globally
        // const noUploadedLayersMsg = $('#noUploadedLayersMessage'); // Already available globally
        if (uploadedLayersListUL.children().length === 0) {
            noUploadedLayersMsg.show();
        } else {
            noUploadedLayersMsg.hide();
        }

        displayMessage('info', `Layer "${layerId}" has been deleted.`);
    });


    if (mapContainer) {
        mapContainer.addEventListener('dragenter', function (e) {
            e.preventDefault();
            e.stopPropagation();
            mapContainer.classList.add('drag-over-map');
        });

        mapContainer.addEventListener('dragover', function (e) {
            e.preventDefault();
            e.stopPropagation(); // Necessary to allow dropping
        });

        mapContainer.addEventListener('dragleave', function (e) {
            e.preventDefault();
            e.stopPropagation();
            // Check if the leave target is outside the map container or its children
            // This helps prevent flickering when dragging over child elements in the map
            if (e.target === mapContainer || !mapContainer.contains(e.relatedTarget)) {
                mapContainer.classList.remove('drag-over-map');
            }
        });

        mapContainer.addEventListener('drop', function (e) {
            e.preventDefault();
            e.stopPropagation();
            mapContainer.classList.remove('drag-over-map');

            const files = e.dataTransfer.files;
            if (!files || files.length === 0) {
                displayMessage('warning', 'No files were dropped.');
                return;
            }
            const file = files[0]; // Process only the first file
            const fileNameLower = file.name.toLowerCase();

            let endpoint = '';
            let formDataKey = '';

            if (fileNameLower.endsWith('.geojson')) {
                endpoint = '/api/upload_geojson_file';
                formDataKey = 'geojsonfile';
            } else if (fileNameLower.endsWith('.dxf')) {
                endpoint = '/api/upload_dxf_file';
                formDataKey = 'dxffile';

                const selectedCRS = $('#target_crs_select').val();
                if (!selectedCRS) {
                    displayMessage('error', 'A Target CRS must be selected in Global Settings to process DXF files accurately. Please select a CRS and try again.');
                    // No need to remove 'drag-over-map' as it's already removed at the start of the drop handler.
                    // No need to hideLoading() here as it hasn't been called yet for this path.
                    return; // Stop the upload
                }
                // formData will be initialized after this block before appending.
            } else if (fileNameLower.endsWith('.zip')) {
                endpoint = '/api/upload_geospatial_zip'; // For Shapefiles (which are inside ZIP)
                formDataKey = 'zipfile';
            } else {
                displayMessage('error', 'Unsupported file type. Please drop a .geojson, .dxf, or .zip file.');
                return;
            }

            const formData = new FormData();
            formData.append(formDataKey, file, file.name);

            // Append source_crs_epsg specifically for DXF files
            if (formDataKey === 'dxffile') {
                const selectedCRS = $('#target_crs_select').val(); // Re-fetch in case it was changed, though unlikely
                formData.append('source_crs_epsg', selectedCRS);
            }

            showLoading('Uploading and processing file...');

            fetch(endpoint, { // Use the determined endpoint
                method: 'POST',
                body: formData
            })
            .then(response => response.json())
            .then(data => {
                hideLoading();
                if (data.status === 'success') {
                    displayMessage('info', data.message || 'File processed successfully. Plotting data...');
                    if (data.layers && data.layers.length > 0) {
                        plotUploadedGeospatialData(data.layers);
                    } else {
                        // This case might occur if a valid file type is sent but contains no plottable data
                        // or if the success message from backend indicates no layers.
                        displayMessage('info', data.message || 'No plottable layers found in the file.');
                        clearUploadedGeodataLayers(); // Clear any existing uploaded layers
                    }
                } else {
                    displayMessage('error', `Processing failed: ${data.message || 'Unknown error'}`);
                }
            })
            .catch(error => {
                hideLoading();
                console.error('Upload Error:', error);
                displayMessage('error', `Upload failed: ${error.message || 'Network error or server unavailable'}`);
            });
        });
    } else {
        console.error("Map container with ID 'map' not found for drag-drop setup.");
    }

    function clearUploadedGeodataLayers() {
        if (map && uploadedGeodataLayers) {
            let count = 0;
            for (const layerName in uploadedGeodataLayers) {
                if (uploadedGeodataLayers.hasOwnProperty(layerName) && uploadedGeodataLayers[layerName]) {
                    if (map.hasLayer(uploadedGeodataLayers[layerName])) {
                        map.removeLayer(uploadedGeodataLayers[layerName]);
                        count++;
                    }
                }
            }
            uploadedGeodataLayers = {};
            // Clear UI list as well when clearing all layers
            uploadedLayersListUL.empty(); 
            if (count > 0) {
                displayMessage('info', 'All uploaded map layers have been cleared.');
            } else {
                displayMessage('info', 'No uploaded map layers to clear.');
            }
        } else {
            uploadedGeodataLayers = {};
            uploadedLayersListUL.empty();
            displayMessage('info', 'No uploaded map layers to clear.');
        }
        // Update "no layers" message visibility
        if (uploadedLayersListUL.children().length === 0) {
            noUploadedLayersMsg.show();
        } else {
            noUploadedLayersMsg.hide();
        }
    }

    function plotUploadedGeospatialData(layers) {
        if (!map) {
            console.error("Map is not initialized. Cannot plot uploaded data.");
            return;
        }

        clearUploadedGeodataLayers(); // Clear previous layers from map and the JS object
        uploadedLayersListUL.empty(); // Clear previous list items from the UI

        let allNewBounds = L.latLngBounds([]);

        layers.forEach((layerData, layerIndex) => { // Renamed 'layers' to 'layerData' for clarity
            if (!layerData.features || layerData.features.length === 0) {
                return;
            }

            const layerName = layerData.name;
            const sanitizedLayerName = $('<div>').text(layerName).html(); // Sanitize for display

            const layerItemHTML = `
                <li class="layer-item" data-layer-id="${sanitizedLayerName}">
                    <span class="layer-name-display">${sanitizedLayerName}</span>
                    <div class="layer-controls">
                        <button class="btn-layer-visibility layer-visible-icon" title="Toggle Visibility">👁️</button> 
                        <button class="btn-layer-zoom" title="Zoom to Layer">🔍</button>
                        <button class="btn-layer-delete" title="Delete Layer">🗑️</button>
                    </div>
                </li>
            `;
            uploadedLayersListUL.append(layerItemHTML);
            
            const layerGroup = L.featureGroup();

            const geoJsonLayer = L.geoJSON(layerData.features, { // Use layerData.features
                style: function (feature) {
                    let styleOptions = {
                        weight: 2,
                        opacity: 0.85,
                        fillOpacity: 0.3
                    };
                    if (layerData.type === 'vector-dxf') {
                        styleOptions.color = '#A020F0'; // Purple for DXF entities
                        styleOptions.fillColor = '#A020F0';
                        if (feature.geometry.type === 'Point') {
                            styleOptions.radius = 3; // Default radius for DXF points (used by L.circleMarker)
                        }
                    } else {
                        // Existing logic for GeoJSON/Shapefile layers
                        const colorIndex = layers.indexOf(layerData) % lotColors.length;
                        styleOptions.color = lotColors[colorIndex];
                        styleOptions.fillColor = lotColors[colorIndex];
                    }
                    return styleOptions;
                },
                pointToLayer: function (feature, latlng) {
                    if (layerData.type === 'vector-dxf' && feature.geometry.type === 'Point') {
                        // Use circleMarker for DXF points, style is applied by the 'style' function
                        return L.circleMarker(latlng); 
                    }
                    // Default marker for non-DXF points or if not customizing
                    return L.marker(latlng); 
                },
                onEachFeature: function (feature, leafletLayer) {
                    if (feature.properties) {
                        let popupContent = `<div class="geojson-popup"><strong>Layer: ${layerData.name}</strong>`;
                        if (layerData.type === 'vector-dxf') {
                            popupContent += `<br><strong>Type:</strong> ${feature.properties.dxf_entity_type || 'DXF Entity'}`;
                            if (feature.properties.layer) {
                                popupContent += `<br><strong>DXF Layer:</strong> ${feature.properties.layer}`;
                            }
                            if (feature.properties.text) {
                                const textValue = String(feature.properties.text).replace(/</g, "&lt;").replace(/>/g, "&gt;");
                                popupContent += `<br><strong>Text:</strong> ${textValue}`;
                            }
                            if (feature.properties.radius !== undefined) { // Check for undefined as radius can be 0
                                popupContent += `<br><strong>Radius:</strong> ${Number(feature.properties.radius).toFixed(3)}`;
                            }
                            
                            let genericPropsCount = 0;
                            const dxfHandledProps = ['dxf_entity_type', 'layer', 'text', 'radius'];
                            for (const key in feature.properties) {
                                if (dxfHandledProps.includes(key)) continue;
                                
                                if (genericPropsCount < 5 && feature.properties[key] !== null && feature.properties[key] !== undefined) {
                                     const valueStr = String(feature.properties[key]).replace(/</g, "&lt;").replace(/>/g, "&gt;");
                                     popupContent += `<br><strong>${key.replace(/</g, "&lt;").replace(/>/g, "&gt;")}:</strong> ${valueStr}`;
                                     genericPropsCount++;
                                } else if (genericPropsCount >= 5) {
                                    popupContent += `<br>...and more properties`;
                                    break;
                                }
                            }
                        } else {
                            // Existing property display logic for GeoJSON/Shapefile features
                            let propCount = 0;
                            const maxPropsToShow = 10;
                            for (const key in feature.properties) {
                                if (propCount >= maxPropsToShow) {
                                    popupContent += `<br>...and more properties`;
                                    break;
                                }
                                let value = feature.properties[key];
                                const valueStr = String(value).replace(/</g, "&lt;").replace(/>/g, "&gt;");
                                popupContent += `<br><strong>${key.replace(/</g, "&lt;").replace(/>/g, "&gt;")}:</strong> ${valueStr}`;
                                propCount++;
                            }
                        }
                        popupContent += `</div>`;
                        leafletLayer.bindPopup(popupContent);
                    }
                }
            });

            geoJsonLayer.addTo(layerGroup);
            layerGroup.addTo(map);
            uploadedGeodataLayers[layerData.name] = layerGroup;

            // Extend the bounds with the bounds of the current layer group
            if (layerGroup.getLayers().length > 0) { // Check if layerGroup has any layers
                 try {
                    const groupBounds = layerGroup.getBounds();
                    if (groupBounds && groupBounds.isValid()) {
                         allNewBounds.extend(groupBounds);
                    }
                } catch (e) {
                    console.warn(`Could not get bounds for layer ${layerData.name}: ${e.message}`);
                }
            }
            console.log(`Added layer "${layerData.name}" to map with ${layerData.features.length} features.`);
        });

        if (allNewBounds.isValid()) {
            map.fitBounds(allNewBounds, { padding: [50, 50], maxZoom: 18 });
        } else if (layers.length > 0) { // Check against original 'layers' array from function arg
            console.warn("Could not determine valid bounds to fit all uploaded layers. Map view unchanged.");
        }

        // Update "no layers" message visibility after adding new items
        if (uploadedLayersListUL.children().length === 0) {
            noUploadedLayersMsg.show();
        } else {
            noUploadedLayersMsg.hide();
        }
    }
});