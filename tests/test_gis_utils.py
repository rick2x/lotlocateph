import unittest
from unittest.mock import patch, MagicMock
import sys
import os

# Add project root to sys.path
project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, project_root)

from gis_utils import get_transformers, DEFAULT_TARGET_CRS_EPSG, CRS_LATLON_EPSG
from pyproj import Transformer, CRS
from pyproj.exceptions import CRSError

# Mock Flask's current_app for gis_utils.py
class MockGisApp:
    def __init__(self):
        self.logger = MockGisLogger()

class MockGisLogger:
    def warning(self, *args, **kwargs): print("Mocked GIS warning:", *args)
    def error(self, *args, **kwargs): print("Mocked GIS error:", *args)
    def info(self, *args, **kwargs): print("Mocked GIS info:", *args)
    def debug(self, *args, **kwargs): print("Mocked GIS debug:", *args)

mock_gis_current_app = MockGisApp()

class TestGetTransformers(unittest.TestCase):
    def setUp(self):
        # Clear the cache before each test
        from gis_utils import _transformer_cache
        _transformer_cache.clear()

    @patch('gis_utils.current_app', mock_gis_current_app)
    def test_valid_epsg_code(self):
        # Test with the default EPSG code used in the app
        target_epsg = str(DEFAULT_TARGET_CRS_EPSG) # e.g., "25393"
        transformer_to_latlon, transformer_to_projected, error_message = get_transformers(target_epsg)
        self.assertIsNotNone(transformer_to_latlon)
        self.assertIsInstance(transformer_to_latlon, Transformer)
        self.assertIsNotNone(transformer_to_projected)
        self.assertIsInstance(transformer_to_projected, Transformer)
        self.assertIsNone(error_message)

        # Check if transformers are cached
        from gis_utils import _transformer_cache
        self.assertIn(int(target_epsg), _transformer_cache)

    @patch('gis_utils.current_app', mock_gis_current_app)
    def test_caching_behavior(self):
        target_epsg = str(DEFAULT_TARGET_CRS_EPSG)
        # First call
        get_transformers(target_epsg)

        # Second call - should use cache
        # We can check if Transformer.from_crs is called fewer times or mock it
        # For simplicity, we'll rely on checking the cache content as in test_valid_epsg_code
        # and assuming the logger message for "Using cached transformer" would appear (though we don't assert logs here)
        with patch('pyproj.Transformer.from_crs') as mock_from_crs:
            get_transformers(target_epsg) # Call again
            mock_from_crs.assert_not_called() # Should not be called if cache hit

    @patch('gis_utils.current_app', mock_gis_current_app)
    def test_invalid_epsg_code_format(self):
        transformer_to_latlon, transformer_to_projected, error_message = get_transformers("INVALID_CODE")
        self.assertIsNone(transformer_to_latlon)
        self.assertIsNone(transformer_to_projected)
        self.assertIsNotNone(error_message)
        self.assertIn("must be a whole number", error_message)

    @patch('gis_utils.current_app', mock_gis_current_app)
    @patch('pyproj.CRS.from_epsg', side_effect=CRSError("Mocked CRSError for from_epsg")) # More specific mock
    def test_crs_error_on_creation(self, mock_from_epsg_crs):
        # Use an EPSG that is numeric but might be invalid or cause CRSError
        # Ensure the cache is clear for this specific potentially problematic EPSG
        from gis_utils import _transformer_cache
        _transformer_cache.clear()

        transformer_to_latlon, transformer_to_projected, error_message = get_transformers("12345678")
        self.assertIsNone(transformer_to_latlon)
        self.assertIsNone(transformer_to_projected)
        self.assertIsNotNone(error_message)
        self.assertIn("is invalid or not supported", error_message)

    @patch('gis_utils.current_app', mock_gis_current_app)
    # Patching Transformer.from_crs which is used inside get_transformers
    @patch('pyproj.Transformer.from_crs', side_effect=Exception("Mocked general error on Transformer creation"))
    def test_general_exception_on_transformer_creation(self, mock_transformer_from_crs):
        target_epsg_str = str(DEFAULT_TARGET_CRS_EPSG)
        from gis_utils import _transformer_cache
        _transformer_cache.clear() # Ensure Transformer.from_crs is actually called

        transformer_to_latlon, transformer_to_projected, error_message = get_transformers(target_epsg_str)
        self.assertIsNone(transformer_to_latlon)
        self.assertIsNone(transformer_to_projected)
        self.assertIsNotNone(error_message)
        self.assertIn("A server error occurred while initializing the Coordinate Reference System", error_message) # Corrected expected message

if __name__ == '__main__':
    unittest.main(argv=['first-arg-is-ignored'], exit=False)
