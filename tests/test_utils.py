import unittest
from unittest.mock import patch # For mocking current_app.logger
import sys
import os
import math # Added for math.sqrt in tests

# Add project root to sys.path to allow importing from utils
# Assuming tests are in a 'tests' directory at the root of the project
project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, project_root)

from utils import (parse_survey_line_to_bearing_distance, calculate_azimuth,
                   decimal_azimuth_to_bearing_string, calculate_new_coordinates,
                   get_sanitized_filename_base)

# Mock Flask's current_app.logger for utils.py functions
class MockApp:
    def __init__(self):
        self.logger = MockLogger()

class MockLogger:
    def warning(self, *args, **kwargs): print("Mocked warning:", *args)
    def error(self, *args, **kwargs): print("Mocked error:", *args)
    def info(self, *args, **kwargs): print("Mocked info:", *args)
    def debug(self, *args, **kwargs): print("Mocked debug:", *args)

mock_current_app = MockApp()

class TestParseSurveyLine(unittest.TestCase):
    @patch('utils.current_app', mock_current_app)
    def test_valid_lines(self):
        self.assertEqual(
            parse_survey_line_to_bearing_distance("N 01D 02′ E;100.50"),
            {'ns': 'N', 'deg': 1, 'min': 2, 'ew': 'E', 'distance': 100.50}
        )
        self.assertEqual(
            parse_survey_line_to_bearing_distance("S 89D 59' W;10.0"),
            {'ns': 'S', 'deg': 89, 'min': 59, 'ew': 'W', 'distance': 10.0}
        )
        self.assertEqual(
            parse_survey_line_to_bearing_distance("n 12d 30’ e;0.5"),
            {'ns': 'N', 'deg': 12, 'min': 30, 'ew': 'E', 'distance': 0.5}
        )

    @patch('utils.current_app', mock_current_app)
    def test_invalid_bearing_format(self):
        self.assertIsNone(parse_survey_line_to_bearing_distance("N 01 02 E;100.50"))
        self.assertIsNone(parse_survey_line_to_bearing_distance("X 01D 02' E;10.0"))
        self.assertIsNone(parse_survey_line_to_bearing_distance("N 01D 02' X;10.0"))
        self.assertIsNone(parse_survey_line_to_bearing_distance("N01D02'E;10.0"))
        self.assertIsNone(parse_survey_line_to_bearing_distance("N 90D 00' E;10.0"))
        self.assertIsNone(parse_survey_line_to_bearing_distance("N 00D 60' E;10.0"))

    @patch('utils.current_app', mock_current_app)
    def test_invalid_distance(self):
        self.assertIsNone(parse_survey_line_to_bearing_distance("N 01D 02′ E;abc"))
        self.assertIsNone(parse_survey_line_to_bearing_distance("N 01D 02′ E;-10.0"))
        self.assertIsNone(parse_survey_line_to_bearing_distance("N 01D 02′ E;0"))

    @patch('utils.current_app', mock_current_app)
    def test_incomplete_input(self):
        self.assertIsNone(parse_survey_line_to_bearing_distance("N 01D 02′ E"))
        self.assertIsNone(parse_survey_line_to_bearing_distance(";10.0"))

    @patch('utils.current_app', mock_current_app)
    def test_out_of_range_values(self):
        self.assertIsNone(parse_survey_line_to_bearing_distance("N 90D 00′ E;100.50"))
        self.assertIsNone(parse_survey_line_to_bearing_distance("N 00D 60′ E;100.50"))
        self.assertIsNone(parse_survey_line_to_bearing_distance("N -5D 00′ E;100.50"))


class TestCalculateAzimuth(unittest.TestCase):
    @patch('utils.current_app', mock_current_app)
    def test_valid_bearings(self):
        self.assertAlmostEqual(calculate_azimuth({'ns': 'N', 'deg': 45, 'min': 0, 'ew': 'E'}), 45.0)
        self.assertAlmostEqual(calculate_azimuth({'ns': 'S', 'deg': 30, 'min': 0, 'ew': 'E'}), 150.0)
        self.assertAlmostEqual(calculate_azimuth({'ns': 'S', 'deg': 60, 'min': 0, 'ew': 'W'}), 240.0)
        self.assertAlmostEqual(calculate_azimuth({'ns': 'N', 'deg': 15, 'min': 0, 'ew': 'W'}), 345.0)
        self.assertAlmostEqual(calculate_azimuth({'ns': 'N', 'deg': 0, 'min': 0, 'ew': 'E'}), 0.0)
        self.assertAlmostEqual(calculate_azimuth({'ns': 'S', 'deg': 0, 'min': 0, 'ew': 'E'}), 180.0)
        self.assertAlmostEqual(calculate_azimuth({'ns': 'N', 'deg': 45, 'min': 30, 'ew': 'E'}), 45.5)
        self.assertAlmostEqual(calculate_azimuth({'ns': 'S', 'deg': 29, 'min': 15, 'ew': 'W'}), 209.25)

    @patch('utils.current_app', mock_current_app)
    def test_invalid_bearing_info(self):
        self.assertIsNone(calculate_azimuth({'ns': 'X', 'deg': 45, 'min': 0, 'ew': 'E'}))
        self.assertIsNone(calculate_azimuth({'ns': 'N', 'deg': 45, 'min': 0, 'ew': 'X'}))
        self.assertIsNone(calculate_azimuth({'deg': 45, 'min': 0, 'ew': 'E'}))
        self.assertIsNone(calculate_azimuth({'ns': 'N', 'min': 0, 'ew': 'E'}))
        self.assertIsNone(calculate_azimuth({'ns': 'N', 'deg': 45, 'ew': 'E'}))
        self.assertIsNone(calculate_azimuth({}))


class TestDecimalAzimuthToBearingString(unittest.TestCase):
    def test_cardinal_directions(self):
        self.assertEqual(decimal_azimuth_to_bearing_string(0.0), "Due North")
        self.assertEqual(decimal_azimuth_to_bearing_string(360.0), "Due North")
        self.assertEqual(decimal_azimuth_to_bearing_string(90.0), "Due East")
        self.assertEqual(decimal_azimuth_to_bearing_string(180.0), "Due South")
        self.assertEqual(decimal_azimuth_to_bearing_string(270.0), "Due West")

    def test_quadrant_bearings(self):
        self.assertEqual(decimal_azimuth_to_bearing_string(45.0), "N 45D00′00″ E")
        self.assertEqual(decimal_azimuth_to_bearing_string(135.0), "S 45D00′00″ E")
        self.assertEqual(decimal_azimuth_to_bearing_string(225.0), "S 45D00′00″ W")
        self.assertEqual(decimal_azimuth_to_bearing_string(315.0), "N 45D00′00″ W")

    def test_bearings_with_minutes_seconds(self):
        self.assertEqual(decimal_azimuth_to_bearing_string(30.5), "N 30D30′00″ E")
        self.assertEqual(decimal_azimuth_to_bearing_string(150.25), "S 29D45′00″ E")
        self.assertEqual(decimal_azimuth_to_bearing_string(200.75), "S 20D45′00″ W")
        self.assertEqual(decimal_azimuth_to_bearing_string(300.125), "N 59D52′30″ W")
        self.assertEqual(decimal_azimuth_to_bearing_string(45.0001388888), "N 45D00′00″ E")
        self.assertEqual(decimal_azimuth_to_bearing_string(45.0000001), "N 45D00′00″ E")

    def test_edge_cases_near_cardinal(self):
        self.assertEqual(decimal_azimuth_to_bearing_string(0.00000001), "Due North")
        self.assertEqual(decimal_azimuth_to_bearing_string(359.9999999), "Due North")
        self.assertEqual(decimal_azimuth_to_bearing_string(89.9999999), "Due East")
        self.assertEqual(decimal_azimuth_to_bearing_string(89.999999), "Due East")
        self.assertEqual(decimal_azimuth_to_bearing_string(269.9999999), "Due West")
        self.assertEqual(decimal_azimuth_to_bearing_string(89.999), "N 89D59′56″ E")
        self.assertEqual(decimal_azimuth_to_bearing_string(179.999), "S 00D00′04″ E")

    def test_none_input(self):
        self.assertEqual(decimal_azimuth_to_bearing_string(None), "N/A")


class TestCalculateNewCoordinates(unittest.TestCase):
    def test_cardinal_directions(self):
        # Start at (100, 100), distance 10
        # North (Azimuth 0)
        e, n = calculate_new_coordinates(100, 100, 0, 10)
        self.assertAlmostEqual(e, 100.0)
        self.assertAlmostEqual(n, 110.0)
        # East (Azimuth 90)
        e, n = calculate_new_coordinates(100, 100, 90, 10)
        self.assertAlmostEqual(e, 110.0)
        self.assertAlmostEqual(n, 100.0)
        # South (Azimuth 180)
        e, n = calculate_new_coordinates(100, 100, 180, 10)
        self.assertAlmostEqual(e, 100.0)
        self.assertAlmostEqual(n, 90.0)
        # West (Azimuth 270)
        e, n = calculate_new_coordinates(100, 100, 270, 10)
        self.assertAlmostEqual(e, 90.0)
        self.assertAlmostEqual(n, 100.0)

    def test_diagonal_direction(self):
        # Start at (0,0), Azimuth 45 (NE), distance sqrt(2) -> (1,1)
        dist = math.sqrt(2)
        e, n = calculate_new_coordinates(0, 0, 45, dist)
        self.assertAlmostEqual(e, 1.0)
        self.assertAlmostEqual(n, 1.0)

    def test_zero_distance(self):
        e, n = calculate_new_coordinates(50, 50, 45, 0)
        self.assertAlmostEqual(e, 50.0)
        self.assertAlmostEqual(n, 50.0)

class TestGetSanitizedFilenameBase(unittest.TestCase):
    def test_valid_input_with_special_chars(self):
        self.assertEqual(get_sanitized_filename_base("My Location - Point 1 !@#"), "MyLocation")
        self.assertEqual(get_sanitized_filename_base("Another Place - Ref_A"), "AnotherPlace")

    def test_already_sanitized(self):
        self.assertEqual(get_sanitized_filename_base("NormalName"), "NormalName")

    def test_empty_or_becomes_empty(self):
        self.assertEqual(get_sanitized_filename_base(""), "survey_export") # Default for empty string input (falsy)
        self.assertEqual(get_sanitized_filename_base("!@#$%^"), "export") # Default if all chars removed and base becomes empty

    def test_long_input(self):
        long_name = "ThisIsAVeryLongLocationNameThatExceedsThirtyCharactersLimit - Point X"
        expected = "ThisIsAVeryLongLocationNameTha" # Corrected expected: first 30 chars of the part before ' - '
        self.assertEqual(get_sanitized_filename_base(long_name), expected)

    def test_none_input(self):
        self.assertEqual(get_sanitized_filename_base(None), "survey_export")

    def test_input_with_only_delimiter(self):
        self.assertEqual(get_sanitized_filename_base(" - "), "export")


if __name__ == '__main__':
    unittest.main(argv=['first-arg-is-ignored'], exit=False)
