from flask import Flask, render_template, request, jsonify, send_file
from flask_caching import Cache
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from ezdxf.enums import TextEntityAlignment
from pyproj import CRS, Transformer, Proj
from pyproj.exceptions import CRSError
from shapely.geometry import Point, LineString, Polygon
from dotenv import load_dotenv
import ezdxf
import pandas as pd
import io
import os
import re
import json
import math
import geopandas as gpd
import zipfile
import tempfile
import simplekml

load_dotenv()

app = Flask(__name__)
SECRET_KEY = os.getenv("FLASK_SECRET_KEY")
app.secret_key = SECRET_KEY
limiter = Limiter(
    get_remote_address, # Key by remote IP address
    app=app,
    default_limits=["200 per day", "50 per hour"], # Default for routes not otherwise limited
    storage_uri="memory://", # Use in-memory storage (no external dependency like Redis)
    # strategy="fixed-window" # Default, can also be "moving-window", etc.
)

config = {
    "DEBUG": True,
    "CACHE_TYPE": "SimpleCache",
    "CACHE_DEFAULT_TIMEOUT": 3600
}
app.config.from_mapping(config)
cache = Cache(app)

RIZAL_CSV_PATH = os.path.join(app.root_path, 'rizal.csv')

DEFAULT_TARGET_CRS_EPSG = 25393
CRS_LATLON_EPSG = 4326

_transformer_cache = {}

def get_transformers(target_crs_epsg_str):
    try:
        target_crs_epsg = int(target_crs_epsg_str)
    except ValueError:
        msg = f"Invalid Target CRS EPSG (must be integer): {target_crs_epsg_str}"
        app.logger.error(msg)
        return None, None, msg

    if target_crs_epsg in _transformer_cache:
        app.logger.debug(f"Using cached transformer for EPSG:{target_crs_epsg}")
        cached_to_latlon, cached_to_projected = _transformer_cache[target_crs_epsg]
        return cached_to_latlon, cached_to_projected, None

    try:
        crs_projected = CRS.from_epsg(target_crs_epsg)
        crs_latlon = CRS.from_epsg(CRS_LATLON_EPSG)
        
        transformer_to_latlon = Transformer.from_crs(crs_projected, crs_latlon, always_xy=True)
        transformer_to_projected = Transformer.from_crs(crs_latlon, crs_projected, always_xy=True)
        
        _transformer_cache[target_crs_epsg] = (transformer_to_latlon, transformer_to_projected)
        app.logger.info(f"Created and cached new transformer for EPSG:{target_crs_epsg}")
        return transformer_to_latlon, transformer_to_projected, None
    except CRSError as e:
        msg = f"Invalid or unsupported Target CRS EPSG: {target_crs_epsg_str}. {str(e)}"
        app.logger.error(msg)
        return None, None, msg
    except Exception as e:
        msg = f"Error initializing pyproj CRS/Transformer for EPSG {target_crs_epsg_str}: {e}"
        app.logger.error(msg)
        return None, None, msg

@cache.cached(timeout=86400)
def load_reference_points():
    app.logger.info(f"Executing load_reference_points() from {RIZAL_CSV_PATH} (cache miss or timeout)")
    try:
        if not os.path.exists(RIZAL_CSV_PATH):
            return [], f"Error: '{os.path.basename(RIZAL_CSV_PATH)}' not found."
        df = pd.read_csv(RIZAL_CSV_PATH, encoding='utf-8-sig', on_bad_lines='warn')
        location_col, point_col, easting_col, northing_col = 'LOCATION', 'POINT_OF_REFERENCE', 'EASTINGS', 'NORTHINGS'
        required_csv_cols = {location_col, point_col, easting_col, northing_col}
        if not required_csv_cols.issubset(df.columns):
            return [], f"Error: CSV missing columns: {', '.join(required_csv_cols - set(df.columns))}"

        df = df[list(required_csv_cols)].copy()
        df.dropna(subset=[location_col, point_col, easting_col, northing_col], inplace=True)
        for col in [location_col, point_col, easting_col, northing_col]:
            df[col] = df[col].astype(str).str.strip()
            df = df[~df[col].isin(['', '#REF!'])]
            df = df[df[col].str.len() > 0]
        if df.empty: return [], "Warning: No valid data rows in CSV after initial cleaning."

        df[easting_col] = df[easting_col].str.replace(',', '', regex=False)
        df[northing_col] = df[northing_col].str.replace(',', '', regex=False)
        df[easting_col] = pd.to_numeric(df[easting_col], errors='coerce')
        df[northing_col] = pd.to_numeric(df[northing_col], errors='coerce')
        df.dropna(subset=[easting_col, northing_col], inplace=True)
        if df.empty: return [], "Warning: No points with valid numeric coordinates found."

        df['display_name'] = df[location_col] + " - " + df[point_col]
        df.drop_duplicates(subset=['display_name'], keep='first', inplace=True)
        df.sort_values(by='display_name', inplace=True)
        return df[['display_name', 'EASTINGS', 'NORTHINGS']].to_dict('records'), None
    except pd.errors.EmptyDataError:
        return [], f"Error: '{os.path.basename(RIZAL_CSV_PATH)}' is empty."
    except Exception as e:
        return [], f"Critical error processing '{os.path.basename(RIZAL_CSV_PATH)}': {str(e)}"


def parse_survey_line_to_bearing_distance(line_str):
    parts = line_str.split(';')
    if len(parts) < 2:
        app.logger.warning(f"Invalid survey line (not enough parts): {line_str}"); return None
    try:
        distance = float(parts[1].strip())
        if distance <= 0: app.logger.warning(f"Invalid dist (>0): {distance} in {line_str}"); return None
    except ValueError: app.logger.warning(f"Invalid dist format: {line_str}"); return None
    match = re.match(r'([NS])\s*(\d{1,2})D\s*(\d{1,2})[′\']\s*([EW])', parts[0].strip(), re.IGNORECASE)
    if not match: app.logger.warning(f"Invalid bearing: {parts[0]} in {line_str}"); return None
    ns, deg_str, min_str, ew = match.groups()
    deg, min_val = int(deg_str), int(min_str)
    if not (0 <= deg <= 89): app.logger.warning(f"Invalid deg (0-89): {deg} in {line_str}"); return None
    if not (0 <= min_val <= 59): app.logger.warning(f"Invalid min (0-59): {min_val} in {line_str}"); return None
    return {'ns': ns.upper(), 'deg': deg, 'min': min_val, 'ew': ew.upper(), 'distance': distance}

def calculate_azimuth(bearing_info):
    dec_deg = bearing_info['deg'] + (bearing_info['min'] / 60.0)
    if bearing_info['ns'] == 'N' and bearing_info['ew'] == 'E': return dec_deg
    if bearing_info['ns'] == 'S' and bearing_info['ew'] == 'E': return 180.0 - dec_deg
    if bearing_info['ns'] == 'S' and bearing_info['ew'] == 'W': return 180.0 + dec_deg
    if bearing_info['ns'] == 'N' and bearing_info['ew'] == 'W': return 360.0 - dec_deg
    app.logger.error(f"Cannot determine azimuth: {bearing_info}"); return None

def calculate_new_coordinates(e_start, n_start, azimuth_deg, distance):
    az_rad = math.radians(azimuth_deg)
    return e_start + distance * math.sin(az_rad), n_start + distance * math.cos(az_rad)

def _calculate_single_lot_geometry(transformer_to_latlon, ref_e, ref_n, survey_lines_text_for_lot, lot_id="unknown", lot_name="Unknown Lot"):
    lot_proj_coords = {"pob_en": None, "tie_line_ens": [], "parcel_boundary_ens": []}
    lot_latlon_coords = {"pob_latlng": None, "tie_line_latlngs": [], "parcel_polygon_latlngs": []}
    
    current_e, current_n = ref_e, ref_n

    survey_lines = [line for line in survey_lines_text_for_lot.splitlines() if line.strip()]

    if not survey_lines:
        return {
            "status": "nodata", 
            "lot_id": lot_id,
            "lot_name": lot_name,
            "projected": lot_proj_coords,
            "latlon": lot_latlon_coords,
            "message": f"Lot '{lot_name}' has no survey lines."
        }

    first_line_data = parse_survey_line_to_bearing_distance(survey_lines[0])
    if not first_line_data:
        return {"status": "error", "lot_id": lot_id, "lot_name": lot_name, "message": f"Lot '{lot_name}': Invalid line 1: {survey_lines[0]}"}
    
    azimuth = calculate_azimuth(first_line_data)
    if azimuth is None:
        return {"status": "error", "lot_id": lot_id, "lot_name": lot_name, "message": f"Lot '{lot_name}': Azimuth error line 1: {survey_lines[0]}"}

    pob_e, pob_n = calculate_new_coordinates(current_e, current_n, azimuth, first_line_data['distance'])
    lot_proj_coords["pob_en"] = (pob_e, pob_n)
    lot_proj_coords["tie_line_ens"] = [(current_e, current_n), (pob_e, pob_n)] 
    lot_proj_coords["parcel_boundary_ens"].append((pob_e, pob_n))

    try:
        if transformer_to_latlon: # Ensure transformer exists
            ref_lon_main, ref_lat_main = transformer_to_latlon.transform(ref_e, ref_n)
            pob_lon, pob_lat = transformer_to_latlon.transform(pob_e, pob_n)
            lot_latlon_coords["pob_latlng"] = [pob_lat, pob_lon]
            lot_latlon_coords["tie_line_latlngs"] = [[ref_lat_main, ref_lon_main], [pob_lat, pob_lon]]
            lot_latlon_coords["parcel_polygon_latlngs"].append([pob_lat, pob_lon])
        else: # Should not happen if prepare_export_data logic is sound, but defensive
            app.logger.warning(f"Lot '{lot_name}': Transformer to Lat/Lon not available for POB.")

    except Exception as e: # Catch specific ProjError if possible, but general Exception for safety
        app.logger.error(f"Lot '{lot_name}': Error transforming POB to Lat/Lon: {str(e)}")
        # Decide if this is a fatal error for the lot or just a warning
        # For now, we'll let it proceed without lat/lon for POB if transformation fails
        # but this could be changed to:
        # return {"status": "error", "lot_id": lot_id, "lot_name": lot_name, "message": f"Lot '{lot_name}': Error transforming POB to Lat/Lon: {str(e)}"}

    current_e, current_n = pob_e, pob_n

    for i, line_str in enumerate(survey_lines[1:], start=2):
        line_data = parse_survey_line_to_bearing_distance(line_str)
        if not line_data:
            return {"status": "error", "lot_id": lot_id, "lot_name": lot_name, "message": f"Lot '{lot_name}': Invalid line {i}: {line_str}"}
        
        azimuth = calculate_azimuth(line_data)
        if azimuth is None:
            return {"status": "error", "lot_id": lot_id, "lot_name": lot_name, "message": f"Lot '{lot_name}': Azimuth error line {i}: {line_str}"}

        next_e, next_n = calculate_new_coordinates(current_e, current_n, azimuth, line_data['distance'])
        lot_proj_coords["parcel_boundary_ens"].append((next_e, next_n))
        try:
            if transformer_to_latlon:
                next_lon, next_lat = transformer_to_latlon.transform(next_e, next_n)
                lot_latlon_coords["parcel_polygon_latlngs"].append([next_lat, next_lon])
            else:
                app.logger.warning(f"Lot '{lot_name}', line {i}: Transformer to Lat/Lon not available.")
        except Exception as e:
             app.logger.error(f"Lot '{lot_name}': Error transforming line {i} coords to Lat/Lon: {str(e)}")
             # Similar to POB, decide if this is fatal for the lot
        current_e, current_n = next_e, next_n
    
    if len(lot_proj_coords["parcel_boundary_ens"]) > 1 and \
       lot_proj_coords["parcel_boundary_ens"][0] != lot_proj_coords["parcel_boundary_ens"][-1]:
        lot_proj_coords["parcel_boundary_ens"].append(lot_proj_coords["parcel_boundary_ens"][0])
        if lot_latlon_coords["parcel_polygon_latlngs"] and \
           len(lot_latlon_coords["parcel_polygon_latlngs"]) > 0 and \
           lot_latlon_coords["parcel_polygon_latlngs"][0] != lot_latlon_coords["parcel_polygon_latlngs"][-1]:
            lot_latlon_coords["parcel_polygon_latlngs"].append(lot_latlon_coords["parcel_polygon_latlngs"][0])
            
    return {
        "status": "success",
        "lot_id": lot_id,
        "lot_name": lot_name,
        "projected": lot_proj_coords,
        "latlon": lot_latlon_coords
    }

@app.route('/')
@limiter.limit("20 per minute")
def index():
    app.logger.info("Index route called.")
    ref_pts, csv_err = load_reference_points()
    return render_template('index.html',
                           reference_points_data=ref_pts,
                           reference_points_data_json=json.dumps(ref_pts),
                           initial_data_lines_json=json.dumps([]),
                           csv_error_message=csv_err if not ref_pts else None,
                           selected_ref_point_name=None)

@app.route('/calculate_plot_data_multi', methods=['POST'])
@limiter.limit("30 per minute;100 per hour")
def calculate_plot_data_multi_endpoint():
    data = request.get_json()
    if not data: return jsonify({"status": "error", "message": "No JSON data."}), 400
    
    target_crs_epsg_str = data.get('target_crs_select', str(DEFAULT_TARGET_CRS_EPSG))
    selected_display_name = data.get('reference_point_select')
    lots_data_from_payload = data.get('lots', [])

    transformer_to_latlon, _, err_msg_transformer = get_transformers(target_crs_epsg_str)
    if err_msg_transformer:
        return jsonify({"status": "error", "message": err_msg_transformer}), 400

    ref_pts_list, csv_err = load_reference_points()
    if csv_err: return jsonify({"status": "error", "message": f"Ref point load error: {csv_err}"}), 500

    if not selected_display_name:
        if not lots_data_from_payload: # No ref point, no lots
             return jsonify({"status": "success", "data_per_lot": [], "reference_plot_data": {"reference_marker_latlng": None}})
        # No ref point, but lots are present - this is an error for calculation
        return jsonify({"status": "error", "message": "Please select a reference point if you have lot data."}), 400
    
    selected_point_details = next((p for p in ref_pts_list if p['display_name'] == selected_display_name), None)
    if not selected_point_details:
        return jsonify({"status": "error", "message": f"Selected reference point '{selected_display_name}' not found."}), 400
    
    try:
        main_ref_e = float(selected_point_details['EASTINGS'])
        main_ref_n = float(selected_point_details['NORTHINGS'])
    except ValueError:
        return jsonify({"status": "error", "message": "Invalid coordinates for the selected main reference point."}), 400

    reference_plot_data = {"reference_marker_latlng": None}
    try:
        if transformer_to_latlon:
            ref_lon, ref_lat = transformer_to_latlon.transform(main_ref_e, main_ref_n)
            reference_plot_data["reference_marker_latlng"] = [ref_lat, ref_lon]
    except Exception as e:
        app.logger.error(f"Error transforming main ref point to Lat/Lon for plotting: {str(e)}")

    results_per_lot = []
    any_lot_had_error = False

    if not lots_data_from_payload: 
         return jsonify({"status": "success", "data_per_lot": [], "reference_plot_data": reference_plot_data})

    for lot_input in lots_data_from_payload:
        lot_id = lot_input.get('id', 'unknown_id')
        lot_name = lot_input.get('name', 'Unnamed Lot')
        lines_text = lot_input.get('lines_text', '')

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
            "plot_data": single_lot_result.get("latlon", {}) 
        })

    overall_status = "success_with_errors" if any_lot_had_error else "success"

    return jsonify({
        "status": overall_status, 
        "data_per_lot": results_per_lot,
        "reference_plot_data": reference_plot_data
    })

def get_sanitized_filename_base(selected_display_name):
    if not selected_display_name: return "survey_export"
    base = re.sub(r'[^\w-]', '', selected_display_name.split(' - ')[0]).strip()[:30]
    return base if base else "export"

# --- Refactored Export Helper Functions ---
def _prepare_export_data_for_routes(request_data, export_format_name):
    target_crs_epsg_str = request_data.get('target_crs_select', str(DEFAULT_TARGET_CRS_EPSG))
    selected_display_name = request_data.get('reference_point_select')
    lots_data_from_payload = request_data.get('lots', [])

    if not selected_display_name and not lots_data_from_payload:
        msg = f"No reference point selected and no lot data to export for {export_format_name}."
        return None, jsonify({"status": "error", "message": msg})

    transformer_to_latlon, _, err_msg_transformer = get_transformers(target_crs_epsg_str)
    if err_msg_transformer:
        return None, jsonify({"status": "error", "message": err_msg_transformer})

    ref_pts_list, csv_err = load_reference_points()
    if csv_err:
        msg = f"Ref point load error: {csv_err}"
        return None, jsonify({"status": "error", "message": msg})

    main_ref_e, main_ref_n = None, None
    main_ref_transformed_lonlat = None

    if selected_display_name:
        selected_point_details = next((p for p in ref_pts_list if p['display_name'] == selected_display_name), None)
        if not selected_point_details:
            msg = f"Ref point '{selected_display_name}' not found."
            return None, jsonify({"status": "error", "message": msg})
        try:
            main_ref_e = float(selected_point_details['EASTINGS'])
            main_ref_n = float(selected_point_details['NORTHINGS'])
            if transformer_to_latlon:
                main_ref_transformed_lonlat = transformer_to_latlon.transform(main_ref_e, main_ref_n)
        except ValueError:
            msg = "Invalid coordinates for the selected main reference point."
            return None, jsonify({"status": "error", "message": msg})
        except Exception as e_tx:
            app.logger.error(f"{export_format_name}: Error transforming main ref point: {e_tx}")
    elif lots_data_from_payload: # No ref point selected, but lot data is present
        msg = f"A reference point must be selected to export lot data to {export_format_name}."
        return None, jsonify({"status": "error", "message": msg})

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
            msg = f"Invalid Target CRS EPSG format for {export_format_name} export."
            return None, jsonify({"status": "error", "message": msg})
            
    return params, None


def _process_lots_for_export(lots_data_payload, transformer_to_latlon, main_ref_e, main_ref_n,
                             lot_data_handler_callback, export_specific_context, export_format_name_logging):
    any_lot_data_processed_successfully = False
    if not lots_data_payload:
        return False

    if main_ref_e is None or main_ref_n is None:
        app.logger.error(f"{export_format_name_logging}: Critical - main reference E/N missing for lot processing. Lots cannot be processed.")
        return False 

    for lot_input in lots_data_payload:
        lot_id = lot_input.get('id', 'unknown_id')
        lot_name = lot_input.get('name', 'Unnamed Lot')
        lines_text = lot_input.get('lines_text', '')

        if not lines_text.strip():
            app.logger.info(f"{export_format_name_logging}: Skipping empty Lot '{lot_name}'.")
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
    if geometry_result["status"] != "success":
        app.logger.error(f"Shapefile: Cannot export Lot '{lot_name}': {geometry_result.get('message')}")
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
        except Exception as e: app.logger.error(f"Shapefile: Error creating Tie-Line GDF for Lot '{lot_name}': {e}")
    
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
            except Exception as e: app.logger.error(f"Shapefile: Error creating Parcel Polygon GDF for Lot '{lot_name}': {e}")
        elif len(parcel_ens) > 1 : # Open linestring
            try:
                gdfs["all_parcel_linestrings_geom"].append(LineString(parcel_ens))
                gdfs["all_parcel_linestrings_attrs"].append({"LotName": lot_name, "Type": "Open Lines"})
                data_added = True
            except Exception as e: app.logger.error(f"Shapefile: Error creating Parcel LineString GDF for Lot '{lot_name}': {e}")
    return data_added

@app.route('/export_shapefile_multi', methods=['POST'])
@limiter.limit("5 per minute;20 per hour")
def export_shapefile_multi():
    request_json_data = request.get_json()
    if not request_json_data: return jsonify({"status": "error", "message": "No JSON data."}), 400

    export_params, error_response = _prepare_export_data_for_routes(request_json_data, "Shapefile")
    if error_response: return error_response

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
         return jsonify({"status": "error", "message": "No valid reference point or lot geometric data to export."}), 400

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
        return jsonify({"status": "error", "message": "No geometric data could be generated for export (possibly all lots had errors or were empty)."}), 400
        
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            files_written = False
            for layer_name, gdf_layer in final_gdfs.items():
                if not gdf_layer.empty:
                    shp_filename = f"{layer_name}.shp" 
                    gdf_layer.to_file(os.path.join(tmpdir, shp_filename), driver='ESRI Shapefile', encoding='utf-8')
                    files_written = True
            
            if not files_written: 
                 return jsonify({"status": "error", "message": "No shapefiles were generated (possibly all lots had errors or were empty, or only an empty ref point was provided)."}), 400

            zip_buffer = io.BytesIO()
            with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
                for item in os.listdir(tmpdir):
                    zf.write(os.path.join(tmpdir, item), arcname=item)
            zip_buffer.seek(0)
    except Exception as e:
        app.logger.error(f"Error during multi-lot shapefile creation/zipping: {e}")
        return jsonify({"status": "error", "message": f"Server error during file prep: {e}"}), 500
    
    filename_base = get_sanitized_filename_base(selected_display_name)
    download_filename = f'{filename_base}_epsg{export_params["target_crs_epsg_str"]}_multi_lot_shapefiles.zip'
    return send_file(zip_buffer, download_name=download_filename, as_attachment=True, mimetype='application/zip')

# --- KMZ Specific Lot Handler ---
def _kmz_lot_handler(lot_id, lot_name, geometry_result, context):
    project_folder = context['project_folder']
    target_crs_epsg_str = context['target_crs_epsg_str']
    main_ref_lon_kml = context.get('main_ref_lon_kml') 
    main_ref_lat_kml = context.get('main_ref_lat_kml')

    if geometry_result["status"] != "success":
        app.logger.error(f"KMZ: Cannot include Lot '{lot_name}': {geometry_result.get('message')}")
        error_pnt = project_folder.newpoint(name=f"Error: Lot {lot_name}")
        error_pnt.description = f"Could not generate geometry for Lot {lot_name}.\nError: {geometry_result.get('message')}"
        
        # Try to get POB coords if they were partially calculated, otherwise use main ref for error marker
        pob_latlon = geometry_result.get("latlon", {}).get("pob_latlng")
        if pob_latlon:
             error_pnt.coords = [(pob_latlon[1], pob_latlon[0])] # lon, lat
        elif main_ref_lon_kml and main_ref_lat_kml:
             error_pnt.coords = [(main_ref_lon_kml, main_ref_lat_kml)]
        error_pnt.style.iconstyle.icon.href = 'http://maps.google.com/mapfiles/kml/paddle/blu-blank.png'
        return True # Error marker was added

    lot_kml_folder = project_folder.newfolder(name=lot_name)
    lot_proj_data = geometry_result["projected"]
    lot_latlon_data = geometry_result["latlon"]
    pob_lon_kml, pob_lat_kml = None, None 

    if lot_latlon_data.get("pob_latlng"):
        pob_lat_kml, pob_lon_kml = lot_latlon_data["pob_latlng"]
        pob_e_desc, pob_n_desc = lot_proj_data["pob_en"]
        pnt_pob = lot_kml_folder.newpoint(name="POB", coords=[(pob_lon_kml, pob_lat_kml)])
        pnt_pob.description = (f"Lat: {pob_lat_kml:.7f}, Lon: {pob_lon_kml:.7f}\n"
                               f"Easting: {pob_e_desc:.3f}, Northing: {pob_n_desc:.3f} (EPSG:{target_crs_epsg_str})")
        pnt_pob.style.iconstyle.icon.href = 'http://maps.google.com/mapfiles/kml/paddle/grn-circle.png'
    
    if lot_latlon_data.get("tie_line_latlngs") and len(lot_latlon_data["tie_line_latlngs"]) == 2:
        kml_tie_coords = [(ll[1], ll[0]) for ll in lot_latlon_data["tie_line_latlngs"]] 
        ls_tie = lot_kml_folder.newlinestring(name="Tie-Line", coords=kml_tie_coords)
        ls_tie.style.linestyle.color = simplekml.Color.red; ls_tie.style.linestyle.width = 2
        ls_tie.altitudemode = simplekml.AltitudeMode.clamptoground

    parcel_latlng_list = lot_latlon_data.get("parcel_polygon_latlngs", [])
    parcel_en_list = lot_proj_data.get("parcel_boundary_ens", [])
    
    if parcel_latlng_list:
        vertex_subfolder = lot_kml_folder.newfolder(name="Vertices")
        points_to_mark_kml_lot = parcel_latlng_list
        if len(parcel_latlng_list) > 1 and parcel_latlng_list[0] == parcel_latlng_list[-1]:
            points_to_mark_kml_lot = parcel_latlng_list[:-1]

        for i, (v_lat, v_lon) in enumerate(points_to_mark_kml_lot):
            is_pob_vertex = False
            if pob_lon_kml and pob_lat_kml and abs(v_lon - pob_lon_kml) < 1e-7 and abs(v_lat - pob_lat_kml) < 1e-7:
                is_pob_vertex = True
            if is_pob_vertex: continue 

            v_name = f"Vertex {i + 1}"
            try: v_e_desc, v_n_desc = parcel_en_list[i]
            except IndexError: v_e_desc, v_n_desc = "N/A", "N/A"
            pnt_v = vertex_subfolder.newpoint(name=v_name, coords=[(v_lon, v_lat)])
            pnt_v.description = (f"Lat: {v_lat:.7f}, Lon: {v_lon:.7f}\n"
                                 f"Easting: {v_e_desc:.3f}, Northing: {v_n_desc:.3f} (EPSG:{target_crs_epsg_str})")
            pnt_v.style.iconstyle.icon.href = 'http://maps.google.com/mapfiles/kml/paddle/ylw-diamond.png'
            pnt_v.style.iconstyle.scale = 0.8
        
        kml_parcel_boundary_coords = [(lon, lat) for lat, lon in parcel_latlng_list]
        if len(kml_parcel_boundary_coords) >= 2:
            is_closed_lot = len(kml_parcel_boundary_coords) >= 4 and \
                             kml_parcel_boundary_coords[0] == kml_parcel_boundary_coords[-1]
            if is_closed_lot:
                poly = lot_kml_folder.newpolygon(name="Parcel Boundary")
                poly.outerboundaryis = kml_parcel_boundary_coords
                poly.style.polystyle.color = simplekml.Color.changealphaint(100, simplekml.Color.blue) 
                poly.style.linestyle.color = simplekml.Color.blue; poly.style.linestyle.width = 3
                poly.altitudemode = simplekml.AltitudeMode.clamptoground
            else:
                ls_parcel = lot_kml_folder.newlinestring(name="Parcel Boundary (Lines)", coords=kml_parcel_boundary_coords)
                ls_parcel.style.linestyle.color = simplekml.Color.blue; ls_parcel.style.linestyle.width = 3
                ls_parcel.altitudemode = simplekml.AltitudeMode.clamptoground
    return True # Data or error marker was added

@app.route('/export_kmz_multi', methods=['POST'])
@limiter.limit("5 per minute;20 per hour")
def export_kmz_multi():
    request_json_data = request.get_json()
    if not request_json_data: return jsonify({"status": "error", "message": "No JSON data."}), 400
    
    export_params, error_response = _prepare_export_data_for_routes(request_json_data, "KMZ")
    if error_response: return error_response

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
        # Let's consider the KML object's content:
        if not project_folder.features: # No features (ref point or lot data/errors) added
            return jsonify({"status": "error", "message": "No data could be generated for KMZ export."}), 400

    kmz_buffer = io.BytesIO()
    try:
        kml.savekmz(kmz_buffer) 
        kmz_buffer.seek(0)
    except Exception as e:
        app.logger.error(f"Error during multi-lot KMZ creation: {e}")
        return jsonify({"status": "error", "message": f"Server error during KMZ file preparation: {e}"}), 500

    filename_base = get_sanitized_filename_base(selected_display_name)
    download_filename = f'{filename_base}_epsg{target_crs_epsg_str}_multi_lot_survey.kmz'
    return send_file(kmz_buffer, download_name=download_filename, as_attachment=True, mimetype='application/vnd.google-earth.kmz')

# --- DXF Specific Lot Handler ---
def _dxf_lot_handler(lot_id, lot_name, geometry_result, context):
    if geometry_result["status"] != "success":
        app.logger.error(f"DXF: Cannot include Lot '{lot_name}': {geometry_result.get('message')}")
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
    request_json_data = request.get_json()
    if not request_json_data: return jsonify({"status": "error", "message": "No JSON data."}), 400

    export_params, error_response = _prepare_export_data_for_routes(request_json_data, "DXF")
    if error_response: return error_response

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
            return jsonify({"status": "error", "message": "No data could be generated for DXF export."}), 400

        string_io_buffer = io.StringIO()
        doc.write(string_io_buffer)
        string_io_buffer.seek(0)
        dxf_string_data = string_io_buffer.read()
        dxf_bytes_data = dxf_string_data.encode(doc.encoding) # Default 'cp1252' or 'utf-8' if set
        dxf_binary_buffer_for_send_file = io.BytesIO(dxf_bytes_data)

    except ImportError: # ezdxf not installed
        app.logger.error("DXF Export Error: ezdxf library is not installed.")
        return jsonify({"status": "error", "message": "Server error: DXF library not available. Please contact admin."}), 500
    except Exception as e:
        app.logger.error(f"Error during multi-lot DXF creation: {e}", exc_info=True)
        return jsonify({"status": "error", "message": f"Server error during DXF file preparation: {e}"}), 500

    filename_base = get_sanitized_filename_base(selected_display_name)
    download_filename = f'{filename_base}_epsg{target_crs_epsg_str}_multi_lot_survey.dxf'
    return send_file(dxf_binary_buffer_for_send_file, download_name=download_filename, as_attachment=True, mimetype='application/dxf')

# --- GeoJSON Specific Lot Handler ---
def _geojson_lot_handler(lot_id, lot_name, geometry_result, context):
    if geometry_result["status"] != "success":
        app.logger.error(f"GeoJSON: Cannot include Lot '{lot_name}': {geometry_result.get('message')}")
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
            app.logger.warning(f"GeoJSON: Lot '{lot_name}' parcel has < 2 points, cannot form LineString.")
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
    request_json_data = request.get_json()
    if not request_json_data: return jsonify({"status": "error", "message": "No JSON data."}), 400

    export_params, error_response = _prepare_export_data_for_routes(request_json_data, "GeoJSON")
    if error_response: return error_response

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
        return jsonify({"status": "error", "message": "No data could be generated for GeoJSON export."}), 400

    geojson_output = {"type": "FeatureCollection", "features": features}
    geojson_str = json.dumps(geojson_output, indent=2)
    geojson_buffer = io.BytesIO(geojson_str.encode('utf-8'))
    
    filename_base = get_sanitized_filename_base(selected_display_name)
    download_filename = f'{filename_base}_epsg{target_crs_epsg_str}_multi_lot_survey.geojson'
    
    return send_file(geojson_buffer, download_name=download_filename, as_attachment=True, mimetype='application/geo+json')

if __name__ == '__main__':
    app.logger.info("Running Flask development server (for local use only)...")

    app.run(debug=False, host='0.0.0.0', port=5000)