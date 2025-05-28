
"""
Utility functions for survey calculations and string manipulation.
"""

# Standard library imports
import math
import re

# Third-party imports
from flask import current_app


def parse_survey_line_to_bearing_distance(line_str):
    """
    Parses a single survey line string into bearing and distance components.

    Args:
        line_str (str): A string representing a survey line,
                        e.g., "N 01D 02′ E;100.50".

    Returns:
        dict or None: A dictionary with keys 'ns', 'deg', 'min', 'ew', 'distance'
                      on successful parsing, or None if parsing fails.
    """
    parts = line_str.split(';')
    # Expect exactly 2 parts: bearing and distance.
    if len(parts) != 2:
        current_app.logger.warning(
            f"Invalid survey line (expected 2 parts, got {len(parts)}): {line_str}"
        )
        return None
    try:
        distance = float(parts[1].strip())
        if distance <= 0:
            current_app.logger.warning(
                f"Invalid distance (must be > 0): {distance} in {line_str}"
            )
            return None
    except ValueError:
        current_app.logger.warning(f"Invalid distance format: {line_str}")
        return None

    # Regex for bearing: e.g., N 01D 02′ E or S89D59'W
    match = re.match(
        r'([NS])\s*(\d{1,2})D\s*(\d{1,2})[′\']\s*([EW])',
        parts[0].strip(),
        re.IGNORECASE
    )
    if not match:
        current_app.logger.warning(f"Invalid bearing format: {parts[0]} in {line_str}")
        return None

    ns, deg_str, min_str, ew = match.groups()
    deg, min_val = int(deg_str), int(min_str)

    if not (0 <= deg <= 89):
        current_app.logger.warning(f"Invalid degrees (0-89): {deg} in {line_str}")
        return None
    if not (0 <= min_val <= 59):
        current_app.logger.warning(f"Invalid minutes (0-59): {min_val} in {line_str}")
        return None

    return {
        'ns': ns.upper(),
        'deg': deg,
        'min': min_val,
        'ew': ew.upper(),
        'distance': distance
    }


def calculate_azimuth(bearing_info):
    """
    Calculates the azimuth in decimal degrees from bearing information.

    Args:
        bearing_info (dict): A dictionary as returned by
                             parse_survey_line_to_bearing_distance.

    Returns:
        float or None: The calculated azimuth in decimal degrees, or None
                       if the bearing information is invalid.
    """
    # Validate structure of bearing_info
    required_keys = ['ns', 'ew', 'deg', 'min']
    if not all(key in bearing_info for key in required_keys):
        current_app.logger.error(
            f"Invalid bearing_info structure (missing keys): {bearing_info}"
        )
        return None

    dec_deg = bearing_info['deg'] + (bearing_info['min'] / 60.0)
    ns = bearing_info['ns']
    ew = bearing_info['ew']

    # Validate ns and ew values
    if ns not in ['N', 'S'] or ew not in ['E', 'W']:
        current_app.logger.error(
            f"Invalid NS ('{ns}') or EW ('{ew}') values in bearing_info: {bearing_info}"
        )
        return None

    if ns == 'N' and ew == 'E':
        return dec_deg
    if ns == 'S' and ew == 'E':
        return 180.0 - dec_deg
    if ns == 'S' and ew == 'W':
        return 180.0 + dec_deg
    if ns == 'N' and ew == 'W':
        return 360.0 - dec_deg
    
    current_app.logger.error(f"Cannot determine azimuth from bearing: {bearing_info}")
    return None


def calculate_new_coordinates(e_start, n_start, azimuth_deg, distance):
    """
    Calculates new Easting and Northing coordinates given a starting point,
    azimuth, and distance.

    Args:
        e_start (float): Starting Easting coordinate.
        n_start (float): Starting Northing coordinate.
        azimuth_deg (float): Azimuth in decimal degrees.
        distance (float): Distance.

    Returns:
        tuple: A tuple containing (new_easting, new_northing).
    """
    az_rad = math.radians(azimuth_deg)
    return e_start + distance * math.sin(az_rad), n_start + distance * math.cos(az_rad)

def get_sanitized_filename_base(selected_display_name):
    if not selected_display_name: return "survey_export"
    base = re.sub(r'[^\w-]', '', selected_display_name.split(' - ')[0]).strip()[:30]
    return base if base else "export"


def decimal_azimuth_to_bearing_string(azimuth_deg):
    """
    Converts a decimal degree azimuth (0-360) into a formatted bearing string.

    Args:
        azimuth_deg (float): Azimuth in decimal degrees.

    Returns:
        str: Formatted bearing string (e.g., "N 45D00′00″ E") or
             cardinal direction (e.g., "Due North").
    """
    if azimuth_deg is None:
        return "N/A"

    epsilon = 1e-6

    if abs(azimuth_deg - 0.0) < epsilon or abs(azimuth_deg - 360.0) < epsilon:
        return "Due North"
    if abs(azimuth_deg - 90.0) < epsilon:
        return "Due East"
    if abs(azimuth_deg - 180.0) < epsilon:
        return "Due South"
    if abs(azimuth_deg - 270.0) < epsilon:
        return "Due West"

    bearing_angle = 0.0
    ns_char = ''
    ew_char = ''

    if 0.0 < azimuth_deg < 90.0:
        bearing_angle = azimuth_deg
        ns_char = 'N'
        ew_char = 'E'
    elif 90.0 < azimuth_deg < 180.0:
        bearing_angle = 180.0 - azimuth_deg
        ns_char = 'S'
        ew_char = 'E'
    elif 180.0 < azimuth_deg < 270.0:
        bearing_angle = azimuth_deg - 180.0
        ns_char = 'S'
        ew_char = 'W'
    elif 270.0 < azimuth_deg < 360.0:
        bearing_angle = 360.0 - azimuth_deg
        ns_char = 'N'
        ew_char = 'W'
    else:
        # Should ideally not be reached if input is 0-360 and cardinal checks are done
        return "Invalid Azimuth"

    degrees = int(bearing_angle)
    minutes_float = (bearing_angle - degrees) * 60.0
    minutes = int(minutes_float)
    seconds_float = (minutes_float - minutes) * 60.0
    seconds = int(round(seconds_float))

    if seconds == 60:
        seconds = 0
        minutes += 1
    if minutes == 60:
        minutes = 0
        degrees += 1
    
    # Bearing angles should be < 90, so degrees should not exceed 89 here.
    # If degrees became 90, it implies the original azimuth was a cardinal direction,
    # which should have been caught by the initial checks.

    return f"{ns_char} {degrees:02d}D{minutes:02d}′{seconds:02d}″ {ew_char}"