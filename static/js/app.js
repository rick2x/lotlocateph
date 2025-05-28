$(document).ready(function () {
    const primeSymbol = '′';
    const lotListUL = $('#lotList');
    const activeLotEditorArea = $('#activeLotEditorArea');
    const formMessagesArea = $('#formMessages');

    let lotCounter = 0;
    let activeLotId = null;
    let surveyLotsStore = {};

    let map;
    let plottedFeatureGroups = {};
    let mainReferenceMarker = null;
    let debounceTimeout;
    let messageFadeTimeoutId = null;

    let isEditorMinimized = false; // State for editor minimize/maximize

    // --- INITIALIZATION ---

    function initMap() {
        if (map) {
            map.remove();
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

        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            attribution: 'Tiles © Esri & Contributors',
            maxZoom: 19
        }).addTo(map);

        L.control.zoom({
            position: 'bottomright' // Add zoom control to bottom right
        }).addTo(map);
    }

    if (typeof $.fn.select2 === 'function') {
        $('#reference_point_select').select2({
            placeholder: "Select Reference Point",
            allowClear: true,
            dropdownAutoWidth: true,
            width: '100%',
            theme: "default"
        }).on('change', triggerMapUpdateWithDebounce);
    }

    $('#target_crs_select').on('change', triggerMapUpdateWithDebounce);

    $('#closeDisclaimerBtn').on('click', function () {
        $('#disclaimerBar').slideUp();
    });

    // --- DATA MANAGEMENT & PREVIEW ---

    function formatDataLine(ns, deg, min, ew, dist) {
        const degStr = String(deg).padStart(2, '0');
        const minStr = String(min).padStart(2, '0');
        const distStr = parseFloat(dist).toFixed(2);
        return `${ns} ${degStr}D ${minStr}${primeSymbol} ${ew};${distStr};90`; // Assuming 90 for angle type for now
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
                    dataLines.push(formatDataLine(ns, deg, min, ew, dist));
                }
            }
        });
        surveyLotsStore[activeLotId].lines_text = dataLines.join('\n');
    }

    // --- LOT MANAGEMENT UI (MASTER-DETAIL) ---

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
            <button type="button" class="btn btn-primary btn-add-point-to-lot">${buttonTextContent}</button>
        `;
        activeLotEditorArea.html(editorHtml);

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

        if (data && data[0] && data[1]) {
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

        let firstErrorLotName = null;
        let firstErrorLotLine = -1;

        for (const lotId in surveyLotsStore) {
            if (surveyLotsStore.hasOwnProperty(lotId)) {
                const lot = surveyLotsStore[lotId];
                const lines = lot.lines_text.split('\n').filter(l => l.trim() !== '');

                if (lines.length > 0) {
                    lines.forEach((line, index) => {
                        const parts = line.split(';');
                        if (parts.length < 2) {
                            if (firstErrorLotName === null) {
                                firstErrorLotName = lot.name;
                                firstErrorLotLine = index + 1;
                            }
                            formIsValid = false;
                            return; // from forEach callback
                        }
                        const bearingData = parseBearing(parts[0]);
                        const dist = parseFloat(parts[1]);
                        if (!bearingData || isNaN(dist) || dist <= 0 || 
                            bearingData.deg < 0 || bearingData.deg > 89 || 
                            bearingData.min < 0 || bearingData.min > 59) {
                            if (firstErrorLotName === null) {
                                firstErrorLotName = lot.name;
                                firstErrorLotLine = index + 1;
                            }
                            formIsValid = false;
                        }
                    });
                }
            }
        }

        if (!formIsValid && firstErrorLotName && showAlerts) {
            displayMessage('error', `Invalid data in Lot "${firstErrorLotName}", around Line ${firstErrorLotLine}. Please correct and try again.`);
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
        return {
            target_crs_select: $('#target_crs_select').val(),
            reference_point_select: $('#reference_point_select').val(),
            lots: getLotsForPayload()
        };
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

        displayMessage('info', 'Updating map...');
        fetch('/calculate_plot_data_multi', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
        .then(response => response.json())
        .then(result => {
            clearMessages();
            if (result.status === 'success' || result.status === 'success_with_errors') {
                plotMultiLotDataOnMap(result.data_per_lot, result.reference_plot_data);
                if (result.status === 'success_with_errors') {
                    let errorMessages = ["Map updated. Some lots may have issues:"];
                    (result.data_per_lot || []).forEach(lr => {
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

        let allLatLngsForBounds = [];

        // Handle Main Reference Marker
        if (mainReferenceMarker && map.hasLayer(mainReferenceMarker)) {
            map.removeLayer(mainReferenceMarker);
            mainReferenceMarker = null;
        }
        if (referencePlotData && referencePlotData.reference_marker_latlng) {
            mainReferenceMarker = L.marker(
                referencePlotData.reference_marker_latlng, 
                { title: "Reference Point" }
            ).bindPopup("Reference Point");
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
            if (plotData.tie_line_latlngs && plotData.tie_line_latlngs.length > 0) {
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
                currentLotFeatureGroup.addLayer(parcelPolyline);
                parcelPath.forEach(p => allLatLngsForBounds.push(p));
                lotHasDrawableData = true;

                parcelPath.forEach((point, pIndex) => {
                    let label = (pIndex === 0) ? `POB: ${lotName}` : `Pt ${pIndex + 1}: ${lotName}`;
                    // Avoid duplicating POB marker if parcel closes on itself
                    if (pIndex === parcelPath.length - 1 && pIndex > 0 &&
                        parcelPath[0][0] === point[0] && parcelPath[0][1] === point[1]) {
                        // This is the closing point, same as POB, don't add another marker if POB is already marked
                    } else {
                        const vertexMarker = L.circleMarker(point, { 
                            radius: 4.5, color: color, weight: 1, 
                            fillColor: color, fillOpacity: 0.7, title: label 
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
        
        displayMessage('info', 'Preparing Shapefile export...');
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

        displayMessage('info', 'Preparing KMZ export...');
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
        
        displayMessage('info', 'Preparing DXF export...');
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

        displayMessage('info', 'Preparing GeoJSON export...');
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
        });
    });

    // Initial setup
    initMap();
    addLot(); // Start with one empty lot
});
