"""
Main Flask application file for the LotLocate PH tool.

Handles web routes, data processing for lot calculations, and file exports.
"""

# Standard library imports
import io
import json
import math
import os
import re
import tempfile
import zipfile

# Third-party imports
import ezdxf
from ezdxf.enums import TextEntityAlignment
from flask import Flask, current_app, jsonify, render_template, request, send_file
from flask_caching import Cache
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
import geopandas as gpd
import pandas as pd
from pyproj import CRS, Transformer
from pyproj.exceptions import CRSError
from shapely.geometry import Point, LineString, Polygon
import simplekml

# Local application imports
from gis_utils import DEFAULT_TARGET_CRS_EPSG, get_transformers
from utils import (
    calculate_azimuth,
    calculate_new_coordinates,
    get_sanitized_filename_base,
    parse_survey_line_to_bearing_distance,
    decimal_azimuth_to_bearing_string
)

# Area Conversion Constants
# SQM_TO_SQFT = 10.7639 # Removed
# SQM_TO_ACRES = 0.000247105 # Removed
SQM_TO_HECTARES = 0.0001

app = Flask(__name__)
app.secret_key = 'your_very_secret_key_rizal_encoder_v13_csv_cache'  # TODO: Change in production

limiter = Limiter(
    get_remote_address,  # Key by remote IP address
    app=app,
    default_limits=["200 per day", "50 per hour"],  # Default for routes
    storage_uri="memory://",  # Use in-memory storage
    # strategy="fixed-window"  # Default, can also be "moving-window", etc.
)

# Application configuration
config = {
    "DEBUG": True,  # TODO: Set to False in production
    "CACHE_TYPE": "SimpleCache",  # In-memory cache
    "CACHE_DEFAULT_TIMEOUT": 3600  # 1 hour
}
app.config.from_mapping(config)
cache = Cache(app)

# Path to the reference points CSV file
RIZAL_CSV_PATH = os.path.join(app.root_path, 'rizal.csv')

# DEFAULT_TARGET_CRS_EPSG is imported from gis_utils
# CRS_LATLON_EPSG (4326) is defined in gis_utils and used by get_transformers
# _transformer_cache is defined and managed within gis_utils


@cache.cached(timeout=86400)  # Cache for 24 hours
def load_reference_points():
    """
    Loads and processes reference points from the Rizal CSV file.

    The result is cached for 24 hours to minimize disk I/O and processing.

    Returns:
        tuple: A tuple containing:
            - list: A list of reference point dictionaries, each with
                    'display_name', 'EASTINGS', and 'NORTHINGS'. Empty if error.
            - str or None: An error message string if an error occurred,
                           otherwise None.
    """
    # current_app is now imported at module level
    current_app.logger.info(
        f"Executing load_reference_points() from {RIZAL_CSV_PATH} "
        f"(cache miss or timeout)"
    )
    try:
        if not os.path.exists(RIZAL_CSV_PATH):
            user_msg = (
                f"Error: The reference points file "
                f"('{os.path.basename(RIZAL_CSV_PATH)}') could not be found "
                f"on the server. Please contact support."
            )
            current_app.logger.error(
                f"Reference points file not found: {RIZAL_CSV_PATH}"
            )
            return [], user_msg
        
        df = pd.read_csv(RIZAL_CSV_PATH, encoding='utf-8-sig', on_bad_lines='warn')
        
        location_col = 'LOCATION'
        point_col = 'POINT_OF_REFERENCE'
        easting_col = 'EASTINGS'
        northing_col = 'NORTHINGS'
        required_csv_cols = {location_col, point_col, easting_col, northing_col}

        if not required_csv_cols.issubset(df.columns):
            missing_cols_str = ', '.join(required_csv_cols - set(df.columns))
            user_msg = (
                f"Error: The reference points file "
                f"('{os.path.basename(RIZAL_CSV_PATH)}') is missing required "
                f"columns: {missing_cols_str}. Please check the file format or "
                f"contact support."
            )
            current_app.logger.error(
                f"CSV missing columns in '{os.path.basename(RIZAL_CSV_PATH)}': "
                f"{missing_cols_str}"
            )
            return [], user_msg

        df = df[list(required_csv_cols)].copy()
        df.dropna(
            subset=[location_col, point_col, easting_col, northing_col],
            inplace=True
        )
        for col in [location_col, point_col, easting_col, northing_col]:
            df[col] = df[col].astype(str).str.strip()
            df = df[~df[col].isin(['', '#REF!'])] # Filter out specific invalid values
            df = df[df[col].str.len() > 0] # Filter out empty strings after strip
        
        if df.empty:
            return [], "Warning: No valid data rows in CSV after initial cleaning."

        # Clean and convert coordinate columns
        for col_name in [easting_col, northing_col]:
            df[col_name] = df[col_name].str.replace(',', '', regex=False)
            df[col_name] = pd.to_numeric(df[col_name], errors='coerce')
        
        df.dropna(subset=[easting_col, northing_col], inplace=True)
        if df.empty:
            return [], "Warning: No points with valid numeric coordinates found."

        df['display_name'] = df[location_col] + " - " + df[point_col]
        df.drop_duplicates(subset=['display_name'], keep='first', inplace=True)
        df.sort_values(by='display_name', inplace=True)
        
        return df[['display_name', 'EASTINGS', 'NORTHINGS']].to_dict('records'), None
    
    except pd.errors.EmptyDataError:
        user_msg = (
            f"Error: The reference points file "
            f"('{os.path.basename(RIZAL_CSV_PATH)}') is empty. Please provide a "
            f"file with data or contact support."
        )
        current_app.logger.error(
            f"Pandas EmptyDataError for '{os.path.basename(RIZAL_CSV_PATH)}'."
        )
        return [], user_msg
    except Exception as e:
        user_msg = (
            f"A critical server error occurred while processing the reference "
            f"points file ('{os.path.basename(RIZAL_CSV_PATH)}'). "
            f"Please contact support."
        )
        current_app.logger.error(
            f"Critical error processing '{os.path.basename(RIZAL_CSV_PATH)}': {str(e)}",
            exc_info=True
        )
        return [], user_msg


# --- Helper functions for _calculate_single_lot_geometry ---

def _parse_and_calculate_next_point(
        line_str, current_e, current_n, line_num_for_log,
        lot_name_for_log, line_description_for_log
    ):
    """
    Parses a survey line, calculates azimuth, and computes new coordinates.

    Args:
        line_str (str): The survey line string.
        current_e (float): Current Easting.
        current_n (float): Current Northing.
        line_num_for_log (int): Line number for logging purposes.
        lot_name_for_log (str): Lot name for logging.
        line_description_for_log (str): Description of the line type for logging.

    Returns:
        dict: A dictionary with 'status', 'e', 'n', 'line_data' on success,
              or 'status', 'message' on error.
    """
    # current_app is now imported at module level
    line_data = parse_survey_line_to_bearing_distance(line_str)
    if not line_data:
        return {
            "status": "error",
            "message": f"Lot '{lot_name_for_log}': Invalid {line_description_for_log} (line {line_num_for_log}): {line_str}"
        }
    
    azimuth = calculate_azimuth(line_data)
    if azimuth is None:
        return {
            "status": "error",
            "message": f"Lot '{lot_name_for_log}': Azimuth error {line_description_for_log} (line {line_num_for_log}): {line_str}"
        }

    next_e, next_n = calculate_new_coordinates(current_e, current_n, azimuth, line_data['distance'])
    return {"status": "success", "e": next_e, "n": next_n, "line_data": line_data}

def _transform_point_to_latlon(e, n, transformer_to_latlon, point_desc_for_log, lot_name_for_log):
    """
    Transforms a single projected point (Easting, Northing) to geographical
    coordinates (Latitude, Longitude).

    Args:
        e (float): Easting coordinate.
        n (float): Northing coordinate.
        transformer_to_latlon (pyproj.Transformer): Transformer object.
        point_desc_for_log (str): Description of the point for logging.
        lot_name_for_log (str): Lot name for logging.

    Returns:
        list or None: A list [latitude, longitude] on success, or None on failure.
    """
    # current_app is now imported at module level
    if not transformer_to_latlon:
        current_app.logger.warning(
            f"Lot '{lot_name_for_log}': Transformer to Lat/Lon not available "
            f"for {point_desc_for_log}."
        )
        return None
    try:
        lon, lat = transformer_to_latlon.transform(e, n)
        return [lat, lon]
    except Exception as err_transform:
        current_app.logger.error(
            f"Lot '{lot_name_for_log}': Error transforming {point_desc_for_log} "
            f"(E:{e}, N:{n}) to Lat/Lon: {str(err_transform)}"
        )
        return None


# --- Main lot calculation function ---

def _calculate_single_lot_geometry(
        transformer_to_latlon, ref_e, ref_n, survey_lines_text_for_lot,
        lot_id="unknown", lot_name="Unknown Lot"
    ):
    """
    Calculates the geometry (projected and lat/lon coordinates) for a single lot
    based on its survey lines text, starting from a reference point.

    Args:
        transformer_to_latlon (pyproj.Transformer): Transformer for projected to lat/lon.
        ref_e (float): Easting of the main reference point for this lot.
        ref_n (float): Northing of the main reference point for this lot.
        survey_lines_text_for_lot (str): Multiline string of survey lines.
        lot_id (str): Identifier for the lot.
        lot_name (str): Name of the lot.

    Returns:
        dict: A dictionary containing the lot's ID, name, status ('success',
              'error', or 'nodata'), and calculated 'projected' and 'latlon'
              coordinates. Includes a 'message' field on error or for nodata.
    """
    # current_app is now imported at module level
    lot_proj_coords = {
        "pob_en": None,
        "tie_line_ens": [],
        "parcel_boundary_ens": []
    }
    lot_latlon_coords = {
        "pob_latlng": None,
        "tie_line_latlngs": [],
        "parcel_polygon_latlngs": []
    }
    
    current_e, current_n = ref_e, ref_n
    survey_lines = [
        line for line in survey_lines_text_for_lot.splitlines() if line.strip()
    ]

    if not survey_lines:
        return {
            "status": "nodata", "lot_id": lot_id, "lot_name": lot_name,
            "projected": lot_proj_coords, "latlon": lot_latlon_coords,
            "message": f"Lot '{lot_name}' has no survey lines."
        }

    # Process POB (first line)
    pob_result = _parse_and_calculate_next_point(
        survey_lines[0], current_e, current_n, 1, lot_name, "tie-line to POB"
    )
    if pob_result["status"] == "error":
        return {
            "status": "error", "lot_id": lot_id, "lot_name": lot_name,
            "message": pob_result["message"]
        }
    
    pob_e, pob_n = pob_result["e"], pob_result["n"]
    lot_proj_coords["pob_en"] = (pob_e, pob_n)
    lot_proj_coords["tie_line_ens"] = [(current_e, current_n), (pob_e, pob_n)] 
    lot_proj_coords["parcel_boundary_ens"].append((pob_e, pob_n))

    # Transform reference point and POB to Lat/Lon
    ref_latlon = _transform_point_to_latlon(
        ref_e, ref_n, transformer_to_latlon,
        "Reference Point for Tie-Line", lot_name
    )
    pob_latlon = _transform_point_to_latlon(
        pob_e, pob_n, transformer_to_latlon, "POB", lot_name
    )

    if ref_latlon and pob_latlon:
        lot_latlon_coords["pob_latlng"] = pob_latlon
        lot_latlon_coords["tie_line_latlngs"] = [ref_latlon, pob_latlon]
        lot_latlon_coords["parcel_polygon_latlngs"].append(pob_latlon)
    # Note: If transformations fail, messages are logged by _transform_point_to_latlon.
    # The function proceeds; downstream users handle missing latlon data.

    current_e, current_n = pob_e, pob_n

    # Process subsequent lines for parcel boundary
    for i, line_str in enumerate(survey_lines[1:], start=2):
        vertex_result = _parse_and_calculate_next_point(
            line_str, current_e, current_n, i, lot_name, "parcel boundary"
        )
        if vertex_result["status"] == "error":
            return {
                "status": "error", "lot_id": lot_id, "lot_name": lot_name,
                "message": vertex_result["message"]
            }

        next_e, next_n = vertex_result["e"], vertex_result["n"]
        lot_proj_coords["parcel_boundary_ens"].append((next_e, next_n))
        
        vertex_latlon = _transform_point_to_latlon(
            next_e, next_n, transformer_to_latlon, f"Vertex {i-1}", lot_name
        )
        if vertex_latlon:
            lot_latlon_coords["parcel_polygon_latlngs"].append(vertex_latlon)
        
        current_e, current_n = next_e, next_n
    
    # Calculate Misclosure (before auto-closing the polygon)
    misclosure_distance_val = None
    misclosure_azimuth_deg_val = None
    misclosure_data_for_return = {
        "distance_raw": None,
        "azimuth_raw_deg": None
        # Formatted strings will be added by the calling endpoint
    }

    if len(lot_proj_coords["parcel_boundary_ens"]) >= 2:
        pob_en = lot_proj_coords["parcel_boundary_ens"][0]
        actual_last_calculated_point_en = lot_proj_coords["parcel_boundary_ens"][-1]

        delta_e = actual_last_calculated_point_en[0] - pob_en[0]
        delta_n = actual_last_calculated_point_en[1] - pob_en[1]

        misclosure_distance_val = math.sqrt(delta_e**2 + delta_n**2)
        
        misclosure_azimuth_rad = math.atan2(delta_e, delta_n)
        misclosure_azimuth_deg_val = math.degrees(misclosure_azimuth_rad)
        if misclosure_azimuth_deg_val < 0:
            misclosure_azimuth_deg_val += 360.0
        
        misclosure_data_for_return["distance_raw"] = misclosure_distance_val
        misclosure_data_for_return["azimuth_raw_deg"] = misclosure_azimuth_deg_val

    # Close the polygon if necessary
    parcel_ens = lot_proj_coords["parcel_boundary_ens"]
    parcel_latlngs = lot_latlon_coords["parcel_polygon_latlngs"]

    if len(parcel_ens) > 1 and parcel_ens[0] != parcel_ens[-1]:
        parcel_ens.append(parcel_ens[0]) # Close the projected coordinates
        if parcel_latlngs and len(parcel_latlngs) > 0 and \
           parcel_latlngs[0] != parcel_latlngs[-1]:
            # Ensure the first point's lat/lon is available before appending
            first_vertex_latlon = parcel_latlngs[0]
            parcel_latlngs.append(first_vertex_latlon) # Close the lat/lon coordinates
    
    # Calculate Raw Area
    raw_area_sqm = None
    if len(parcel_ens) >= 4: # Need at least 3 unique points forming a closed polygon
        try:
            # parcel_ens should already be a list of (E,N) tuples
            shapely_polygon = Polygon(parcel_ens)
            if shapely_polygon.is_valid:
                raw_area_sqm = shapely_polygon.area
            else:
                current_app.logger.warning(f"Lot '{lot_name}': Calculated polygon is not valid.")
        except Exception as e:
            current_app.logger.error(f"Lot '{lot_name}': Error calculating area: {str(e)}")
            # raw_area_sqm remains None
            
    return {
        "status": "success",
        "lot_id": lot_id,
        "lot_name": lot_name,
        "projected": lot_proj_coords,
        "latlon": lot_latlon_coords,
        "misclosure": misclosure_data_for_return,
        "area_sqm_raw": raw_area_sqm # New key
    }


@app.route('/')
@limiter.limit("20 per minute")
def index():
    """Renders the main page of the application."""
    # The `app.logger` here is acceptable as it's for the main app instance
    # before specific request contexts might be fully pushed for `current_app`.
    # However, for consistency, current_app.logger can also be used if preferred
    # and app context is guaranteed. Sticking to app.logger for this specific line.
    app.logger.info("Index route called.") # Or current_app.logger.info(...)
    
    ref_pts, csv_err_msg = load_reference_points()
    return render_template(
        'index.html',
        reference_points_data=ref_pts,
        reference_points_data_json=json.dumps(ref_pts),
        initial_data_lines_json=json.dumps([]), # For potential future use
        csv_error_message=csv_err_msg if not ref_pts else None,
        selected_ref_point_name=None # No pre-selection
    )


@app.route('/calculate_plot_data_multi', methods=['POST'])
@limiter.limit("30 per minute;100 per hour")
def calculate_plot_data_multi_endpoint():
    """
    Calculates plot data for multiple lots based on JSON input.

    Receives survey data and reference point information, then computes
    projected and geographical coordinates for plotting on a map.
    """
    data = request.get_json()
    if not data:
        return jsonify({"status": "error", "message": "No JSON data provided."}), 400
    
    target_crs_epsg_str = data.get(
        'target_crs_select', str(DEFAULT_TARGET_CRS_EPSG)
    )
    selected_display_name = data.get('reference_point_select')
    lots_data_from_payload = data.get('lots', [])

    transformer_to_latlon, _, err_msg_transformer = get_transformers(
        target_crs_epsg_str
    )
    if err_msg_transformer:
        return jsonify({
            "status": "error", "message": err_msg_transformer
        }), 400

    ref_pts_list, csv_err_msg = load_reference_points()
    if csv_err_msg:
        # Assuming csv_err_msg from load_reference_points is user-friendly
        return jsonify({
            "status": "error", "message": f"Reference point data error: {csv_err_msg}"
        }), 500

    if not selected_display_name:
        if not lots_data_from_payload:  # No ref point, no lots
            return jsonify({
                "status": "success", "data_per_lot": [],
                "reference_plot_data": {"reference_marker_latlng": None}
            })
        # No ref point, but lots are present - this is an error for calculation
        return jsonify({
            "status": "error",
            "message": "Please select a reference point when lot data is present."
        }), 400
    
    selected_point_details = next(
        (p for p in ref_pts_list if p['display_name'] == selected_display_name),
        None
    )
    if not selected_point_details:
        return jsonify({
            "status": "error",
            "message": f"Selected reference point '{selected_display_name}' not found."
        }), 400
    
    try:
        main_ref_e = float(selected_point_details['EASTINGS'])
        main_ref_n = float(selected_point_details['NORTHINGS'])
    except ValueError:
        return jsonify({
            "status": "error",
            "message": "Invalid coordinates for the selected main reference point."
        }), 400

    reference_plot_data = {"reference_marker_latlng": None}
    if transformer_to_latlon and main_ref_e is not None and main_ref_n is not None:
        try:
            ref_lon, ref_lat = transformer_to_latlon.transform(main_ref_e, main_ref_n)
            reference_plot_data["reference_marker_latlng"] = [ref_lat, ref_lon]
        except Exception as e:
            current_app.logger.error(
                f"Error transforming main ref point to Lat/Lon for plotting: {str(e)}",
                exc_info=True
            )

    results_per_lot = []
    any_lot_had_error = False

    if not isinstance(lots_data_from_payload, list):
        current_app.logger.warning("Invalid payload: 'lots' field is not a list.")
        # Depending on strictness, could return 400 error here.
        # For now, treating as empty list of lots.
        lots_data_from_payload = []

    if not lots_data_from_payload: 
         return jsonify({"status": "success", "data_per_lot": [], "reference_plot_data": reference_plot_data})

    for index, lot_input in enumerate(lots_data_from_payload):
        if not isinstance(lot_input, dict):
            current_app.logger.warning(f"Skipping malformed lot entry at index {index}: not a dictionary. Entry: {lot_input}")
            results_per_lot.append({
                "lot_id": f"malformed_lot_{index}",
                "lot_name": f"Malformed Lot {index+1}",
                "status": "error",
                "message": "Lot data is not structured correctly (must be a dictionary)."
            })
            any_lot_had_error = True
            continue

        lot_id = lot_input.get('id')
        if lot_id is None:
            lot_id = f"missing_id_{index}"
            current_app.logger.warning(f"Lot entry at index {index} is missing 'id'. Using default: '{lot_id}'.")

        lot_name = lot_input.get('name')
        if lot_name is None:
            lot_name = f"Unnamed Lot {index+1}"
            current_app.logger.warning(f"Lot entry '{lot_id}' is missing 'name'. Using default: '{lot_name}'.")
        
        lines_text = lot_input.get('lines_text')
        if not isinstance(lines_text, str):
            current_app.logger.warning(f"Skipping lot '{lot_id}' ({lot_name}): 'lines_text' is missing or not a string. Entry: {lot_input}")
            results_per_lot.append({
                "lot_id": lot_id,
                "lot_name": lot_name,
                "status": "error",
                "message": "Lot survey lines ('lines_text') are missing or invalid."
            })
            any_lot_had_error = True
            continue
        
        # main_ref_e and main_ref_n must be defined here if lots are present (ensured by earlier check)
        single_lot_result = _calculate_single_lot_geometry(
            transformer_to_latlon, main_ref_e, main_ref_n, lines_text, lot_id, lot_name
        )
        
        if single_lot_result["status"] == "error":
            any_lot_had_error = True
        
        results_per_lot.append({
            "lot_id": lot_id,
            "lot_name": lot_name,
            "status": single_lot_result["status"],
            "message": single_lot_result.get("message"),
            "plot_data": single_lot_result.get("latlon", {}),
            "misclosure_raw": single_lot_result.get("misclosure", {"distance_raw": None, "azimuth_raw_deg": None}),
            "area_sqm_raw": single_lot_result.get("area_sqm_raw") # Store raw area
        })

    overall_status = "success_with_errors" if any_lot_had_error else "success"
    
    # Post-process results to format misclosure and areas for frontend
    for lot_result_item in results_per_lot:
        # Format Misclosure
        if lot_result_item["status"] == "success":
            raw_misclosure = lot_result_item.pop("misclosure_raw", {}) 
            formatted_misclosure = { "distance": None, "bearing": None }
            if raw_misclosure.get("distance_raw") is not None:
                formatted_misclosure["distance"] = f"{raw_misclosure['distance_raw']:.3f}m"
            raw_azimuth_deg = raw_misclosure.get("azimuth_raw_deg")
            formatted_misclosure["bearing"] = decimal_azimuth_to_bearing_string(raw_azimuth_deg)
            lot_result_item["misclosure"] = formatted_misclosure
        else:
            lot_result_item["misclosure"] = { "distance": None, "bearing": None }

        # Format Areas
        raw_area_sqm = lot_result_item.pop("area_sqm_raw", None) # Remove raw area
        formatted_areas = {"sqm": None, "hectares": None} # Simplified
        if lot_result_item["status"] == "success" and raw_area_sqm is not None and isinstance(raw_area_sqm, (int, float)):
            formatted_areas["sqm"] = f"{raw_area_sqm:.3f} sqm"
            # area_sqft = raw_area_sqm * SQM_TO_SQFT # Removed
            # formatted_areas["sqft"] = f"{area_sqft:.3f} sqft" # Removed
            # area_acres = raw_area_sqm * SQM_TO_ACRES # Removed
            # formatted_areas["acres"] = f"{area_acres:.4f} acres" # Removed
            area_hectares = raw_area_sqm * SQM_TO_HECTARES
            formatted_areas["hectares"] = f"{area_hectares:.4f} ha"
        lot_result_item["areas"] = formatted_areas

    return jsonify({
        "status": overall_status, 
        "data_per_lot": results_per_lot,
        "reference_plot_data": reference_plot_data
    })

# --- Refactored Export Helper Functions ---


def _prepare_export_data_for_routes(request_data, export_format_name):
    """
    Prepares common data needed for various export routes.

    This includes validating essential inputs, loading reference points,
    and setting up coordinate transformers.

    Args:
        request_data (dict): The JSON data from the request.
        export_format_name (str): The name of the export format (e.g., "Shapefile").

    Returns:
        tuple: A tuple (params, error_response_tuple).
               'params' is a dictionary of prepared data on success.
               'error_response_tuple' is (None, (jsonify_object, status_code))
               if an error occurs, otherwise None.
    """
    target_crs_epsg_str = request_data.get(
        'target_crs_select', str(DEFAULT_TARGET_CRS_EPSG)
    )
    selected_display_name = request_data.get('reference_point_select')
    lots_data_from_payload = request_data.get('lots', [])
    # current_app is now imported at module level

    if not selected_display_name and not lots_data_from_payload:
        msg = (
            f"No reference point selected and no lot data provided. Please "
            f"select a reference point or add lot details to export for "
            f"{export_format_name}."
        )
        return None, (jsonify({"status": "error", "message": msg}), 400)

    transformer_to_latlon, _, err_msg_transformer = get_transformers(
        target_crs_epsg_str
    )
    if err_msg_transformer:
        # err_msg_transformer is already user-friendly from get_transformers
        return None, (jsonify({
            "status": "error", "message": err_msg_transformer
        }), 400)

    ref_pts_list, csv_err_msg = load_reference_points()
    if csv_err_msg:
        # csv_err_msg is already a user-friendly message
        current_app.logger.error(
            f"Error loading reference points for {export_format_name}: {csv_err_msg}"
        )
        return None, (jsonify({
            "status": "error",
            "message": f"Failed to load reference points: {csv_err_msg}"
        }), 500)

    main_ref_e, main_ref_n = None, None
    main_ref_transformed_lonlat = None

    if selected_display_name:
        selected_point_details = next(
            (p for p in ref_pts_list if p['display_name'] == selected_display_name),
            None
        )
        if not selected_point_details:
            msg = (
                f"The selected reference point '{selected_display_name}' "
                f"could not be found. Please check your selection."
            )
            return None, (jsonify({"status": "error", "message": msg}), 400)
        try:
            main_ref_e = float(selected_point_details['EASTINGS'])
            main_ref_n = float(selected_point_details['NORTHINGS'])
            if transformer_to_latlon:
                main_ref_transformed_lonlat = transformer_to_latlon.transform(
                    main_ref_e, main_ref_n
                )
        except ValueError:
            msg = (
                "The coordinates for the selected reference point are invalid. "
                "Please check the reference data."
            )
            current_app.logger.error(
                f"ValueError for reference point '{selected_display_name}' coordinates: "
                f"E='{selected_point_details['EASTINGS']}', "
                f"N='{selected_point_details['NORTHINGS']}'"
            )
            return None, (jsonify({"status": "error", "message": msg}), 400)
        except Exception as e_tx:
            current_app.logger.error(
                f"{export_format_name}: Error transforming main ref point "
                f"'{selected_display_name}': {str(e_tx)}", exc_info=True
            )
            # This error is logged; export can proceed if only main ref point
            # transformation fails.
    elif lots_data_from_payload:  # No ref point selected, but lot data is present
        msg = (
            f"A reference point must be selected when exporting lot data to "
            f"{export_format_name}. Please select a reference point."
        )
        return None, (jsonify({"status": "error", "message": msg}), 400)

    params = {
        "transformer_to_latlon": transformer_to_latlon,
        "main_ref_e": main_ref_e,
        "main_ref_n": main_ref_n,
        "main_ref_transformed_lonlat": main_ref_transformed_lonlat,
        "lots_data": lots_data_from_payload,
        "selected_display_name": selected_display_name,
        "target_crs_epsg_str": target_crs_epsg_str,
    }

    if export_format_name.lower() == "shapefile":
        try:
            params["target_crs_epsg_int"] = int(target_crs_epsg_str)
        except ValueError:
            msg = (
                f"The Target CRS EPSG for Shapefile export must be a whole "
                f"number. Received: '{target_crs_epsg_str}'."
            )
            current_app.logger.error(
                f"ValueError for Shapefile target_crs_epsg_int: "
                f"'{target_crs_epsg_str}'"
            )
            return None, (jsonify({"status": "error", "message": msg}), 400)
            
    return params, None


def _process_lots_for_export(
        lots_data_payload, transformer_to_latlon, main_ref_e, main_ref_n,
        lot_data_handler_callback, export_specific_context,
        export_format_name_logging
    ):
    """
    Processes a list of lot data by calculating their geometry and then
    calling a format-specific handler for each lot.

    Args:
        lots_data_payload (list): List of lot data dictionaries from the request.
        transformer_to_latlon: Transformer for coordinate conversion.
        main_ref_e (float): Easting of the main reference point.
        main_ref_n (float): Northing of the main reference point.
        lot_data_handler_callback (function): The format-specific function to call
                                             for each processed lot.
        export_specific_context (dict): Contextual data for the lot handler.
        export_format_name_logging (str): Name of the export format for logging.

    Returns:
        bool: True if at least one lot was successfully processed and handled,
              False otherwise.
    """
    # current_app is now imported at module level
    any_lot_data_processed_successfully = False
    if not isinstance(lots_data_payload, list):
        current_app.logger.error(
            f"{export_format_name_logging}: Invalid payload structure: 'lots' "
            f"field is not a list. Payload: {lots_data_payload}"
        )
        return False # No lots processed

    if not lots_data_payload:
        return False # No lots to process

    # This check is important if lots are present.
    # Should not happen if _prepare_export_data_for_routes enforces ref point.
    if main_ref_e is None or main_ref_n is None:
        current_app.logger.error(
            f"{export_format_name_logging}: Critical - main reference E/N missing "
            f"for lot processing. Lots cannot be processed."
        )
        return False

    for index, lot_input in enumerate(lots_data_payload):
        if not isinstance(lot_input, dict):
            current_app.logger.warning(
                f"{export_format_name_logging}: Skipping malformed lot entry at "
                f"index {index}: not a dictionary. Entry: {lot_input}"
            )
            # KMZ specific: call handler to create an error marker.
            if (hasattr(export_specific_context, 'get') and
                    export_specific_context.get('project_folder')):
                lot_data_handler_callback(
                    f"malformed_lot_{index}", f"Malformed Lot {index+1}", 
                    {"status": "error",
                     "message": "Lot data is not structured correctly (must be a dictionary)."}, 
                    export_specific_context
                )
            continue

        lot_id = lot_input.get('id')
        if lot_id is None:
            lot_id = f"missing_id_{index}"
            current_app.logger.warning(
                f"{export_format_name_logging}: Lot entry at index {index} is "
                f"missing 'id'. Using default: '{lot_id}'."
            )

        lot_name = lot_input.get('name')
        if lot_name is None:
            lot_name = f"Unnamed Lot {index+1}"
            current_app.logger.warning(
                f"{export_format_name_logging}: Lot entry '{lot_id}' is missing "
                f"'name'. Using default: '{lot_name}'."
            )
        
        lines_text = lot_input.get('lines_text')
        if not isinstance(lines_text, str):
            current_app.logger.warning(
                f"{export_format_name_logging}: Skipping lot '{lot_id}' ({lot_name}): "
                f"'lines_text' is missing or not a string. Entry: {lot_input}"
            )
            # KMZ specific: call handler to create an error marker.
            if (hasattr(export_specific_context, 'get') and
                    export_specific_context.get('project_folder')):
                lot_data_handler_callback(
                    lot_id, lot_name, 
                    {"status": "error",
                     "message": "Lot survey lines ('lines_text') are missing or invalid."},
                    export_specific_context
                )
            continue

        if not lines_text.strip():  # Handles empty string for lines_text
            current_app.logger.info(
                f"{export_format_name_logging}: Skipping empty Lot '{lot_name}' "
                f"(ID: {lot_id}) as 'lines_text' is blank."
            )
            # Call handler for empty lot if it needs to do something (e.g. log specific error marker)
            # For now, we assume the callback is for non-empty, calculated lots.
            # If callback needs to act on empty or error status directly:
            # lot_data_handler_callback(lot_id, lot_name, 
            #                          {"status": "nodata", "message": "Empty lot", "projected": {}, "latlon": {}}, 
            #                          export_specific_context)
            continue

        single_lot_geometry_result = _calculate_single_lot_geometry(
            transformer_to_latlon, main_ref_e, main_ref_n, lines_text, lot_id, lot_name
        )
        
        # The callback returns true if it successfully "handled" the lot (e.g. added geometry or an error marker)
        # We specifically track if any *successful geometric data* was generated.
        if lot_data_handler_callback(lot_id, lot_name, single_lot_geometry_result, export_specific_context):
            if single_lot_geometry_result["status"] == "success":
                 any_lot_data_processed_successfully = True
            
    return any_lot_data_processed_successfully

# --- Shapefile Specific Lot Handler ---


def _shapefile_lot_handler(lot_id, lot_name, geometry_result, context):
    """
    Handles a single lot's geometry data for Shapefile export.

    Adds geometries (POB, tie-line, parcel) to the appropriate lists in the
    `gdfs` dictionary within the `context`.

    Args:
        lot_id (str): The ID of the lot.
        lot_name (str): The name of the lot.
        geometry_result (dict): The result from _calculate_single_lot_geometry.
        context (dict): Context dictionary containing 'gdfs' and 'target_crs_epsg_int'.

    Returns:
        bool: True if data was successfully added for this lot, False otherwise.
    """
    if geometry_result["status"] != "success":
        # Message from geometry_result is already quite specific for this lot.
        current_app.logger.error(
            f"Shapefile: Cannot export Lot '{lot_name}': {geometry_result.get('message')}"
        )
        return False # Did not add data

    gdfs = context['gdfs']
    # target_crs_epsg_int = context['target_crs_epsg_int'] # CRS is set when GDF is created
    lot_proj_data = geometry_result["projected"]
    data_added = False

    if lot_proj_data.get("pob_en"):
        pob_e, pob_n = lot_proj_data["pob_en"]
        gdfs["all_points_of_beginning_geom"].append(Point(pob_e, pob_n))
        gdfs["all_points_of_beginning_attrs"].append({"LotName": lot_name, "Type": "POB", "Easting": f"{pob_e:.3f}", "Northing": f"{pob_n:.3f}"})
        data_added = True

    if lot_proj_data.get("tie_line_ens") and len(lot_proj_data["tie_line_ens"]) == 2:
        try:
            tie_line_geom = LineString(lot_proj_data["tie_line_ens"])
            gdfs["all_tie_lines_geom"].append(tie_line_geom)
            gdfs["all_tie_lines_attrs"].append({"LotName": lot_name, "Length_m": f"{tie_line_geom.length:.2f}"})
            data_added = True
        except Exception as e: current_app.logger.error(f"Shapefile: Error creating Tie-Line GDF for Lot '{lot_name}': {str(e)}", exc_info=True)
    
    parcel_ens = lot_proj_data.get("parcel_boundary_ens", [])
    if len(parcel_ens) >= 3: # Need at least 3 points for a polygon or meaningful linestring
        is_closed_polygon = len(parcel_ens) >= 4 and parcel_ens[0] == parcel_ens[-1]
        if is_closed_polygon:
            try:
                poly_geom = Polygon(parcel_ens)
                if poly_geom.is_valid and not poly_geom.is_empty:
                    gdfs["all_parcel_polygons_geom"].append(poly_geom)
                    gdfs["all_parcel_polygons_attrs"].append({"LotName": lot_name, "Area_sqm": f"{poly_geom.area:.2f}", "Perim_m": f"{poly_geom.length:.2f}"})
                    data_added = True
                else: 
                    gdfs["all_parcel_linestrings_geom"].append(LineString(parcel_ens)) # Fallback for invalid polygon
                    gdfs["all_parcel_linestrings_attrs"].append({"LotName": lot_name, "Type": "Invalid Polygon"})
                    data_added = True
            except Exception as e: current_app.logger.error(f"Shapefile: Error creating Parcel Polygon GDF for Lot '{lot_name}': {str(e)}", exc_info=True)
        elif len(parcel_ens) > 1 : # Open linestring
            try:
                gdfs["all_parcel_linestrings_geom"].append(LineString(parcel_ens))
                gdfs["all_parcel_linestrings_attrs"].append({"LotName": lot_name, "Type": "Open Lines"})
                data_added = True
            except Exception as e: current_app.logger.error(f"Shapefile: Error creating Parcel LineString GDF for Lot '{lot_name}': {str(e)}", exc_info=True)
    return data_added

@app.route('/export_shapefile_multi', methods=['POST'])
@limiter.limit("5 per minute;20 per hour")
def export_shapefile_multi():
    """Exports survey data for multiple lots as a zipped collection of Shapefiles."""
    # current_app is now imported at module level
    request_json_data = request.get_json()
    if not request_json_data:
        return jsonify({"status": "error", "message": "No JSON data provided."}), 400

    export_params, error_response_tuple = _prepare_export_data_for_routes(
        request_json_data, "Shapefile"
    )
    if error_response_tuple:
        # error_response_tuple is (None, (jsonify_object, status_code))
        return error_response_tuple[1]
    # No JSON data provided. (Handled by initial check)
    # Error from _prepare_export_data_for_routes (Handled by error_response_tuple)

    transformer_to_latlon = export_params["transformer_to_latlon"]
    main_ref_e = export_params["main_ref_e"]
    main_ref_n = export_params["main_ref_n"]
    lots_data_from_payload = export_params["lots_data"]
    selected_display_name = export_params["selected_display_name"]
    target_crs_epsg_int = export_params["target_crs_epsg_int"] # Already validated int

    # Initialize GDF structures
    gdfs_data_accumulator = {
        "main_reference_monument_geom": [], "main_reference_monument_attrs": [],
        "all_points_of_beginning_geom": [], "all_points_of_beginning_attrs": [],
        "all_tie_lines_geom": [], "all_tie_lines_attrs": [],
        "all_parcel_polygons_geom": [], "all_parcel_polygons_attrs": [],
        "all_parcel_linestrings_geom": [], "all_parcel_linestrings_attrs": []
    }
    
    has_main_ref_data = False
    if main_ref_e is not None and main_ref_n is not None:
        gdfs_data_accumulator["main_reference_monument_geom"].append(Point(main_ref_e, main_ref_n))
        gdfs_data_accumulator["main_reference_monument_attrs"].append({
            "Name": "Reference Monument", "Type": "REF_MON", 
            "Easting": f"{main_ref_e:.3f}", "Northing": f"{main_ref_n:.3f}"
        })
        has_main_ref_data = True

    shapefile_processing_context = {
        'gdfs': gdfs_data_accumulator,
        'target_crs_epsg_int': target_crs_epsg_int
    }
    
    has_valid_lot_data_for_export = _process_lots_for_export(
        lots_data_from_payload, transformer_to_latlon, main_ref_e, main_ref_n,
        _shapefile_lot_handler, shapefile_processing_context, "Shapefile"
    )

    if not has_main_ref_data and not has_valid_lot_data_for_export:
         return jsonify({"status": "error", "message": "No valid reference point or lot geometric data available to export for Shapefile."}), 400

    final_gdfs = {}
    if gdfs_data_accumulator["main_reference_monument_geom"]:
        final_gdfs["main_reference_monument"] = gpd.GeoDataFrame(gdfs_data_accumulator["main_reference_monument_attrs"], geometry=gdfs_data_accumulator["main_reference_monument_geom"], crs=f"EPSG:{target_crs_epsg_int}")
    if gdfs_data_accumulator["all_points_of_beginning_geom"]:
        final_gdfs["all_points_of_beginning"] = gpd.GeoDataFrame(gdfs_data_accumulator["all_points_of_beginning_attrs"], geometry=gdfs_data_accumulator["all_points_of_beginning_geom"], crs=f"EPSG:{target_crs_epsg_int}")
    if gdfs_data_accumulator["all_tie_lines_geom"]:
        final_gdfs["all_tie_lines"] = gpd.GeoDataFrame(gdfs_data_accumulator["all_tie_lines_attrs"], geometry=gdfs_data_accumulator["all_tie_lines_geom"], crs=f"EPSG:{target_crs_epsg_int}")
    if gdfs_data_accumulator["all_parcel_polygons_geom"]:
        final_gdfs["all_parcel_polygons"] = gpd.GeoDataFrame(gdfs_data_accumulator["all_parcel_polygons_attrs"], geometry=gdfs_data_accumulator["all_parcel_polygons_geom"], crs=f"EPSG:{target_crs_epsg_int}")
    if gdfs_data_accumulator["all_parcel_linestrings_geom"]:
        final_gdfs["all_parcel_linestrings"] = gpd.GeoDataFrame(gdfs_data_accumulator["all_parcel_linestrings_attrs"], geometry=gdfs_data_accumulator["all_parcel_linestrings_geom"], crs=f"EPSG:{target_crs_epsg_int}")

    if not final_gdfs: # If after accumulation, no GDFs were populated
        return jsonify({"status": "error", "message": "No geometric data could be generated for Shapefile export (possibly all lots had errors or were empty)."}), 400
        
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            files_written = False
            for layer_name, gdf_layer in final_gdfs.items():
                if not gdf_layer.empty:
                    shp_filename = f"{layer_name}.shp" 
                    gdf_layer.to_file(os.path.join(tmpdir, shp_filename), driver='ESRI Shapefile', encoding='utf-8')
                    files_written = True
            
            if not files_written: 
                 return jsonify({"status": "error", "message": "No shapefiles were generated (it's possible all lots had errors, were empty, or only an empty reference point was provided)."}), 400

            zip_buffer = io.BytesIO()
            with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
                for item in os.listdir(tmpdir):
                    zf.write(os.path.join(tmpdir, item), arcname=item)
            zip_buffer.seek(0)
    except Exception as e:
        current_app.logger.error(f"Error during multi-lot Shapefile creation/zipping: {str(e)}", exc_info=True)
        return jsonify({"status": "error", "message": "A server error occurred while generating the Shapefile. Please try again later or contact support."}), 500
    
    filename_base = get_sanitized_filename_base(selected_display_name)
    download_filename = f'{filename_base}_epsg{export_params["target_crs_epsg_str"]}_multi_lot_shapefiles.zip'
    return send_file(zip_buffer, download_name=download_filename, as_attachment=True, mimetype='application/zip')

# --- KMZ Specific Lot Handler ---


def _kmz_lot_handler(lot_id, lot_name, geometry_result, context):
    """Handles a single lot's geometry data for KMZ export."""
    project_folder = context['project_folder']
    target_crs_epsg_str = context['target_crs_epsg_str']
    main_ref_lon_kml = context.get('main_ref_lon_kml') 
    main_ref_lat_kml = context.get('main_ref_lat_kml')

    # current_app is now imported at module level
    if geometry_result["status"] != "success":
        current_app.logger.error(
            f"KMZ: Cannot include Lot '{lot_name}' due to error: "
            f"{geometry_result.get('message')}"
        )
        error_pnt = project_folder.newpoint(name=f"Error: Lot {lot_name}")
        error_pnt.description = (
            f"Could not generate geometry for Lot {lot_name}.\n"
            f"Error: {geometry_result.get('message')}"
        )
        
        pob_latlon = geometry_result.get("latlon", {}).get("pob_latlng")
        if pob_latlon:
             error_pnt.coords = [(pob_latlon[1], pob_latlon[0])]  # lon, lat
        elif main_ref_lon_kml and main_ref_lat_kml:
             error_pnt.coords = [(main_ref_lon_kml, main_ref_lat_kml)]
        error_pnt.style.iconstyle.icon.href = (
            'http://maps.google.com/mapfiles/kml/paddle/blu-blank.png'
        )
        return True  # Error marker was added

    lot_kml_folder = project_folder.newfolder(name=lot_name)
    lot_proj_data = geometry_result["projected"]
    lot_latlon_data = geometry_result["latlon"]
    pob_lon_kml, pob_lat_kml = None, None 

    if lot_latlon_data.get("pob_latlng"):
        pob_lat_kml, pob_lon_kml = lot_latlon_data["pob_latlng"]
        pob_e_desc, pob_n_desc = lot_proj_data["pob_en"]
        pnt_pob = lot_kml_folder.newpoint(
            name="POB", coords=[(pob_lon_kml, pob_lat_kml)]
        )
        pnt_pob.description = (
            f"Lat: {pob_lat_kml:.7f}, Lon: {pob_lon_kml:.7f}\n"
            f"Easting: {pob_e_desc:.3f}, Northing: {pob_n_desc:.3f} "
            f"(EPSG:{target_crs_epsg_str})"
        )
        pnt_pob.style.iconstyle.icon.href = (
            'http://maps.google.com/mapfiles/kml/paddle/grn-circle.png'
        )
    
    if (lot_latlon_data.get("tie_line_latlngs") and 
            len(lot_latlon_data["tie_line_latlngs"]) == 2):
        kml_tie_coords = [
            (ll[1], ll[0]) for ll in lot_latlon_data["tie_line_latlngs"]
        ] 
        ls_tie = lot_kml_folder.newlinestring(name="Tie-Line", coords=kml_tie_coords)
        ls_tie.style.linestyle.color = simplekml.Color.red
        ls_tie.style.linestyle.width = 2
        ls_tie.altitudemode = simplekml.AltitudeMode.clamptoground

    parcel_latlng_list = lot_latlon_data.get("parcel_polygon_latlngs", [])
    parcel_en_list = lot_proj_data.get("parcel_boundary_ens", [])
    
    if parcel_latlng_list:
        vertex_subfolder = lot_kml_folder.newfolder(name="Vertices")
        points_to_mark_kml_lot = parcel_latlng_list
        if (len(parcel_latlng_list) > 1 and 
                parcel_latlng_list[0] == parcel_latlng_list[-1]):
            points_to_mark_kml_lot = parcel_latlng_list[:-1]

        for i, (v_lat, v_lon) in enumerate(points_to_mark_kml_lot):
            is_pob_vertex = False
            if (pob_lon_kml and pob_lat_kml and 
                    abs(v_lon - pob_lon_kml) < 1e-7 and 
                    abs(v_lat - pob_lat_kml) < 1e-7):
                is_pob_vertex = True
            if is_pob_vertex:
                continue 

            v_name = f"Vertex {i + 1}"
            try:
                v_e_desc, v_n_desc = parcel_en_list[i]
            except IndexError:
                v_e_desc, v_n_desc = "N/A", "N/A"
            
            pnt_v = vertex_subfolder.newpoint(name=v_name, coords=[(v_lon, v_lat)])
            pnt_v.description = (
                f"Lat: {v_lat:.7f}, Lon: {v_lon:.7f}\n"
                f"Easting: {v_e_desc:.3f}, Northing: {v_n_desc:.3f} "
                f"(EPSG:{target_crs_epsg_str})"
            )
            pnt_v.style.iconstyle.icon.href = (
                'http://maps.google.com/mapfiles/kml/paddle/ylw-diamond.png'
            )
            pnt_v.style.iconstyle.scale = 0.8
        
        kml_parcel_boundary_coords = [(lon, lat) for lat, lon in parcel_latlng_list]
        if len(kml_parcel_boundary_coords) >= 2:
            is_closed_lot = (len(kml_parcel_boundary_coords) >= 4 and
                             kml_parcel_boundary_coords[0] == kml_parcel_boundary_coords[-1])
            if is_closed_lot:
                poly = lot_kml_folder.newpolygon(name="Parcel Boundary")
                poly.outerboundaryis = kml_parcel_boundary_coords
                poly.style.polystyle.color = simplekml.Color.changealphaint(
                    100, simplekml.Color.blue
                ) 
                poly.style.linestyle.color = simplekml.Color.blue
                poly.style.linestyle.width = 3
                poly.altitudemode = simplekml.AltitudeMode.clamptoground
            else:
                ls_parcel = lot_kml_folder.newlinestring(
                    name="Parcel Boundary (Lines)",
                    coords=kml_parcel_boundary_coords
                )
                ls_parcel.style.linestyle.color = simplekml.Color.blue
                ls_parcel.style.linestyle.width = 3
                ls_parcel.altitudemode = simplekml.AltitudeMode.clamptoground
    return True  # Data or error marker was added


@app.route('/export_kmz_multi', methods=['POST'])
@limiter.limit("5 per minute;20 per hour")
def export_kmz_multi():
    """Exports survey data for multiple lots as a KMZ file."""
    # current_app is now imported at module level
    request_json_data = request.get_json()
    if not request_json_data:
        return jsonify({"status": "error", "message": "No JSON data provided."}), 400
    
    export_params, error_response_tuple = _prepare_export_data_for_routes(
        request_json_data, "KMZ"
    )
    if error_response_tuple:
        return error_response_tuple[1]

    transformer_to_latlon = export_params["transformer_to_latlon"]
    main_ref_e = export_params["main_ref_e"]
    main_ref_n = export_params["main_ref_n"]
    main_ref_transformed_lonlat = export_params["main_ref_transformed_lonlat"]
    lots_data_from_payload = export_params["lots_data"]
    selected_display_name = export_params["selected_display_name"]
    target_crs_epsg_str = export_params["target_crs_epsg_str"]

    kml = simplekml.Kml(name=f"Multi-Lot Survey - {selected_display_name or 'Export'}")
    project_folder = kml.newfolder(name=f"Project Data (EPSG:{target_crs_epsg_str})")

    ref_lon_main_kml, ref_lat_main_kml = None, None
    has_main_ref_kml_data = False
    if main_ref_transformed_lonlat and main_ref_e is not None: # Ensure ref point was selected and valid
        ref_lon_main_kml, ref_lat_main_kml = main_ref_transformed_lonlat
        pnt_main_ref = project_folder.newpoint(name="Reference Monument (Main)", coords=[(ref_lon_main_kml, ref_lat_main_kml)])
        pnt_main_ref.description = (f"Lat: {ref_lat_main_kml:.7f}, Lon: {ref_lon_main_kml:.7f}\n"
                                    f"Easting: {main_ref_e:.3f}, Northing: {main_ref_n:.3f} (EPSG:{target_crs_epsg_str})")
        pnt_main_ref.style.iconstyle.icon.href = 'http://maps.google.com/mapfiles/kml/paddle/red-stars.png' 
        pnt_main_ref.style.iconstyle.scale = 1.2
        has_main_ref_kml_data = True
    
    kmz_processing_context = {
        'project_folder': project_folder,
        'target_crs_epsg_str': target_crs_epsg_str,
        'main_ref_lon_kml': ref_lon_main_kml, 
        'main_ref_lat_kml': ref_lat_main_kml
    }
    
    has_any_successful_kmz_lot_data = _process_lots_for_export(
        lots_data_from_payload, transformer_to_latlon, main_ref_e, main_ref_n,
        _kmz_lot_handler, kmz_processing_context, "KMZ"
    )
    
    if not has_main_ref_kml_data and not has_any_successful_kmz_lot_data: 
        # Check if any lot handler returned true (even for error points)
        # The _process_lots_for_export returns based on SUCCESS status.
        # A more nuanced check might be needed if error points alone are sufficient for KMZ export
        # For now, assume we need either main ref OR successful lot geometry.
        # If lots_data_from_payload was empty, has_any_successful_kmz_lot_data is False.
        # If lots were processed but all failed with no error markers, it's also False.
        # If lots processed and error markers were added, KMZ handler returns True for those,
        # but _process_lots_for_export returns based on "success" status of geometry calculation.
        # A more nuanced check might be needed if error points alone are sufficient for KMZ export
        # For KMZ, even if lots fail but error markers are added, it might be a valid export.
        if not project_folder.features: # No features (ref point or lot data/errors) added
            return jsonify({"status": "error", "message": "No data (including error markers) could be generated for KMZ export."}), 400

    kmz_buffer = io.BytesIO()
    try:
        kml.savekmz(kmz_buffer) 
        kmz_buffer.seek(0)
    except Exception as e:
        current_app.logger.error(f"Error during multi-lot KMZ creation: {str(e)}", exc_info=True)
        return jsonify({"status": "error", "message": "A server error occurred while generating the KMZ file. Please try again later or contact support."}), 500

    filename_base = get_sanitized_filename_base(selected_display_name)
    download_filename = f'{filename_base}_epsg{target_crs_epsg_str}_multi_lot_survey.kmz'
    return send_file(kmz_buffer, download_name=download_filename, as_attachment=True, mimetype='application/vnd.google-earth.kmz')

# --- DXF Specific Lot Handler ---
def _dxf_lot_handler(lot_id, lot_name, geometry_result, context):
    # current_app is now imported at module level
    if geometry_result["status"] != "success":
        current_app.logger.error(f"DXF: Cannot include Lot '{lot_name}' due to error: {geometry_result.get('message')}")
        return False

    msp = context['msp']
    # doc = context['doc'] # If needed for dynamic layer creation, pass from main func
    text_height = context['text_height']
    lot_proj_data = geometry_result["projected"]
    data_added = False

    if lot_proj_data.get("pob_en"):
        pob_e, pob_n = lot_proj_data["pob_en"]
        msp.add_point((pob_e, pob_n), dxfattribs={'layer': "POB"})
        msp.add_text(
            f"POB {lot_name}",
            dxfattribs={'layer': "LABELS", 'height': text_height * 0.7}
        ).set_placement((pob_e + text_height, pob_n), align=TextEntityAlignment.BOTTOM_LEFT)
        data_added = True

    if lot_proj_data.get("tie_line_ens") and len(lot_proj_data["tie_line_ens"]) == 2:
        start_pt, end_pt = lot_proj_data["tie_line_ens"]
        msp.add_line(start_pt, end_pt, dxfattribs={'layer': "TIE_LINES"})
        data_added = True

    parcel_ens = lot_proj_data.get("parcel_boundary_ens", [])
    if parcel_ens:
        parcel_layer_name = "PARCEL_BOUNDARIES"
        is_closed = len(parcel_ens) >= 3 and parcel_ens[0] == parcel_ens[-1]
        msp.add_lwpolyline(parcel_ens, dxfattribs={'layer': parcel_layer_name, 'flags': 1 if is_closed else 0})
        data_added = True

        text_loc_e, text_loc_n = lot_proj_data.get("pob_en") or parcel_ens[0]
        msp.add_text(
            lot_name,
            dxfattribs={'layer': "LOT_NAMES", 'height': text_height}
        ).set_placement((text_loc_e, text_loc_n - text_height * 2), align=TextEntityAlignment.TOP_CENTER)
    return data_added

@app.route('/export_dxf_multi', methods=['POST'])
@limiter.limit("5 per minute;20 per hour")
def export_dxf_multi():
    # current_app is now imported at module level
    request_json_data = request.get_json()
    if not request_json_data: return jsonify({"status": "error", "message": "No JSON data provided."}), 400

    export_params, error_response_tuple = _prepare_export_data_for_routes(request_json_data, "DXF")
    if error_response_tuple: return error_response_tuple[1]

    transformer_to_latlon = export_params["transformer_to_latlon"] # Not used by DXF entities, but by _calc
    main_ref_e = export_params["main_ref_e"]
    main_ref_n = export_params["main_ref_n"]
    lots_data_from_payload = export_params["lots_data"]
    selected_display_name = export_params["selected_display_name"]
    target_crs_epsg_str = export_params["target_crs_epsg_str"]

    try:
        doc = ezdxf.new('R2010') # Explicitly set encoding if desired: doc.encoding = 'utf-8'
        msp = doc.modelspace()

        doc.layers.add(name="REF_MONUMENT", color=1)
        doc.layers.add(name="POB", color=3)
        doc.layers.add(name="TIE_LINES", color=6)
        doc.layers.add(name="PARCEL_BOUNDARIES", color=5)
        doc.layers.add(name="LOT_NAMES", color=2)
        doc.layers.add(name="LABELS", color=7)

        text_height = 0.5 
        has_main_ref_dxf_data = False
        if main_ref_e is not None and main_ref_n is not None:
            msp.add_point((main_ref_e, main_ref_n), dxfattribs={'layer': "REF_MONUMENT"})
            msp.add_text(
                f"REF: {selected_display_name}",
                dxfattribs={'layer': "LABELS", 'height': text_height * 0.8}
            ).set_placement((main_ref_e + text_height, main_ref_n + text_height), align=TextEntityAlignment.MIDDLE_LEFT)
            has_main_ref_dxf_data = True

        dxf_processing_context = {'msp': msp, 'doc': doc, 'text_height': text_height}
        has_any_successful_dxf_lot_data = _process_lots_for_export(
            lots_data_from_payload, transformer_to_latlon, main_ref_e, main_ref_n,
            _dxf_lot_handler, dxf_processing_context, "DXF"
        )

        if not has_main_ref_dxf_data and not has_any_successful_dxf_lot_data:
            return jsonify({"status": "error", "message": "No valid reference point or lot geometric data available to export for DXF."}), 400

        string_io_buffer = io.StringIO()
        doc.write(string_io_buffer)
        string_io_buffer.seek(0)
        dxf_string_data = string_io_buffer.read()
        dxf_bytes_data = dxf_string_data.encode(doc.encoding) # Default 'cp1252' or 'utf-8' if set
        dxf_binary_buffer_for_send_file = io.BytesIO(dxf_bytes_data)

    except ImportError: # ezdxf not installed
        current_app.logger.error("DXF Export Error: ezdxf library is not installed.")
        return jsonify({"status": "error", "message": "A required server library (ezdxf) for DXF export is not available. Please contact support."}), 500
    except Exception as e:
        current_app.logger.error(f"Error during multi-lot DXF creation: {str(e)}", exc_info=True)
        return jsonify({"status": "error", "message": "A server error occurred while generating the DXF file. Please try again later or contact support."}), 500

    filename_base = get_sanitized_filename_base(selected_display_name)
    download_filename = f'{filename_base}_epsg{target_crs_epsg_str}_multi_lot_survey.dxf'
    return send_file(dxf_binary_buffer_for_send_file, download_name=download_filename, as_attachment=True, mimetype='application/dxf')

# --- GeoJSON Specific Lot Handler ---
def _geojson_lot_handler(lot_id, lot_name, geometry_result, context):
    # current_app is now imported at module level
    if geometry_result["status"] != "success":
        current_app.logger.error(f"GeoJSON: Cannot include Lot '{lot_name}' due to error: {geometry_result.get('message')}")
        return False

    features = context['features']
    target_crs_epsg_str = context['target_crs_epsg_str']
    lot_latlon_data = geometry_result["latlon"]
    lot_proj_data = geometry_result["projected"] 
    data_added = False

    if lot_latlon_data.get("pob_latlng") and lot_proj_data.get("pob_en"):
        pob_lat, pob_lon = lot_latlon_data["pob_latlng"]
        pob_e, pob_n = lot_proj_data["pob_en"]
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [pob_lon, pob_lat]},
            "properties": {
                "name": f"POB - {lot_name}", "lotName": lot_name, "type": "POB",
                "easting": pob_e, "northing": pob_n, "crs": f"EPSG:{target_crs_epsg_str}"
            }
        })
        data_added = True

    if lot_latlon_data.get("tie_line_latlngs") and len(lot_latlon_data["tie_line_latlngs"]) == 2:
        tie_line_coords_lonlat = [[ll[1], ll[0]] for ll in lot_latlon_data["tie_line_latlngs"]]
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": tie_line_coords_lonlat},
            "properties": {"name": f"Tie-Line - {lot_name}", "lotName": lot_name, "type": "TIE_LINE"}
        })
        data_added = True

    parcel_latlng_list = lot_latlon_data.get("parcel_polygon_latlngs", [])
    if parcel_latlng_list:
        parcel_coords_lonlat = [[lon, lat] for lat, lon in parcel_latlng_list]
        # Ensure at least 2 points for LineString, 4 for Polygon (3 unique + close)
        geom_type = "Polygon" if len(parcel_coords_lonlat) >= 4 and parcel_coords_lonlat[0] == parcel_coords_lonlat[-1] else "LineString"
        
        if geom_type == "LineString" and len(parcel_coords_lonlat) < 2:
            current_app.logger.warning(f"GeoJSON: Lot '{lot_name}' parcel has < 2 points, cannot form LineString. Skipping this geometry.")
        else:
            geometry_data = {"type": geom_type, "coordinates": [parcel_coords_lonlat] if geom_type == "Polygon" else parcel_coords_lonlat}
            features.append({
                "type": "Feature",
                "geometry": geometry_data,
                "properties": {"name": f"Parcel - {lot_name}", "lotName": lot_name, "type": "PARCEL_BOUNDARY"}
            })
            data_added = True
    return data_added

@app.route('/export_geojson_multi', methods=['POST'])
@limiter.limit("5 per minute;20 per hour")
def export_geojson_multi():
    # current_app is now imported at module level
    request_json_data = request.get_json()
    if not request_json_data: return jsonify({"status": "error", "message": "No JSON data provided."}), 400

    export_params, error_response_tuple = _prepare_export_data_for_routes(request_json_data, "GeoJSON")
    if error_response_tuple: return error_response_tuple[1]

    transformer_to_latlon = export_params["transformer_to_latlon"]
    main_ref_e = export_params["main_ref_e"]
    main_ref_n = export_params["main_ref_n"]
    main_ref_transformed_lonlat = export_params["main_ref_transformed_lonlat"]
    lots_data_from_payload = export_params["lots_data"]
    selected_display_name = export_params["selected_display_name"]
    target_crs_epsg_str = export_params["target_crs_epsg_str"]

    features = []
    has_main_ref_geojson_data = False
    if main_ref_transformed_lonlat and main_ref_e is not None:
        ref_lon, ref_lat = main_ref_transformed_lonlat
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [ref_lon, ref_lat]},
            "properties": {
                "name": "Reference Monument", "displayName": selected_display_name,
                "type": "REF_MONUMENT", "easting": main_ref_e, "northing": main_ref_n,
                "crs": f"EPSG:{target_crs_epsg_str}"
            }
        })
        has_main_ref_geojson_data = True
    
    geojson_processing_context = {'features': features, 'target_crs_epsg_str': target_crs_epsg_str}
    has_any_successful_geojson_lot_data = _process_lots_for_export(
        lots_data_from_payload, transformer_to_latlon, main_ref_e, main_ref_n,
        _geojson_lot_handler, geojson_processing_context, "GeoJSON"
    )
            
    if not has_main_ref_geojson_data and not has_any_successful_geojson_lot_data:
        return jsonify({"status": "error", "message": "No valid reference point or lot geometric data available to export for GeoJSON."}), 400

    geojson_output = {"type": "FeatureCollection", "features": features}
    geojson_str = json.dumps(geojson_output, indent=2)
    geojson_buffer = io.BytesIO(geojson_str.encode('utf-8'))
    
    filename_base = get_sanitized_filename_base(selected_display_name)
    download_filename = f'{filename_base}_epsg{target_crs_epsg_str}_multi_lot_survey.geojson'
    
    return send_file(geojson_buffer, download_name=download_filename, as_attachment=True, mimetype='application/geo+json')

if __name__ == '__main__':

    app.run(debug=False, host='0.0.0.0', port=80)
