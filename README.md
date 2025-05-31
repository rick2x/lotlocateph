# LotLocate PH Tool

LotLocate PH is a web-based application designed to assist in calculating and visualizing land lot data based on survey information. It allows users to input survey lines (bearing and distance), reference points, and target coordinate reference systems (CRS) to compute lot geometries, misclosures, and areas. The tool also provides export functionalities for various GIS and CAD formats.

## Features

*   Manual input of survey data (tie-lines, parcel boundaries).
*   Selection of reference points from a predefined list (loaded from `rizal.csv`).
*   Custom reference point input via map interaction.
*   Coordinate transformation between different CRS.
*   Calculation of lot misclosure and area.
*   Visualization of lots on an interactive map (Leaflet).
*   Export calculated lot data to:
    *   Shapefile
    *   KMZ
    *   DXF
    *   GeoJSON
*   Local storage of survey projects in the browser.

## Setup and Installation

1.  **Clone the repository (if applicable):**
    ```bash
    # git clone <repository-url>
    # cd <repository-directory>
    ```

2.  **Create a virtual environment:**
    It's highly recommended to use a virtual environment to manage project dependencies.
    ```bash
    python -m venv venv
    ```
    Activate the virtual environment:
    *   On Windows:
        ```bash
        .\venv\Scripts\activate
        ```
    *   On macOS and Linux:
        ```bash
        source venv/bin/activate
        ```

3.  **Install dependencies:**
    Make sure you have `pip` installed. Install the required Python packages using:
    ```bash
    pip install -r requirements.txt
    ```

## Configuration (Environment Variables)

Before running the application, set the following environment variables. These are crucial for security and proper functioning, especially in a production environment.

*   `FLASK_SECRET_KEY`: **Required.** A strong, random secret key used for session management and other security purposes.
    *   Example: `export FLASK_SECRET_KEY='your_very_strong_random_secret_string'`
*   `FLASK_DEBUG`: **Required.** Set to `True` for development (enables debug mode, auto-reloader) or `False` for production.
    *   Example (Development): `export FLASK_DEBUG='True'`
    *   Example (Production): `export FLASK_DEBUG='False'` (This is the default if not set)
*   `FLASK_CACHE_TYPE`: *Optional.* The type of cache to use.
    *   Defaults to `"SimpleCache"` (in-memory cache).
    *   For production, you might consider other Flask-Caching supported backends like Redis or Memcached, which would require additional setup and environment variables for their respective configurations.
    *   Example: `export FLASK_CACHE_TYPE='RedisCache'`
*   `FLASK_CACHE_DEFAULT_TIMEOUT`: *Optional.* Default timeout for cached items in seconds.
    *   Defaults to `3600` (1 hour).
    *   Example: `export FLASK_CACHE_DEFAULT_TIMEOUT='1800'` (30 minutes)

Consult the Flask and Flask-Caching documentation for more details on advanced cache configurations.

## Running the Application

1.  **Ensure environment variables are set** as described above.
2.  **Run the Flask development server:**
    ```bash
    flask run
    ```
    Or, if you prefer to run directly via Python:
    ```bash
    python app.py
    ```
3.  Open your web browser and navigate to `http://127.0.0.1:5000/` (or the address shown in your terminal).

## Data Files

*   `rizal.csv`: This file contains the list of reference points (e.g., BLLMs, MBMs) used by the application. It should be present in the root directory of the project. The expected columns are `LOCATION`, `POINT_OF_REFERENCE`, `EASTINGS`, and `NORTHINGS`.

## Testing

Unit tests are located in the `tests/` directory. To run the tests:
1. Ensure all dependencies, including development/testing dependencies (if any were added to `requirements.txt` for testing, e.g. `pytest`), are installed.
2. Navigate to the project root directory.
3. Run the tests using Python's `unittest` module:
    ```bash
    python -m unittest discover tests
    ```

---

*This README provides a basic overview. Further documentation might be needed for advanced usage or development contributions.*
