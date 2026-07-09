Commodity Scraper Desktop Runner

Files that must stay together in the same folder:

- krama-sync.exe
- Launch Commodity Scraper.vbs
- .env
- node_modules\
- ms-playwright\

How to run:

1. Double-click Launch Commodity Scraper.vbs
2. The scraper UI opens in your browser
3. Select the scraping source and report date
4. Click Fetch Data
5. Wait for the scrape and local DB update to finish

What the app writes:

- logs\ for run logs

Local DB behavior:

- data is written into the local SQLite database
- scrape_runs receives one row per execution
- timestamps are recorded in IST (+05:30)

Important notes:

- .env must sit beside krama-sync.exe
- Launch Commodity Scraper.vbs is the recommended non-terminal entry point
- if the HTTP scrape path fails, the app falls back to Playwright using the bundled browser runtime

If the run fails:

- open the latest file in logs\
- check that .env is present and contains the correct Google credentials
