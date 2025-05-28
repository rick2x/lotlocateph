"""
GIS utility functions, primarily for managing Coordinate Reference System (CRS)
transformations.
"""

# Third-party imports
from flask import current_app
from pyproj import CRS, Transformer
from pyproj.exceptions import CRSError


DEFAULT_TARGET_CRS_EPSG = 25393  # Default projected CRS for the application
CRS_LATLON_EPSG = 4326  # Standard WGS84 Lat/Lon CRS

_transformer_cache = {}  # Cache for storing pyproj Transformer objects


def get_transformers(target_crs_epsg_str):
    """
    Retrieves or creates and caches pyproj Transformer objects for converting
    between the target projected CRS and WGS84 Lat/Lon (EPSG:4326).

    Args:
        target_crs_epsg_str (str): The EPSG code of the target projected CRS
                                   as a string.

    Returns:
        tuple: (transformer_to_latlon, transformer_to_projected, error_message)
               Returns two Transformer objects and None for error_message on success.
               On failure, returns (None, None, user_friendly_error_message).
    """
    try:
        target_crs_epsg = int(target_crs_epsg_str)
    except ValueError:
        user_msg = (
            f"The Target CRS EPSG code must be a whole number (e.g., 25393), "
            f"but received: '{target_crs_epsg_str}'."
        )
        current_app.logger.error(
            f"ValueError in get_transformers: Invalid Target CRS EPSG "
            f"'{target_crs_epsg_str}' - not an integer."
        )
        return None, None, user_msg

    if target_crs_epsg in _transformer_cache:
        current_app.logger.debug(f"Using cached transformer for EPSG:{target_crs_epsg}")
        cached_to_latlon, cached_to_projected = _transformer_cache[target_crs_epsg]
        return cached_to_latlon, cached_to_projected, None

    try:
        crs_projected = CRS.from_epsg(target_crs_epsg)
        crs_latlon = CRS.from_epsg(CRS_LATLON_EPSG)
        
        transformer_to_latlon = Transformer.from_crs(
            crs_projected, crs_latlon, always_xy=True
        )
        transformer_to_projected = Transformer.from_crs(
            crs_latlon, crs_projected, always_xy=True
        )
        
        _transformer_cache[target_crs_epsg] = (transformer_to_latlon, transformer_to_projected)
        current_app.logger.info(
            f"Created and cached new transformer for EPSG:{target_crs_epsg}"
        )
        return transformer_to_latlon, transformer_to_projected, None
    except CRSError as e:
        user_msg = (
            f"The Target CRS EPSG code '{target_crs_epsg_str}' is invalid or "
            f"not supported. Please check the code or contact support if the "
            f"issue persists."
        )
        current_app.logger.error(
            f"CRSError in get_transformers for EPSG '{target_crs_epsg_str}': {str(e)}"
        )
        return None, None, user_msg
    except Exception as e:
        user_msg = (
            f"A server error occurred while initializing the Coordinate Reference "
            f"System for EPSG code '{target_crs_epsg_str}'. Please try again "
            f"later or contact support."
        )
        current_app.logger.error(
            f"Exception in get_transformers for EPSG '{target_crs_epsg_str}': {str(e)}",
            exc_info=True
        )
        return None, None, user_msg
