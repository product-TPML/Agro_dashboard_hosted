const { chromium } = require("playwright");
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const http = require("http");
const path = require("path");
const readline = require("readline/promises");
const { spawn } = require("child_process");
const Database = require("better-sqlite3");
const { PDFParse } = require("pdf-parse");

const TIMEOUT_NAV = 90000;
const TIMEOUT_CLICK = 30000;
const MAX_RETRIES = 3;
const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const INDIA_TIME_ZONE = "Asia/Kolkata";
const DEFAULT_PRICE_SHEET_NAME = "prices";
const DEFAULT_RUNS_SHEET_NAME = "runs";
const PRICE_RETENTION_DAYS = 30;
const DEFAULT_SOURCE_ID = "krama";
const DEFAULT_SINK_ID = "sqlite_local";
const PRICE_SHEET_COLUMNS = [
  "row_key",
  "report_date",
  "heading",
  "commodity",
  "perishability",
  "Market",
  "Variety",
  "Grade",
  "Arrivals",
  "Units",
  "Min (Rs.)",
  "Max (Rs.)",
  "Modal (Rs.)",
  "scraped_at",
];
const RUN_SHEET_COLUMNS = [
  "run_id",
  "started_at",
  "finished_at",
  "report_date",
  "status",
  "commodity_count",
  "row_count",
  "output_dir",
  "json_path",
  "csv_path",
  "log_path",
  "notes",
];

const APP_ROOT_DIR = process.env.KRAMA_APP_ROOT || __dirname;
const IS_EXE = process.env.KRAMA_RUNNING_AS_EXE === "1";
const DEFAULT_LOGS_DIR = path.join(APP_ROOT_DIR, "logs");
const ENV_PATH = path.join(APP_ROOT_DIR, ".env");
const SOURCE_URL = "https://krama.karnataka.gov.in/reports/Main_Rep";
const CSB_SILK_URL = "https://csb.gov.in/Statistics/silk-prices";
const RUBBER_BOARD_URL = "https://rubberboard.gov.in/indianPrices";
const SPICES_BOARD_URL = "https://www.indianspices.com/marketing/price/domestic/current-market-price.html";
const COFFEE_BOARD_ARCHIVE_URL = "https://coffeeboard.gov.in/Market_Info_Archives.aspx";
const DB_PATH = path.join(APP_ROOT_DIR, "data", "agro_dashboard.db");
const RUBBER_BOARD_GRADE_CONFIG = [
  { gradeId: "7", variety: "RSS4" },
  { gradeId: "9", variety: "RSS5" },
  { gradeId: "10", variety: "ISNR20" },
  { gradeId: "11", variety: "Latex (60%)" },
];
const RUBBER_BOARD_TARGET_MARKETS = new Set(["Kottayam", "Kochi"]);
const SPICES_BOARD_TARGET_STATE = "KERALA";
const SPICES_BOARD_TARGET_MARKET = "Cochin";
const COFFEE_BOARD_MARKET = "Karnataka";
const COFFEE_BOARD_VARIETIES = [
  "Arabica Parchment",
  "Arabica Cherry",
  "Robusta Parchment",
  "Robusta Cherry",
];

let logState = null;

function getIndiaDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: INDIA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const values = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }
  return values;
}

function getIndiaTimestamp(date = new Date()) {
  const parts = getIndiaDateParts(date);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+05:30`;
}

function makeTimestampSlug(date = new Date()) {
  return getIndiaTimestamp(date).replace(/[:+]/g, "-");
}

function getReportDateStrings(inputDate) {
  if (inputDate) {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(inputDate);
    if (!match) {
      throw new Error(`Invalid --date value "${inputDate}". Expected DD/MM/YYYY.`);
    }
    return {
      dateStr: inputDate,
      fileDateStr: `${match[3]}-${match[2]}-${match[1]}`,
    };
  }

  const parts = getIndiaDateParts();
  return {
    dateStr: `${parts.day}/${parts.month}/${parts.year}`,
    fileDateStr: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function setupLogging() {
  ensureDirectory(DEFAULT_LOGS_DIR);
  const logPath = path.join(DEFAULT_LOGS_DIR, `krama_sync_${makeTimestampSlug()}.log`);
  logState = {
    logPath,
    stream: fs.createWriteStream(logPath, { flags: "a" }),
  };
  return logPath;
}

function closeLogging() {
  if (logState && logState.stream) {
    logState.stream.end();
  }
}

function log(step, msg) {
  const line = `[${new Date().toISOString()}] [${step}] ${msg}`;
  console.log(line);
  if (logState && logState.stream) {
    logState.stream.write(`${line}\n`);
  }
}

function logError(step, error) {
  const message = error && error.stack ? error.stack : String(error);
  const line = `[${new Date().toISOString()}] [${step}] ${message}`;
  console.error(line);
  if (logState && logState.stream) {
    logState.stream.write(`${line}\n`);
  }
}

function stripMatchingQuotes(value) {
  if (!value) {
    return value;
  }

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function loadDotEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const contents = fs.readFileSync(filePath, "utf8");
  const lines = contents.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = stripMatchingQuotes(trimmed.slice(separatorIndex + 1).trim());
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = value;
  }
}

function normalizePrivateKey(value) {
  if (!value) {
    return value;
  }

  let normalized = stripMatchingQuotes(value.trim());
  normalized = normalized.replace(/\\r\\n/g, "\r\n");
  normalized = normalized.replace(/\\n/g, "\n");
  normalized = normalized.replace(/\\r/g, "\r");
  return normalized.trim();
}

function pauseForExitIfNeeded() {
  if (!IS_EXE) {
    return Promise.resolve();
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return rl.question("Press Enter to close this window...").finally(() => rl.close());
}

function parseArgs(argv) {
  const options = {
    date: null,
    sourceId: DEFAULT_SOURCE_ID,
    sinkId: DEFAULT_SINK_ID,
    syncSheets: IS_EXE,
    pauseOnExit: IS_EXE,
    uiMode: argv.length === 0,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--date") {
      options.date = argv[index + 1] || null;
      index += 1;
    } else if (arg.startsWith("--date=")) {
      options.date = arg.slice("--date=".length);
    } else if (arg === "--source") {
      options.sourceId = argv[index + 1] || options.sourceId;
      index += 1;
    } else if (arg.startsWith("--source=")) {
      options.sourceId = arg.slice("--source=".length);
    } else if (arg === "--sink") {
      options.sinkId = argv[index + 1] || options.sinkId;
      index += 1;
    } else if (arg.startsWith("--sink=")) {
      options.sinkId = arg.slice("--sink=".length);
    } else if (arg === "--sync-sheets") {
      options.syncSheets = true;
      options.sinkId = "google_sheets";
    } else if (arg === "--no-sync-sheets") {
      options.syncSheets = false;
      if (options.sinkId === "google_sheets") {
        options.sinkId = DEFAULT_SINK_ID;
      }
    } else if (arg === "--ui") {
      options.uiMode = true;
    } else if (arg === "--no-ui") {
      options.uiMode = false;
    } else if (arg === "--no-pause") {
      options.pauseOnExit = false;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function toColumnLetter(index) {
  let value = index;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function printHelp() {
  console.log(`Commodity source scraper

Usage:
  node scrape_krama.js [options]

Options:
  --date DD/MM/YYYY       Override the report date. Default: today in IST.
  --source ID             Source id: krama | necc_egg | csb_silk | rubber_board | spices_board | coffee_board. Default: krama.
  --sink ID               Sink id: sqlite_local | google_sheets. Default: sqlite_local.
  --sync-sheets           Sync scraped rows and run logs to Google Sheets.
  --no-sync-sheets        Disable Google Sheets sync.
  --ui                    Start the local date-picker UI.
  --no-ui                 Skip the UI and run directly in the console.
  --no-pause              Do not wait for Enter before exit in the packaged exe.
  --help, -h              Show this help.

Environment:
  GOOGLE_SERVICE_ACCOUNT_EMAIL
  GOOGLE_PRIVATE_KEY
  GOOGLE_SPREADSHEET_ID
  GOOGLE_PRICES_SHEET_NAME
  GOOGLE_RUNS_SHEET_NAME

Notes:
  - When packaged as an exe, .env is read from the same folder as the executable.
  - The packaged exe launches a local browser UI to select source and scrape date.
  - Local logs are written in the repo logs folder.
`);
}

async function retry(fn, step, description, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      log(step, `${description} (attempt ${attempt}/${retries})`);
      return await fn();
    } catch (err) {
      log(step, `Attempt ${attempt} failed: ${err.message}`);
      if (attempt === retries) {
        log(step, `All ${retries} attempts exhausted for: ${description}`);
        throw err;
      }
      const delay = 5000 * attempt;
      log(step, `Waiting ${delay / 1000}s before retry...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error(`Retry loop exited unexpectedly for ${description}`);
}

function httpGet(requestUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(requestUrl);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: "GET",
      timeout: 30000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({ status: res.statusCode, body, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("HTTP timeout"));
    });
    req.end();
  });
}

function httpPost(requestUrl, postData, cookieStr) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(requestUrl);
    const body = typeof postData === "string" ? postData : new URLSearchParams(postData).toString();
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: "POST",
      timeout: 60000,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        Referer: requestUrl,
        Cookie: cookieStr || "",
      },
    };
    const req = https.request(options, (res) => {
      let responseBody = "";
      res.on("data", (chunk) => {
        responseBody += chunk;
      });
      res.on("end", () => {
        resolve({ status: res.statusCode, body: responseBody, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("HTTP POST timeout"));
    });
    req.write(body);
    req.end();
  });
}

async function extractViewState(html) {
  const viewStateMatch = html.match(/id="__VIEWSTATE"\s+value="([^"]*)"/);
  const viewStateGenMatch = html.match(/id="__VIEWSTATEGENERATOR"\s+value="([^"]*)"/);
  const eventValidationMatch = html.match(/id="__EVENTVALIDATION"\s+value="([^"]*)"/);
  if (!viewStateMatch || !viewStateGenMatch || !eventValidationMatch) {
    throw new Error("Could not extract ViewState fields from page");
  }
  return {
    viewState: viewStateMatch[1],
    viewStateGenerator: viewStateGenMatch[1],
    eventValidation: eventValidationMatch[1],
  };
}

function parseHtmlData(html) {
  const commodities = [];
  const headingMatch = html.match(/id="_ctl0_MainContent_Lbl_Heading"[^>]*>([^<]*)/);
  const heading = headingMatch ? headingMatch[1].trim() : "";

  const commodityRegex = /<span[^>]*style="[^"]*color:Red[^"]*"[^>]*>\s*COMMODITY:\s*([^<]+)\s*<\/span>/gi;
  const tableRegex = /<table[^>]*border-collapse:collapse[^>]*>([\s\S]*?)<\/table>/gi;

  const commodityNames = [];
  let commodityMatch;
  while ((commodityMatch = commodityRegex.exec(html)) !== null) {
    commodityNames.push(commodityMatch[1].trim());
  }

  const tables = [];
  let tableMatch;
  while ((tableMatch = tableRegex.exec(html)) !== null) {
    tables.push(tableMatch[1]);
  }

  for (let index = 0; index < commodityNames.length && index < tables.length; index += 1) {
    const name = commodityNames[index];
    const tableHtml = tables[index];
    const rows = [];
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
      rows.push(rowMatch[1]);
    }

    if (rows.length < 2) {
      continue;
    }

    const headers = [];
    const headerRegex = /<th[^>]*>([^<]*)<\/th>/gi;
    let headerMatch;
    while ((headerMatch = headerRegex.exec(rows[0])) !== null) {
      headers.push(headerMatch[1].trim());
    }

    if (headers.length === 0) {
      continue;
    }

    const rowData = [];
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
      const cellMatches = [...rows[rowIndex].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
      if (cellMatches.length === 1 && cellMatches[0][1].trim() === "No Data Found For The Commodity") {
        continue;
      }

      const row = {};
      headers.forEach((header, headerIndex) => {
        row[header] = cellMatches[headerIndex] ? cellMatches[headerIndex][1].trim() : "";
      });
      rowData.push(row);
    }

    if (rowData.length > 0) {
      commodities.push({ name, data: rowData });
    }
  }

  return { heading, commodities };
}

async function scrapeWithHttp(dateStr) {
  log("HTTP", "Attempting direct HTTP POST approach (no browser)...");
  const getRes = await retry(() => httpGet(SOURCE_URL), "HTTP", "GET Main_Rep");
  log("HTTP", `GET response: status=${getRes.status}, body size=${getRes.body.length}`);

  if (getRes.status !== 200) {
    throw new Error(`GET Main_Rep returned status ${getRes.status}`);
  }

  const cookies = getRes.headers["set-cookie"] || "";
  const cookieStr = Array.isArray(cookies) ? cookies.join("; ") : (typeof cookies === "string" ? cookies : "");
  const vs = await extractViewState(getRes.body);

  const postData1 = new URLSearchParams({
    __EVENTTARGET: "",
    __EVENTARGUMENT: "",
    __LASTFOCUS: "",
    __VIEWSTATE: vs.viewState,
    __VIEWSTATEGENERATOR: vs.viewStateGenerator,
    __EVENTVALIDATION: vs.eventValidation,
    "_ctl0:MainContent:TxtDate": dateStr,
    "_ctl0:MainContent:RadBtnSel": "C",
    "_ctl0:MainContent:BtnRep": "View Report",
  }).toString();

  const post1Res = await retry(
    () => httpPost(SOURCE_URL, postData1, cookieStr),
    "HTTP",
    "POST to Main_Rep (Commodity)"
  );
  log("HTTP", `POST response: status=${post1Res.status}, body size=${post1Res.body.length}`);

  if (post1Res.status !== 200) {
    throw new Error(`POST Main_Rep returned status ${post1Res.status}`);
  }

  const checkboxRegex = /<input[^>]*type="checkbox"[^>]*id="([^"]*)"[^>]*name="([^"]*)"[^>]*>/gi;
  const checkboxes = [...post1Res.body.matchAll(checkboxRegex)];
  if (checkboxes.length === 0) {
    throw new Error("No checkboxes found in commodity selection page");
  }

  const allCheckboxName = checkboxes[0][2];
  const commodityIds = allCheckboxName
    .replace("_ctl0:MainContent:", "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const vs2 = await extractViewState(post1Res.body);

  const postData2Obj = {
    __EVENTTARGET: "",
    __EVENTARGUMENT: "",
    __LASTFOCUS: "",
    __VIEWSTATE: vs2.viewState,
    __VIEWSTATEGENERATOR: vs2.viewStateGenerator,
    __EVENTVALIDATION: vs2.eventValidation,
    "_ctl0:MainContent:BtnRep": "View Report",
  };
  postData2Obj[`_ctl0:MainContent:${allCheckboxName.replace("_ctl0:MainContent:", "")}`] = "on";

  for (const commodityId of commodityIds) {
    const checkboxName = `_ctl0:MainContent:${commodityId}`;
    if (post1Res.body.includes(`name="${checkboxName}"`)) {
      postData2Obj[checkboxName] = "on";
    }
  }

  const post2Res = await retry(
    () => httpPost("https://krama.karnataka.gov.in/reports/Commadity", new URLSearchParams(postData2Obj).toString(), cookieStr),
    "HTTP",
    "POST to Commadity (report data)"
  );
  log("HTTP", `Report POST response: status=${post2Res.status}, body size=${post2Res.body.length}`);

  if (post2Res.status !== 200) {
    throw new Error(`POST Commadity returned status ${post2Res.status}`);
  }

  const data = parseHtmlData(post2Res.body);
  log("HTTP", `Parsed ${data.commodities.length} commodities from HTML`);
  return data;
}

async function scrapeWithPlaywright(dateStr, headless = true) {
  if (fs.existsSync(path.join(APP_ROOT_DIR, "ms-playwright"))) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(APP_ROOT_DIR, "ms-playwright");
  }

  log("BROWSER", `Launching browser (headless=${headless})...`);
  const launchArgs = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"];
  if (headless) {
    launchArgs.push("--disable-gpu");
  }

  const browser = await chromium.launch({
    headless,
    args: launchArgs,
  });

  try {
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 1024 },
    });
    const page = await context.newPage();

    await retry(
      () => page.goto(SOURCE_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT_NAV }),
      "NAVIGATE",
      "Navigate to Main_Rep"
    );
    await page.waitForSelector("#_ctl0_MainContent_BtnRep", { timeout: TIMEOUT_CLICK });

    const formResult = await page.evaluate(() => {
      return {
        dateInputFound: !!document.getElementById("_ctl0_MainContent_TxtDate"),
        radioFound: !!document.getElementById("_ctl0_MainContent_RadBtnSel_2"),
        buttonFound: !!document.getElementById("_ctl0_MainContent_BtnRep"),
      };
    });
    if (!formResult.dateInputFound || !formResult.radioFound || !formResult.buttonFound) {
      throw new Error(`Required form elements not found: ${JSON.stringify(formResult)}`);
    }

    await page.evaluate((value) => {
      document.getElementById("_ctl0_MainContent_TxtDate").value = value;
      document.getElementById("_ctl0_MainContent_RadBtnSel_2").checked = true;
    }, dateStr);

    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: TIMEOUT_NAV }),
      page.click("#_ctl0_MainContent_BtnRep"),
    ]);

    await page.waitForSelector('input[type="checkbox"]', { timeout: TIMEOUT_CLICK });
    const checkboxInfo = await page.evaluate(() => {
      const checkbox = document.querySelector('input[type="checkbox"]');
      return { id: checkbox ? checkbox.id : null };
    });
    if (!checkboxInfo.id) {
      throw new Error("No checkboxes found on commodity selection page");
    }

    await page.evaluate((checkboxId) => {
      document.getElementById(checkboxId).checked = true;
    }, checkboxInfo.id);

    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: TIMEOUT_NAV }),
      page.click("#_ctl0_MainContent_BtnRep"),
    ]);

    await page.waitForSelector('span[style*="color:Red"]', { timeout: TIMEOUT_NAV });
    const data = await page.evaluate(() => {
      const headingEl = document.getElementById("_ctl0_MainContent_Lbl_Heading");
      const heading = headingEl ? headingEl.textContent.trim() : "";
      const commodities = [];
      const spans = document.querySelectorAll('span[style*="color:Red"]');
      const tables = document.querySelectorAll('table[style*="border-collapse:collapse"]');

      for (let index = 0; index < spans.length; index += 1) {
        const table = tables[index];
        if (!table) {
          continue;
        }

        const rows = table.querySelectorAll("tr");
        if (rows.length < 2) {
          continue;
        }

        const headers = [];
        rows[0].querySelectorAll("th").forEach((headerCell) => {
          headers.push(headerCell.textContent.trim());
        });
        if (headers.length === 0) {
          continue;
        }

        const rowData = [];
        for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
          const cells = rows[rowIndex].querySelectorAll("td");
          if (cells.length === 1 && cells[0].textContent.trim() === "No Data Found For The Commodity") {
            continue;
          }

          const row = {};
          headers.forEach((header, headerIndex) => {
            row[header] = cells[headerIndex] ? cells[headerIndex].textContent.trim() : "";
          });
          rowData.push(row);
        }

        if (rowData.length > 0) {
          commodities.push({
            name: spans[index].textContent.replace("COMMODITY:", "").trim(),
            data: rowData,
          });
        }
      }

      return { heading, commodities };
    });

    log("SCRAPE", `Scraped ${data.commodities.length} commodities with data`);
    return data;
  } finally {
    await browser.close();
  }
}

function flattenRowsForSheets(data, reportDate, scrapedAt) {
  const rows = [];
  for (const commodity of data.commodities) {
    for (const row of commodity.data) {
      const rowKey = [
        reportDate,
        commodity.name,
        row["Market"] || "",
        row["Variety"] || "",
        row["Grade"] || "",
      ]
        .map((value) => String(value).trim().toLowerCase())
        .join("|");

      rows.push({
        row_key: rowKey,
        report_date: reportDate,
        heading: data.heading || "",
        commodity: commodity.name,
        perishability: "",
        Market: row["Market"] || "",
        Variety: row["Variety"] || "",
        Grade: row["Grade"] || "",
        Arrivals: row["Arrivals"] || "",
        Units: row["Units"] || "",
        "Min (Rs.)": row["Min (Rs.)"] || "",
        "Max (Rs.)": row["Max (Rs.)"] || "",
        "Modal (Rs.)": row["Modal (Rs.)"] || "",
        scraped_at: scrapedAt,
      });
    }
  }
  return rows;
}

function buildObservationRowKey(parts) {
  return parts
    .map((value) => String(value || "").trim().toLowerCase())
    .join("|");
}

function normalizeKramaData(data, reportDate, scrapedAt) {
  const observations = [];

  for (const commodity of data.commodities) {
    for (const row of commodity.data) {
      observations.push({
        sourceId: "krama",
        rowKey: buildObservationRowKey([
          reportDate,
          "krama",
          commodity.name,
          row["Market"],
          row["Variety"],
          row["Grade"],
        ]),
        reportDate,
        heading: data.heading || "",
        commodity: commodity.name,
        perishability: null,
        category: null,
        market: String(row["Market"] || "").trim(),
        variety: String(row["Variety"] || "").trim(),
        grade: String(row["Grade"] || "").trim(),
        arrivals: parseLooseNumber(row["Arrivals"]),
        unit: String(row["Units"] || "").trim(),
        minPrice: parseLooseNumber(row["Min (Rs.)"]),
        maxPrice: parseLooseNumber(row["Max (Rs.)"]),
        modalPrice: parseLooseNumber(row["Modal (Rs.)"]),
        canonicalPrice: null,
        canonicalPriceUnit: null,
        price100Pieces: null,
        price1Piece: null,
        price1Tray: null,
        scrapedAt,
      });
    }
  }

  return observations;
}

function parseLooseNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const sanitized = String(value).replace(/,/g, "").trim();
  if (!sanitized || sanitized === "-") {
    return null;
  }
  const parsed = Number(sanitized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value: ${value}`);
  }
  return parsed;
}

function normalizeMarketNameForDb(sourceId, market) {
  const text = String(market || "").trim();
  if (!text) {
    return text;
  }
  if (sourceId === "necc_egg") {
    if (text === "Bengaluru (CC)") {
      return "BENGALURU";
    }
    if (text === "Mysuru") {
      return "MYSURU";
    }
  }
  if (sourceId === "csb_silk") {
    if (text === "Ramanagaram") {
      return "RAMANAGARA";
    }
  }
  return text.toUpperCase();
}

function parseDashedDateToIso(value) {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(value || "").trim());
  if (!match) {
    throw new Error(`Invalid dashed date: ${value}`);
  }
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function parseDmyAbbrevMonthDateToIso(value) {
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(String(value || "").trim());
  if (!match) {
    throw new Error(`Invalid abbreviated month date: ${value}`);
  }

  const monthMap = {
    Jan: "01",
    Feb: "02",
    Mar: "03",
    Apr: "04",
    May: "05",
    Jun: "06",
    Jul: "07",
    Aug: "08",
    Sep: "09",
    Oct: "10",
    Nov: "11",
    Dec: "12",
  };
  const month = monthMap[`${match[2].slice(0, 1).toUpperCase()}${match[2].slice(1, 3).toLowerCase()}`];
  if (!month) {
    throw new Error(`Invalid month in abbreviated month date: ${value}`);
  }

  return `${match[3]}-${month}-${match[1]}`;
}

function parseDottedDateToIso(value) {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(value || "").trim());
  if (!match) {
    throw new Error(`Invalid dotted date: ${value}`);
  }
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function decodeHtmlText(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildHiddenFormFields(html) {
  const form = {};
  for (const match of html.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/gi)) {
    form[match[1]] = match[2];
  }
  for (const match of html.matchAll(/<textarea[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/gi)) {
    form[match[1]] = match[2];
  }
  return form;
}

function extractCookieHeader(setCookieHeaders, allowedPrefixes = []) {
  const values = Array.isArray(setCookieHeaders) ? setCookieHeaders : (setCookieHeaders ? [setCookieHeaders] : []);
  return values
    .map((value) => String(value).split(";")[0].trim())
    .filter(Boolean)
    .filter((value) => allowedPrefixes.length === 0 || allowedPrefixes.some((prefix) => value.startsWith(prefix)))
    .join("; ");
}

function parseNeccEggHtml(html, reportDate) {
  const monthMatch = html.match(/<select name="ddlMonth" id="ddlMonth"[\s\S]*?<option selected="selected" value="(\d{2})">/i);
  const yearMatch = html.match(/<select name="ddlYear" id="ddlYear"[\s\S]*?<option selected="selected" value="(\d{4})">/i);
  const [, year, month, day] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(reportDate) || [];
  const selectedMonth = monthMatch ? monthMatch[1] : month;
  const selectedYear = yearMatch ? yearMatch[1] : year;
  if (!selectedMonth || !selectedYear || !day) {
    throw new Error("Could not determine the selected NECC month/year/day.");
  }

  const dayNumber = Number(day);
  const headerMatch = html.match(/<tr[^>]*>\s*<th[^>]*>Name Of Zone \/ Day<\/th>([\s\S]*?)<\/tr>/i);
  if (!headerMatch) {
    throw new Error("Could not locate the NECC day header row.");
  }

  const headerCells = [...headerMatch[1].matchAll(/<th[^>]*>([^<]*)<\/th>/gi)].map((match) => match[1].trim());
  const dayColumnIndex = headerCells.findIndex((value) => Number(value) === dayNumber);
  if (dayColumnIndex === -1) {
    throw new Error(`Selected day ${dayNumber} was not present in the NECC table.`);
  }

  const targetLabels = new Set(["Bengaluru (CC)", "Mysuru"]);
  const rowRegex = /<tr align="center">\s*<td align='left'>([^<]+)<\/td>([\s\S]*?)<\/tr>/gi;
  const observations = [];
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const sourceMarket = rowMatch[1].trim();
    if (!targetLabels.has(sourceMarket)) {
      continue;
    }

    const cells = [...rowMatch[2].matchAll(/<td>([^<]*)<\/td>/gi)].map((match) => match[1].trim());
    const dayValue = cells[dayColumnIndex] || "";
    if (!dayValue || dayValue === "-") {
      continue;
    }

    const price100Pieces = parseLooseNumber(dayValue);
    if (price100Pieces === null) {
      continue;
    }

    const market = normalizeMarketNameForDb("necc_egg", sourceMarket);
    observations.push({
      sourceId: "necc_egg",
      rowKey: buildObservationRowKey([reportDate, "necc_egg", "Egg", market]),
      reportDate,
      heading: `NECC Daily Egg Prices ${selectedYear}-${selectedMonth}`,
      commodity: "Egg",
      perishability: "perishable",
      category: "miscellaneous",
      market,
      variety: "",
      grade: "",
      arrivals: null,
      unit: "",
      minPrice: null,
      maxPrice: null,
      modalPrice: null,
      canonicalPrice: price100Pieces,
      canonicalPriceUnit: "100 pieces",
      price100Pieces,
      price1Piece: Number((price100Pieces / 100).toFixed(2)),
      price1Tray: Number(((price100Pieces / 100) * 30).toFixed(2)),
      scrapedAt: getIndiaTimestamp(),
    });
  }

  return observations;
}

async function scrapeNeccEgg(dateInput) {
  const { fileDateStr } = getReportDateStrings(dateInput);
  const [year, month] = fileDateStr.split("-");
  const getRes = await retry(() => httpGet("https://www.e2necc.com/home/eggprice"), "NECC", "GET eggprice");
  if (getRes.status !== 200) {
    throw new Error(`NECC GET returned status ${getRes.status}`);
  }

  const cookies = getRes.headers["set-cookie"] || "";
  const cookieStr = Array.isArray(cookies) ? cookies.join("; ") : (typeof cookies === "string" ? cookies : "");
  const postBody = new URLSearchParams({
    ddlMonth: month,
    ddlYear: year,
    rblReportType: "DailyReport",
    btnReport: "Get Sheet",
  }).toString();
  const postRes = await retry(
    () => httpPost("https://www.e2necc.com/home/eggprice", postBody, cookieStr),
    "NECC",
    "POST eggprice report form"
  );
  if (postRes.status !== 200) {
    throw new Error(`NECC POST returned status ${postRes.status}`);
  }

  const observations = parseNeccEggHtml(postRes.body, fileDateStr);
  return {
    sourceId: "necc_egg",
    heading: `NECC Daily Egg Prices ${fileDateStr}`,
    observations,
    commodityCount: observations.length ? 1 : 0,
  };
}

function parseCsbSilkHtml(html) {
  const goodsRegex = /<td headers="view-title-table-column"[^>]*>([\s\S]*?)<\/td>\s*<td headers="view-view-table-column"[^>]*>[\s\S]*?<table class="table table-bordered table-striped">([\s\S]*?)<\/table>/gi;
  const observations = [];
  let goodsMatch;

  while ((goodsMatch = goodsRegex.exec(html)) !== null) {
    const variety = decodeHtmlText(goodsMatch[1]);
    const nestedTableHtml = goodsMatch[2];
    const bodyMatch = nestedTableHtml.match(/<tbody>([\s\S]*?)<\/tbody>/i);
    if (!variety || !bodyMatch) {
      continue;
    }

    const rowRegex = /<tr>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(bodyMatch[1])) !== null) {
      observations.push({
        variety,
        market: decodeHtmlText(rowMatch[1]),
        date: decodeHtmlText(rowMatch[2]),
        min: decodeHtmlText(rowMatch[3]),
        max: decodeHtmlText(rowMatch[4]),
        average: decodeHtmlText(rowMatch[5]),
        quantity: decodeHtmlText(rowMatch[6]),
      });
    }
  }

  return observations;
}

async function scrapeCsbSilk() {
  log("CSB", "Fetching CSB silk prices page...");
  const response = await retry(() => httpGet(CSB_SILK_URL), "CSB", "GET CSB silk prices");
  if (response.status !== 200) {
    throw new Error(`CSB silk GET returned status ${response.status}`);
  }

  const extractedRows = parseCsbSilkHtml(response.body);
  if (extractedRows.length === 0) {
    throw new Error("No CSB silk price rows were parsed from the page.");
  }

  const scrapedAt = getIndiaTimestamp();
  const observations = extractedRows.map((row) => {
    const reportDate = parseDashedDateToIso(row.date);
    const market = normalizeMarketNameForDb("csb_silk", row.market);
    return {
      sourceId: "csb_silk",
      rowKey: buildObservationRowKey([reportDate, "csb_silk", "Silk", market, row.variety, ""]),
      reportDate,
      heading: "CSB Silk Prices",
      commodity: "Silk",
      perishability: "non-perishable",
      category: "miscellaneous",
      market,
      variety: row.variety,
      grade: "",
      arrivals: parseLooseNumber(row.quantity),
      unit: "",
      minPrice: parseLooseNumber(row.min),
      maxPrice: parseLooseNumber(row.max),
      modalPrice: parseLooseNumber(row.average),
      canonicalPrice: null,
      canonicalPriceUnit: null,
      price100Pieces: null,
      price1Piece: null,
      price1Tray: null,
      scrapedAt,
    };
  });

  log("CSB", `Scraped ${observations.length} CSB silk rows`);
  return {
    sourceId: "csb_silk",
    heading: "CSB Silk Prices",
    observations,
    commodityCount: observations.length ? 1 : 0,
  };
}

function parseSpicesBoardHtml(html) {
  const tbodyMatch = html.match(/<div class="tabstable marketprice">[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) {
    throw new Error("Could not locate the Spices Board market price table body.");
  }

  const observations = [];
  const rowRegex = /<tr>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(tbodyMatch[1])) !== null) {
    observations.push({
      date: decodeHtmlText(rowMatch[1]),
      commodity: decodeHtmlText(rowMatch[2]),
      market: decodeHtmlText(rowMatch[3]),
      state: decodeHtmlText(rowMatch[4]),
      grade: decodeHtmlText(rowMatch[5]),
      source: decodeHtmlText(rowMatch[6]),
      min: decodeHtmlText(rowMatch[7]),
      max: decodeHtmlText(rowMatch[8]),
      average: decodeHtmlText(rowMatch[9]),
    });
  }

  return observations;
}

async function scrapeSpicesBoard(dateInput) {
  const { fileDateStr } = getReportDateStrings(dateInput);
  const requestUrl = `${SPICES_BOARD_URL}?${new URLSearchParams({
    filterState: SPICES_BOARD_TARGET_STATE,
    dateFrom: fileDateStr,
    dateTo: fileDateStr,
  }).toString()}`;

  log("SPICES", `Fetching Spices Board market prices for ${fileDateStr}...`);
  const response = await retry(() => httpGet(requestUrl), "SPICES", "GET Spices Board current market prices");
  if (response.status !== 200) {
    throw new Error(`Spices Board GET returned status ${response.status}`);
  }

  const extractedRows = parseSpicesBoardHtml(response.body)
    .filter((row) => row.state === SPICES_BOARD_TARGET_STATE && row.market === SPICES_BOARD_TARGET_MARKET);
  if (extractedRows.length === 0) {
    throw new Error(`No Spices Board rows were found for ${SPICES_BOARD_TARGET_MARKET} on ${fileDateStr}.`);
  }

  const scrapedAt = getIndiaTimestamp();
  const observations = extractedRows
    .map((row) => {
      const reportDate = parseDmyAbbrevMonthDateToIso(row.date);
      const modalPrice = parseLooseNumber(row.average);
      if (modalPrice === null) {
        return null;
      }

      const grade = row.grade === "-" ? "" : row.grade;
      return {
        sourceId: "spices_board",
        rowKey: buildObservationRowKey([reportDate, "spices_board", row.commodity, SPICES_BOARD_TARGET_MARKET, "", grade]),
        reportDate,
        heading: "Spices Board Current Market Price",
        commodity: row.commodity,
        perishability: "non-perishable",
        category: "miscellaneous",
        market: SPICES_BOARD_TARGET_MARKET,
        variety: "",
        grade,
        arrivals: null,
        unit: "",
        minPrice: null,
        maxPrice: null,
        modalPrice,
        canonicalPrice: null,
        canonicalPriceUnit: null,
        price100Pieces: null,
        price1Piece: null,
        price1Tray: null,
        scrapedAt,
      };
    })
    .filter(Boolean);

  if (observations.length === 0) {
    throw new Error(`No Spices Board rows with average prices were found for ${SPICES_BOARD_TARGET_MARKET} on ${fileDateStr}.`);
  }

  log("SPICES", `Scraped ${observations.length} Spices Board rows`);
  return {
    sourceId: "spices_board",
    heading: "Spices Board Current Market Price",
    observations,
    commodityCount: new Set(observations.map((row) => row.commodity)).size,
  };
}

function getMonthAbbreviation(monthNumber) {
  const labels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const index = Number(monthNumber) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= labels.length) {
    throw new Error(`Invalid month number: ${monthNumber}`);
  }
  return labels[index];
}

function parseCoffeeBoardRawPriceText(text) {
  const sectionMatch = text.match(/Raw Coffee Price \(Karnataka\) as on (\d{2}\.\d{2}\.\d{4}) in ₹\/50 Kg\s+([\s\S]*?)(?:\n\s*\n|Export update:|$)/i);
  if (!sectionMatch) {
    throw new Error("Could not locate the Coffee Board raw coffee price section in the PDF.");
  }

  const reportDate = parseDottedDateToIso(sectionMatch[1]);
  const normalizedSection = sectionMatch[2].replace(/\s+/g, " ").trim();
  const rangeMatches = [...normalizedSection.matchAll(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/g)];
  if (rangeMatches.length !== COFFEE_BOARD_VARIETIES.length) {
    throw new Error(`Expected ${COFFEE_BOARD_VARIETIES.length} raw coffee price ranges, found ${rangeMatches.length}.`);
  }

  return rangeMatches.map((match, index) => ({
    reportDate,
    variety: COFFEE_BOARD_VARIETIES[index],
    minPrice: parseLooseNumber(match[1]),
    maxPrice: parseLooseNumber(match[2]),
  }));
}

async function downloadCoffeeBoardPdf(fileDateStr) {
  const [year, month, day] = fileDateStr.split("-");
  const monthRowIndex = Number(month) + 1;

  const archiveResponse = await httpGet(COFFEE_BOARD_ARCHIVE_URL);
  if (archiveResponse.status !== 200) {
    throw new Error(`Coffee Board archive GET returned status ${archiveResponse.status}`);
  }
  const sessionCookie = extractCookieHeader(archiveResponse.headers["set-cookie"], ["ASP.NET_SessionId="]);
  if (!sessionCookie) {
    throw new Error("Coffee Board archive session cookie was not returned.");
  }

  const monthForm = buildHiddenFormFields(archiveResponse.body);
  monthForm.__EVENTTARGET = `GridView1$ctl${String(monthRowIndex).padStart(2, "0")}$LinkButton${year}`;
  monthForm.__EVENTARGUMENT = "";
  monthForm.__LASTFOCUS = "";

  const monthPost = await httpPost(COFFEE_BOARD_ARCHIVE_URL, new URLSearchParams(monthForm).toString(), sessionCookie);
  if (monthPost.status !== 302) {
    throw new Error(`Coffee Board archive month POST returned status ${monthPost.status}`);
  }

  const monthPageUrl = new URL(monthPost.headers.location || "/Archives_Month.aspx", COFFEE_BOARD_ARCHIVE_URL).toString();
  const monthPageResponse = await httpGetWithCookie(monthPageUrl, sessionCookie, COFFEE_BOARD_ARCHIVE_URL);
  if (monthPageResponse.status !== 200) {
    throw new Error(`Coffee Board archive month page GET returned status ${monthPageResponse.status}`);
  }

  const monthPageHtml = monthPageResponse.body;
  const expectedDateLabel = `${year},${getMonthAbbreviation(month)},${day}`;
  const escapedDateLabel = expectedDateLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const dateTargetMatch = monthPageHtml.match(new RegExp(`__doPostBack\\(&#39;([^&]+)&#39;,&#39;[^&]*&#39;\\)">\\s*${escapedDateLabel}\\s*<\\/a>`, "i"));
  if (!dateTargetMatch) {
    throw new Error(`Coffee Board archive did not list ${expectedDateLabel}.`);
  }

  const dayForm = buildHiddenFormFields(monthPageHtml);
  dayForm.__EVENTTARGET = dateTargetMatch[1];
  dayForm.__EVENTARGUMENT = "";
  dayForm.__LASTFOCUS = "";

  const pdfResponse = await httpPostWithCookie(
    monthPageUrl,
    new URLSearchParams(dayForm).toString(),
    sessionCookie,
    monthPageUrl
  );
  if (pdfResponse.status !== 200) {
    throw new Error(`Coffee Board PDF POST returned status ${pdfResponse.status}`);
  }
  const contentType = String(pdfResponse.headers["content-type"] || "");
  if (!contentType.toLowerCase().includes("pdf")) {
    throw new Error(`Coffee Board PDF response was not a PDF. Received content-type: ${contentType}`);
  }
  return pdfResponse.body;
}

function httpGetWithCookie(requestUrl, cookieStr, referer) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(requestUrl);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: "GET",
      timeout: 30000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        Cookie: cookieStr || "",
        Referer: referer || requestUrl,
      },
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({ status: res.statusCode, body, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("HTTP timeout"));
    });
    req.end();
  });
}

function httpPostWithCookie(requestUrl, postData, cookieStr, referer) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(requestUrl);
    const body = typeof postData === "string" ? postData : new URLSearchParams(postData).toString();
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: "POST",
      timeout: 60000,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        Referer: referer || requestUrl,
        Cookie: cookieStr || "",
      },
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => {
        chunks.push(chunk);
      });
      res.on("end", () => {
        const responseBody = Buffer.concat(chunks);
        const isPdf = String(res.headers["content-type"] || "").toLowerCase().includes("pdf");
        resolve({
          status: res.statusCode,
          body: isPdf ? responseBody : responseBody.toString("utf8"),
          headers: res.headers,
        });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("HTTP POST timeout"));
    });
    req.write(body);
    req.end();
  });
}

async function scrapeCoffeeBoard(dateInput) {
  const { fileDateStr } = getReportDateStrings(dateInput);
  log("COFFEE", `Downloading Coffee Board daily report for ${fileDateStr}...`);
  const pdfBuffer = await retry(() => downloadCoffeeBoardPdf(fileDateStr), "COFFEE", "Download Coffee Board archive PDF");
  const parser = new PDFParse({ data: pdfBuffer });
  let pdfTextResult;
  try {
    pdfTextResult = await parser.getText();
  } finally {
    await parser.destroy();
  }

  const parsedRows = parseCoffeeBoardRawPriceText(pdfTextResult.text || "");
  const scrapedAt = getIndiaTimestamp();
  const observations = parsedRows.map((row) => ({
    sourceId: "coffee_board",
    rowKey: buildObservationRowKey([row.reportDate, "coffee_board", "Coffee", COFFEE_BOARD_MARKET, row.variety, ""]),
    reportDate: row.reportDate,
    heading: "Coffee Board Raw Coffee Price",
    commodity: "Coffee",
    perishability: "non-perishable",
    category: "miscellaneous",
    market: COFFEE_BOARD_MARKET,
    variety: row.variety,
    grade: "",
    arrivals: null,
    unit: "50 Kg",
    minPrice: row.minPrice,
    maxPrice: row.maxPrice,
    modalPrice: null,
    canonicalPrice: null,
    canonicalPriceUnit: null,
    price100Pieces: null,
    price1Piece: null,
    price1Tray: null,
    scrapedAt,
  }));

  if (observations.length !== COFFEE_BOARD_VARIETIES.length) {
    throw new Error(`Expected ${COFFEE_BOARD_VARIETIES.length} coffee rows, found ${observations.length}.`);
  }

  log("COFFEE", `Scraped ${observations.length} Coffee Board rows`);
  return {
    sourceId: "coffee_board",
    heading: "Coffee Board Raw Coffee Price",
    observations,
    commodityCount: 1,
  };
}

function parseRubberBoardDailyHtml(html, expectedVariety) {
  const observations = [];
  const marketBlockRegex = /<div id="(Kottayam|Kochi|Agartala)" class="tab-pane fade(?: in active)?">([\s\S]*?)<\/table>\s*<\/div>/gi;
  let marketMatch;

  while ((marketMatch = marketBlockRegex.exec(html)) !== null) {
    const market = decodeHtmlText(marketMatch[1]);
    if (!RUBBER_BOARD_TARGET_MARKETS.has(market)) {
      continue;
    }

    const tbodyMatch = marketMatch[2].match(/<tbody>([\s\S]*?)<\/tbody>/i);
    if (!tbodyMatch) {
      continue;
    }

    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(tbodyMatch[1])) !== null) {
      const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => decodeHtmlText(match[1]));
      if (cells.length < 2) {
        continue;
      }

      const reportDate = parseDashedDateToIso(cells[0]);
      const price = parseLooseNumber(cells[1]);
      if (price === null) {
        continue;
      }

      observations.push({
        market,
        reportDate,
        modalPrice: price,
        variety: expectedVariety,
      });
    }
  }

  return observations;
}

async function scrapeRubberBoard(dateInput) {
  const { dateStr } = getReportDateStrings(dateInput);
  const requestDate = parseDashedDateToIso(dateStr.replace(/\//g, "-"));
  const formattedDate = `${dateStr.slice(0, 2)}-${dateStr.slice(3, 5)}-${dateStr.slice(6, 10)}`;

  log("RUBBER", `Fetching Rubber Board daily prices for ${formattedDate}...`);
  const getRes = await retry(() => httpGet("https://rubberboard.gov.in/public"), "RUBBER", "GET Rubber Board public home");
  if (getRes.status !== 200) {
    throw new Error(`Rubber Board GET returned status ${getRes.status}`);
  }

  const cookies = getRes.headers["set-cookie"] || "";
  const cookieStr = Array.isArray(cookies) ? cookies.join("; ") : (typeof cookies === "string" ? cookies : "");
  const scrapedAt = getIndiaTimestamp();
  const observations = [];

  for (const gradeConfig of RUBBER_BOARD_GRADE_CONFIG) {
    const postBody = new URLSearchParams({
      searchFlag: "day",
      type: "indian",
      txtFromDate: formattedDate,
      txtToDate: formattedDate,
      grade: gradeConfig.gradeId,
    }).toString();
    const response = await retry(
      () => httpPost(RUBBER_BOARD_URL, postBody, cookieStr),
      "RUBBER",
      `POST Rubber Board daily search for ${gradeConfig.variety}`
    );
    if (response.status !== 200) {
      throw new Error(`Rubber Board POST returned status ${response.status} for ${gradeConfig.variety}`);
    }

    const parsedRows = parseRubberBoardDailyHtml(response.body, gradeConfig.variety)
      .filter((row) => row.reportDate === requestDate);
    if (parsedRows.length === 0) {
      log("RUBBER", `No ${gradeConfig.variety} rows found for ${formattedDate}`);
      continue;
    }

    for (const row of parsedRows) {
      const market = normalizeMarketNameForDb("rubber_board", row.market);
      observations.push({
        sourceId: "rubber_board",
        rowKey: buildObservationRowKey([row.reportDate, "rubber_board", "Rubber", market, row.variety, ""]),
        reportDate: row.reportDate,
        heading: "Rubber Board Daily Market Price",
        commodity: "Rubber",
        perishability: "non-perishable",
        category: "miscellaneous",
        market,
        variety: row.variety,
        grade: "",
        arrivals: null,
        unit: "",
        minPrice: null,
        maxPrice: null,
        modalPrice: row.modalPrice,
        canonicalPrice: null,
        canonicalPriceUnit: null,
        price100Pieces: null,
        price1Piece: null,
        price1Tray: null,
        scrapedAt,
      });
    }
  }

  log("RUBBER", `Scraped ${observations.length} Rubber Board rows`);
  return {
    sourceId: "rubber_board",
    heading: "Rubber Board Daily Market Price",
    observations,
    commodityCount: observations.length ? 1 : 0,
  };
}

function ensureLocalDatabaseExists() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`Local database not found at ${DB_PATH}. Run npm run build:static-db first.`);
  }
}

function ensureExpectedDbSchema(db) {
  const columns = db.prepare("PRAGMA table_info(price_observations)").all().map((row) => row.name);
  const requiredColumns = ["source_id", "canonical_price", "price_100_pieces", "price_1_piece", "price_1_tray"];
  const missing = requiredColumns.filter((column) => !columns.includes(column));
  if (missing.length) {
    throw new Error(`Local DB schema is outdated. Missing columns: ${missing.join(", ")}. Run npm run build:static-db first.`);
  }
}

function syncLocalDb(payload, context) {
  ensureLocalDatabaseExists();
  const db = new Database(DB_PATH);

  try {
    db.pragma("foreign_keys = ON");
    ensureExpectedDbSchema(db);
    const commodityCategoryStmt = db.prepare(`
      SELECT c.category AS category, c.perishability AS perishability
      FROM commodities c
      WHERE c.name = ?
    `);
    const insertCommodity = db.prepare(`
      INSERT INTO commodities (name, perishability, category)
      VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        perishability = COALESCE(excluded.perishability, commodities.perishability),
        category = COALESCE(excluded.category, commodities.category)
    `);
    const insertCommodityMapping = db.prepare(`
      INSERT INTO commodity_mapping (commodity_id, perishability, category, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(commodity_id) DO UPDATE SET
        perishability = excluded.perishability,
        category = excluded.category,
        updated_at = excluded.updated_at
    `);
    const insertMarket = db.prepare("INSERT OR IGNORE INTO markets (name) VALUES (?)");
    const insertVariety = db.prepare("INSERT OR IGNORE INTO varieties (name) VALUES (?)");
    const insertGrade = db.prepare("INSERT OR IGNORE INTO grades (name) VALUES (?)");
    const insertUnit = db.prepare("INSERT OR IGNORE INTO units (name) VALUES (?)");
    const getId = (table, name) => db.prepare(`SELECT id FROM ${table} WHERE name = ?`).get(name);
    const upsertObservation = db.prepare(`
      INSERT INTO price_observations (
        row_key, report_date, heading, commodity_id, market_id, variety_id, grade_id, arrivals, unit_id,
        min_price, max_price, modal_price, source_id, canonical_price, canonical_price_unit,
        price_100_pieces, price_1_piece, price_1_tray, scraped_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(row_key) DO UPDATE SET
        heading = excluded.heading,
        arrivals = excluded.arrivals,
        unit_id = excluded.unit_id,
        min_price = excluded.min_price,
        max_price = excluded.max_price,
        modal_price = excluded.modal_price,
        canonical_price = excluded.canonical_price,
        canonical_price_unit = excluded.canonical_price_unit,
        price_100_pieces = excluded.price_100_pieces,
        price_1_piece = excluded.price_1_piece,
        price_1_tray = excluded.price_1_tray,
        scraped_at = excluded.scraped_at
    `);
    const upsertRun = db.prepare(`
      INSERT INTO scrape_runs (
        run_id, started_at, finished_at, report_date, status, commodity_count, row_count,
        source_id, sink_id, output_dir, json_path, csv_path, log_path, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        finished_at = excluded.finished_at,
        status = excluded.status,
        commodity_count = excluded.commodity_count,
        row_count = excluded.row_count,
        source_id = excluded.source_id,
        sink_id = excluded.sink_id,
        log_path = excluded.log_path,
        notes = excluded.notes
    `);

    const transaction = db.transaction(() => {
      for (const row of payload.observations) {
        const existingCommodity = commodityCategoryStmt.get(row.commodity);
        insertCommodity.run(
          row.commodity,
          row.perishability || (existingCommodity ? existingCommodity.perishability : null),
          row.category || (existingCommodity ? existingCommodity.category : null)
        );
        insertMarket.run(row.market);
        if (row.variety) {
          insertVariety.run(row.variety);
        }
        if (row.grade) {
          insertGrade.run(row.grade);
        }
        if (row.unit) {
          insertUnit.run(row.unit);
        }

        const commodityId = getId("commodities", row.commodity).id;
        const marketId = getId("markets", row.market).id;
        const varietyId = row.variety ? getId("varieties", row.variety).id : null;
        const gradeId = row.grade ? getId("grades", row.grade).id : null;
        const unitId = row.unit ? getId("units", row.unit).id : null;

        if (row.perishability && row.category) {
          insertCommodityMapping.run(commodityId, row.perishability, row.category, context.finishedAt || context.scrapedAt);
        }

        upsertObservation.run(
          row.rowKey,
          row.reportDate,
          row.heading,
          commodityId,
          marketId,
          varietyId,
          gradeId,
          row.arrivals,
          unitId,
          row.minPrice,
          row.maxPrice,
          row.modalPrice,
          row.sourceId,
          row.canonicalPrice,
          row.canonicalPriceUnit,
          row.price100Pieces,
          row.price1Piece,
          row.price1Tray,
          row.scrapedAt
        );
      }

      upsertRun.run(
        context.runId,
        context.startedAt,
        context.finishedAt,
        context.fileDateStr,
        context.status,
        payload.commodityCount,
        payload.observations.length,
        payload.sourceId,
        context.sinkId,
        null,
        null,
        null,
        context.logPath || null,
        context.errorMessage || `${payload.sourceId} -> ${context.sinkId}`
      );
    });

    transaction();
    return { rows: payload.observations.length, source: payload.sourceId };
  } finally {
    db.close();
  }
}

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function getGoogleAccessToken(email, privateKey) {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: email,
    scope: GOOGLE_SHEETS_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };

  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsignedToken), privateKey);
  const assertion = `${unsignedToken}.${base64Url(signature)}`;

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  const payloadJson = await response.json();
  if (!response.ok) {
    throw new Error(`Google token request failed: ${response.status} ${JSON.stringify(payloadJson)}`);
  }

  return payloadJson.access_token;
}

async function sheetsRequest(spreadsheetId, token, method, apiPath, body) {
  const response = await fetch(`${GOOGLE_SHEETS_API_BASE}/${spreadsheetId}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`Google Sheets request failed: ${response.status} ${text}`);
  }

  return parsed;
}

async function getSpreadsheetMetadata(spreadsheetId, token) {
  return sheetsRequest(spreadsheetId, token, "GET", "?fields=sheets.properties", null);
}

async function ensureSheetExists(spreadsheetId, token, sheetName) {
  const metadata = await getSpreadsheetMetadata(spreadsheetId, token);
  const existing = (metadata.sheets || []).find((sheet) => sheet.properties && sheet.properties.title === sheetName);
  if (existing) {
    return existing.properties.sheetId;
  }

  const created = await sheetsRequest(spreadsheetId, token, "POST", ":batchUpdate", {
    requests: [
      {
        addSheet: {
          properties: {
            title: sheetName,
          },
        },
      },
    ],
  });

  return created.replies[0].addSheet.properties.sheetId;
}

async function getSheetValues(spreadsheetId, token, range) {
  const encodedRange = encodeURIComponent(range);
  const result = await sheetsRequest(spreadsheetId, token, "GET", `/values/${encodedRange}`, null);
  return result && result.values ? result.values : [];
}

async function updateSheetRange(spreadsheetId, token, range, values) {
  const encodedRange = encodeURIComponent(range);
  return sheetsRequest(spreadsheetId, token, "PUT", `/values/${encodedRange}?valueInputOption=RAW`, {
    range,
    majorDimension: "ROWS",
    values,
  });
}

async function appendSheetRows(spreadsheetId, token, range, values) {
  const encodedRange = encodeURIComponent(range);
  return sheetsRequest(spreadsheetId, token, "POST", `/values/${encodedRange}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    range,
    majorDimension: "ROWS",
    values,
  });
}

async function batchUpdateValues(spreadsheetId, token, data) {
  return sheetsRequest(spreadsheetId, token, "POST", "/values:batchUpdate", {
    valueInputOption: "RAW",
    data,
  });
}

async function batchUpdateSpreadsheet(spreadsheetId, token, requests) {
  return sheetsRequest(spreadsheetId, token, "POST", ":batchUpdate", { requests });
}

async function ensureSheetHeaders(spreadsheetId, token, sheetName, headers) {
  await ensureSheetExists(spreadsheetId, token, sheetName);
  const values = await getSheetValues(spreadsheetId, token, `${sheetName}!1:1`);
  if (!values[0] || values[0].join("|") !== headers.join("|")) {
    await updateSheetRange(spreadsheetId, token, `${sheetName}!A1`, [headers]);
  }
}

function rowToSheetValues(row, headers) {
  return headers.map((header) => row[header] ?? "");
}

function parseReportDateValue(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) {
    return null;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  return new Date(Date.UTC(year, month - 1, day));
}

function getRetentionCutoff(reportDate) {
  const anchorDate = parseReportDateValue(reportDate);
  if (!anchorDate) {
    throw new Error(`Invalid report date for retention: ${reportDate}`);
  }

  anchorDate.setUTCDate(anchorDate.getUTCDate() - (PRICE_RETENTION_DAYS - 1));
  return anchorDate;
}

async function syncPricesSheet(spreadsheetId, token, sheetName, rows) {
  await ensureSheetHeaders(spreadsheetId, token, sheetName, PRICE_SHEET_COLUMNS);
  const lastPriceColumn = toColumnLetter(PRICE_SHEET_COLUMNS.length);
  const existing = await getSheetValues(spreadsheetId, token, `${sheetName}!A2:${lastPriceColumn}`);
  const existingRowMap = new Map();

  existing.forEach((row, index) => {
    if (row[0]) {
      existingRowMap.set(row[0], {
        rowNumber: index + 2,
        existingValues: row,
      });
    }
  });

  const updates = [];
  const appends = [];
  for (const row of rows) {
    const values = rowToSheetValues(row, PRICE_SHEET_COLUMNS);
    const existingRowInfo = existingRowMap.get(row.row_key);
    if (existingRowInfo) {
      // Preserve sheet-managed perishability values during scraper upserts.
      values[4] = existingRowInfo.existingValues[4] || "";
      updates.push({
        range: `${sheetName}!A${existingRowInfo.rowNumber}:${lastPriceColumn}${existingRowInfo.rowNumber}`,
        majorDimension: "ROWS",
        values: [values],
      });
    } else {
      appends.push(values);
    }
  }

  if (updates.length > 0) {
    await batchUpdateValues(spreadsheetId, token, updates);
  }
  if (appends.length > 0) {
    await appendSheetRows(spreadsheetId, token, `${sheetName}!A:${lastPriceColumn}`, appends);
  }

  return { updated: updates.length, appended: appends.length };
}

async function prunePricesSheet(spreadsheetId, token, sheetName, anchorReportDate) {
  const sheetId = await ensureSheetExists(spreadsheetId, token, sheetName);
  const lastPriceColumn = toColumnLetter(PRICE_SHEET_COLUMNS.length);
  const existing = await getSheetValues(spreadsheetId, token, `${sheetName}!A2:${lastPriceColumn}`);
  const cutoffDate = getRetentionCutoff(anchorReportDate);
  const rowsToDelete = [];

  existing.forEach((row, index) => {
    const reportDate = parseReportDateValue(row[1] || "");
    if (reportDate && reportDate < cutoffDate) {
      rowsToDelete.push(index + 1);
    }
  });

  if (rowsToDelete.length === 0) {
    return { deleted: 0, cutoff: cutoffDate.toISOString().slice(0, 10) };
  }

  const requests = rowsToDelete
    .sort((left, right) => right - left)
    .map((zeroBasedRowIndex) => {
      return {
        deleteDimension: {
          range: {
            sheetId,
            dimension: "ROWS",
            startIndex: zeroBasedRowIndex,
            endIndex: zeroBasedRowIndex + 1,
          },
        },
      };
    });

  await batchUpdateSpreadsheet(spreadsheetId, token, requests);
  return { deleted: rowsToDelete.length, cutoff: cutoffDate.toISOString().slice(0, 10) };
}

async function appendRunSheetRow(spreadsheetId, token, sheetName, runRow) {
  await ensureSheetHeaders(spreadsheetId, token, sheetName, RUN_SHEET_COLUMNS);
  await appendSheetRows(spreadsheetId, token, `${sheetName}!A:L`, [rowToSheetValues(runRow, RUN_SHEET_COLUMNS)]);
}

async function syncGoogleSheets(data, context) {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = normalizePrivateKey(process.env.GOOGLE_PRIVATE_KEY);
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

  if (!email || !privateKey || !spreadsheetId) {
    throw new Error("Missing Google Sheets credentials. Expected GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, and GOOGLE_SPREADSHEET_ID.");
  }

  const token = await getGoogleAccessToken(email, privateKey);
  const pricesSheetName = process.env.GOOGLE_PRICES_SHEET_NAME || DEFAULT_PRICE_SHEET_NAME;
  const runsSheetName = process.env.GOOGLE_RUNS_SHEET_NAME || DEFAULT_RUNS_SHEET_NAME;
  const flattenedRows = flattenRowsForSheets(data, context.fileDateStr, context.scrapedAt);

  const pricesResult = await syncPricesSheet(spreadsheetId, token, pricesSheetName, flattenedRows);
  const retentionResult = await prunePricesSheet(spreadsheetId, token, pricesSheetName, context.fileDateStr);
  const runRow = {
    run_id: context.runId,
    started_at: context.startedAt,
    finished_at: context.finishedAt,
    report_date: context.fileDateStr,
    status: context.status,
    commodity_count: String(data.commodities.length),
    row_count: String(flattenedRows.length),
    output_dir: "",
    json_path: "",
    csv_path: "",
    log_path: context.logPath || "",
    notes: `prices updated=${pricesResult.updated}, appended=${pricesResult.appended}, pruned=${retentionResult.deleted}, cutoff=${retentionResult.cutoff}`,
  };

  await appendRunSheetRow(spreadsheetId, token, runsSheetName, runRow);
  return {
    prices: pricesResult,
    retention: retentionResult,
    runsSheet: runsSheetName,
    pricesSheet: pricesSheetName,
  };
}

async function appendFailedRunIfPossible(context) {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = normalizePrivateKey(process.env.GOOGLE_PRIVATE_KEY);
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  if (!email || !privateKey || !spreadsheetId) {
    return;
  }

  try {
    const token = await getGoogleAccessToken(email, privateKey);
    const runsSheetName = process.env.GOOGLE_RUNS_SHEET_NAME || DEFAULT_RUNS_SHEET_NAME;
    await appendRunSheetRow(spreadsheetId, token, runsSheetName, {
      run_id: context.runId,
      started_at: context.startedAt,
      finished_at: context.finishedAt,
      report_date: context.fileDateStr,
      status: context.status,
      commodity_count: "0",
      row_count: "0",
      output_dir: "",
      json_path: "",
      csv_path: "",
      log_path: context.logPath || "",
      notes: context.errorMessage || "Run failed",
    });
  } catch (error) {
    log("SHEETS", `Skipping failed-run sheet log: ${error.message}`);
  }
}

function appendFailedRunToLocalDb(context) {
  ensureLocalDatabaseExists();
  const db = new Database(DB_PATH);
  try {
    ensureExpectedDbSchema(db);
    db.prepare(`
      INSERT INTO scrape_runs (
        run_id, started_at, finished_at, report_date, status, commodity_count, row_count,
        source_id, sink_id, output_dir, json_path, csv_path, log_path, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        finished_at = excluded.finished_at,
        status = excluded.status,
        log_path = excluded.log_path,
        notes = excluded.notes
    `).run(
      context.runId,
      context.startedAt,
      context.finishedAt,
      context.fileDateStr,
      context.status,
      0,
      0,
      context.sourceId,
      context.sinkId,
      null,
      null,
      null,
      context.logPath || null,
      context.errorMessage || "Run failed"
    );
  } finally {
    db.close();
  }
}

async function scrape(dateStr) {
  try {
    log("METHOD", "=== Trying Method 1: Direct HTTP POST (no browser) ===");
    const httpData = await scrapeWithHttp(dateStr);
    if (httpData && httpData.commodities && httpData.commodities.length > 0) {
      log("METHOD", "HTTP POST method succeeded");
      return httpData;
    }
    log("METHOD", "HTTP POST returned no commodity rows, falling back");
  } catch (error) {
    log("METHOD", `HTTP POST failed: ${error.message}`);
  }

  try {
    log("METHOD", "=== Trying Method 2: Playwright headless browser ===");
    const pwHeadlessData = await scrapeWithPlaywright(dateStr, true);
    if (pwHeadlessData && pwHeadlessData.commodities && pwHeadlessData.commodities.length > 0) {
      log("METHOD", "Playwright headless method succeeded");
      return pwHeadlessData;
    }
    log("METHOD", "Playwright headless returned no commodity rows");
  } catch (error) {
    log("METHOD", `Playwright headless failed: ${error.message}`);
  }

  log("METHOD", "=== Trying Method 3: Playwright headful browser ===");
  const pwHeadfulData = await scrapeWithPlaywright(dateStr, false);
  if (pwHeadfulData && pwHeadfulData.commodities && pwHeadfulData.commodities.length > 0) {
    log("METHOD", "Playwright headful method succeeded");
    return pwHeadfulData;
  }

  throw new Error("All scrape methods failed or returned no commodity rows");
}

async function scrapeSource(sourceId, dateInput) {
  const { dateStr, fileDateStr } = getReportDateStrings(dateInput);
  if (sourceId === "necc_egg") {
    const neccData = await scrapeNeccEgg(dateInput);
    return {
      ...neccData,
      reportDate: fileDateStr,
      scrapedAt: getIndiaTimestamp(),
    };
  }
  if (sourceId === "csb_silk") {
    const silkData = await scrapeCsbSilk();
    return {
      ...silkData,
      reportDate: fileDateStr,
      scrapedAt: getIndiaTimestamp(),
    };
  }
  if (sourceId === "rubber_board") {
    const rubberData = await scrapeRubberBoard(dateInput);
    return {
      ...rubberData,
      reportDate: fileDateStr,
      scrapedAt: getIndiaTimestamp(),
    };
  }
  if (sourceId === "spices_board") {
    const spicesData = await scrapeSpicesBoard(dateInput);
    return {
      ...spicesData,
      reportDate: fileDateStr,
      scrapedAt: getIndiaTimestamp(),
    };
  }
  if (sourceId === "coffee_board") {
    const coffeeData = await scrapeCoffeeBoard(dateInput);
    return {
      ...coffeeData,
      reportDate: fileDateStr,
      scrapedAt: getIndiaTimestamp(),
    };
  }

  const data = await scrape(dateStr);
  return {
    sourceId: "krama",
    heading: data.heading || "",
    observations: normalizeKramaData(data, fileDateStr, getIndiaTimestamp()),
    commodityCount: data.commodities.length,
    reportDate: fileDateStr,
    scrapedAt: getIndiaTimestamp(),
  };
}

async function runScrapeForDate(dateInput, options) {
  const { dateStr, fileDateStr } = getReportDateStrings(dateInput);
  const runId = crypto.randomUUID();
  const startedAt = getIndiaTimestamp();

  log("INIT", `App root: ${APP_ROOT_DIR}`);
  log("INIT", `Log file: ${logState ? logState.logPath : "disabled"}`);
  log("INIT", `Date: ${dateStr} (${fileDateStr})`);
  log("INIT", `Source: ${options.sourceId}`);
  log("INIT", `Sink: ${options.sinkId}`);

  const context = {
    runId,
    startedAt,
    finishedAt: "",
    fileDateStr,
    sourceId: options.sourceId,
    sinkId: options.sinkId,
    logPath: logState ? logState.logPath : "",
    scrapedAt: "",
    status: "started",
    errorMessage: "",
  };

  try {
    const payload = await scrapeSource(options.sourceId, dateInput);
    context.scrapedAt = payload.scrapedAt || getIndiaTimestamp();
    context.finishedAt = getIndiaTimestamp();
    context.status = "success";

    if (options.sinkId === "google_sheets") {
      if (options.sourceId !== "krama") {
        throw new Error("Google Sheets sink is only supported for the legacy KRAMA source.");
      }
      log("SHEETS", "Syncing prices and run logs to Google Sheets...");
      const syncResult = await syncGoogleSheets({
        heading: payload.heading,
        commodities: payload.observations.reduce((groups, row) => {
          let group = groups.find((entry) => entry.name === row.commodity);
          if (!group) {
            group = { name: row.commodity, data: [] };
            groups.push(group);
          }
          group.data.push({
            Market: row.market,
            Variety: row.variety,
            Grade: row.grade,
            Arrivals: row.arrivals ?? "",
            Units: row.unit,
            "Min (Rs.)": row.minPrice ?? "",
            "Max (Rs.)": row.maxPrice ?? "",
            "Modal (Rs.)": row.modalPrice ?? "",
          });
          return groups;
        }, []),
      }, context);
      log("SHEETS", `Sync complete. prices updated=${syncResult.prices.updated}, appended=${syncResult.prices.appended}`);
    } else {
      const syncResult = syncLocalDb(payload, context);
      log("DB", `Local DB sync complete. source=${syncResult.source}, rows=${syncResult.rows}`);
    }

    const totalRows = payload.observations.length;
    log("DONE", `Successfully scraped ${payload.commodityCount} commodities and ${totalRows} total rows`);
    return {
      ok: true,
      sourceId: options.sourceId,
      sinkId: options.sinkId,
      reportDate: fileDateStr,
      commodityCount: payload.commodityCount,
      rowCount: totalRows,
      finishedAt: context.finishedAt,
      logPath: context.logPath,
    };
  } catch (error) {
    context.finishedAt = getIndiaTimestamp();
    context.status = "failed";
    context.errorMessage = error.message;
    logError("ERROR", error);
    if (options.sinkId === "google_sheets") {
      await appendFailedRunIfPossible(context);
    } else {
      appendFailedRunToLocalDb(context);
    }
    return {
      ok: false,
      sourceId: options.sourceId,
      sinkId: options.sinkId,
      reportDate: fileDateStr,
      error: error.message,
      finishedAt: context.finishedAt,
      logPath: context.logPath,
    };
  }
}

function htmlPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>KRAMA Scraper</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4efe6;
      --panel: #fffaf2;
      --ink: #1b1f1f;
      --muted: #5c635f;
      --accent: #1f6f43;
      --accent-2: #d6842a;
      --border: #d8cfbf;
      --shadow: 0 18px 45px rgba(48, 42, 31, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Segoe UI", Arial, sans-serif;
      background:
        radial-gradient(circle at top left, rgba(214, 132, 42, 0.22), transparent 28%),
        linear-gradient(135deg, #f7f1e8, var(--bg));
      color: var(--ink);
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .card {
      width: min(100%, 520px);
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 24px;
      box-shadow: var(--shadow);
      padding: 28px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 30px;
      letter-spacing: -0.02em;
    }
    p {
      margin: 0 0 24px;
      color: var(--muted);
      line-height: 1.5;
    }
    label {
      display: block;
      font-weight: 600;
      margin-bottom: 10px;
    }
    input[type="date"] {
      width: 100%;
      padding: 14px 16px;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: white;
      font-size: 16px;
    }
    select {
      width: 100%;
      padding: 14px 16px;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: white;
      font-size: 16px;
      margin-bottom: 16px;
    }
    .source-panel {
      margin-top: 6px;
      margin-bottom: 8px;
      padding: 14px 16px;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: #fff;
      color: var(--muted);
      line-height: 1.5;
      font-size: 14px;
    }
    button {
      width: 100%;
      margin-top: 18px;
      padding: 14px 16px;
      border: 0;
      border-radius: 14px;
      background: linear-gradient(135deg, var(--accent), #2f8f59);
      color: white;
      font-size: 16px;
      font-weight: 700;
      cursor: pointer;
      transition: transform 120ms ease, opacity 120ms ease;
    }
    button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
      transform: none;
    }
    button:not(:disabled):hover {
      transform: translateY(-1px);
    }
    .status {
      margin-top: 18px;
      padding: 14px 16px;
      border-radius: 14px;
      background: #f1ebdf;
      color: var(--ink);
      white-space: pre-wrap;
      min-height: 56px;
    }
    .status.error {
      background: #fce8e6;
      color: #8a1f17;
    }
    .status.success {
      background: #e8f4ea;
      color: #14532d;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Commodity Scraper</h1>
    <p>Select a source and report date. The scraper writes to the local database by default and keeps logs in the local logs folder.</p>
    <label for="sourceId">Scraping Source</label>
    <select id="sourceId">
      <option value="krama">KRAMA commodity prices</option>
      <option value="necc_egg">NECC egg prices</option>
      <option value="csb_silk">CSB silk prices</option>
      <option value="rubber_board">Rubber Board prices</option>
      <option value="spices_board">Spices Board prices</option>
      <option value="coffee_board">Coffee Board prices</option>
    </select>
    <div id="sourcePanel" class="source-panel">KRAMA: scrapes the selected report date and writes results to the local DB.</div>
    <div id="dateField">
      <label for="reportDate">Report Date</label>
      <input id="reportDate" type="date" max="9999-12-31">
    </div>
    <button id="fetchButton" type="button" disabled>Fetch Data</button>
    <div id="status" class="status">Select a date to begin.</div>
  </div>
  <script>
    const sourceInput = document.getElementById("sourceId");
    const dateInput = document.getElementById("reportDate");
    const dateField = document.getElementById("dateField");
    const fetchButton = document.getElementById("fetchButton");
    const statusEl = document.getElementById("status");
    const sourcePanel = document.getElementById("sourcePanel");

    const sourceCopy = {
      krama: "KRAMA: scrapes the selected report date and writes commodity market rows to the local DB.",
      necc_egg: "NECC Egg: scrapes the Daily Rate Sheet for the selected month/year and stores Bengaluru and Mysuru egg prices for the selected day.",
      csb_silk: "CSB Silk: fetches today's official silk price page and stores market rows in the local DB.",
      rubber_board: "Rubber Board: posts the selected date to the official daily market price form and stores Kottayam and Kochi rows for RSS4, RSS5, ISNR20, and Latex (60%).",
      spices_board: "Spices Board: fetches the selected date from the official current market price page with Kerala fixed and stores Cochin rows for all listed spices.",
      coffee_board: "Coffee Board: downloads the official dated PDF report from the archive and stores Karnataka raw coffee price ranges for the four daily varieties."
    };

    function sourceNeedsDate(sourceId) {
      return sourceId !== "csb_silk";
    }

    function setStatus(message, state) {
      statusEl.textContent = message;
      statusEl.className = "status" + (state ? " " + state : "");
    }

    function syncSourceUi() {
      const needsDate = sourceNeedsDate(sourceInput.value);
      sourcePanel.textContent = sourceCopy[sourceInput.value] || "";
      dateField.hidden = !needsDate;
      fetchButton.textContent = needsDate ? "Fetch Data" : "Fetch Today's Data";
      fetchButton.disabled = needsDate ? !dateInput.value : false;
      if (!needsDate) {
        setStatus("Ready to fetch today's data.");
      } else if (!dateInput.value) {
        setStatus("Select a date to begin.");
      }
    }

    dateInput.addEventListener("input", () => {
      if (!sourceNeedsDate(sourceInput.value)) {
        return;
      }
      fetchButton.disabled = !dateInput.value;
      if (!dateInput.value) {
        setStatus("Select a date to begin.");
      }
    });
    sourceInput.addEventListener("change", syncSourceUi);
    syncSourceUi();

    fetchButton.addEventListener("click", async () => {
      fetchButton.disabled = true;
      sourceInput.disabled = true;
      dateInput.disabled = true;
      setStatus("Fetching data and updating the local database. This can take a few seconds.");

      try {
        const response = await fetch("/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            date: sourceNeedsDate(sourceInput.value) ? dateInput.value : null,
            sourceId: sourceInput.value
          })
        });
        const result = await response.json();
        if (!response.ok || !result.ok) {
          throw new Error(result.error || "Run failed");
        }
        setStatus(
          "Completed successfully.\\n" +
          "Source: " + result.sourceId + "\\n" +
          "Sink: " + result.sinkId + "\\n" +
          "Report date: " + result.reportDate + "\\n" +
          "Commodities: " + result.commodityCount + "\\n" +
          "Rows: " + result.rowCount + "\\n" +
          "Log: " + result.logPath,
          "success"
        );
      } catch (error) {
        setStatus("Run failed.\\n" + error.message, "error");
      } finally {
        sourceInput.disabled = false;
        dateInput.disabled = false;
        fetchButton.disabled = sourceNeedsDate(sourceInput.value) ? !dateInput.value : false;
      }
    });
  </script>
</body>
</html>`;
}

function openBrowser(url) {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

function normalizeUiDate(dateValue) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue || "");
  if (!match) {
    throw new Error("Invalid date. Select a date from the picker.");
  }
  return `${match[3]}/${match[2]}/${match[1]}`;
}

async function startUiServer(options) {
  let isRunning = false;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(htmlPage());
        return;
      }

      if (req.method === "POST" && req.url === "/run") {
        if (isRunning) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "A scrape is already in progress." }));
          return;
        }

        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", async () => {
          try {
            const payload = JSON.parse(body || "{}");
            const sourceId = payload.sourceId === "necc_egg"
              ? "necc_egg"
              : payload.sourceId === "csb_silk"
                ? "csb_silk"
                : payload.sourceId === "rubber_board"
                  ? "rubber_board"
                  : payload.sourceId === "spices_board"
                    ? "spices_board"
                    : payload.sourceId === "coffee_board"
                      ? "coffee_board"
                : "krama";
            const selectedDate = sourceId === "csb_silk" ? null : normalizeUiDate(payload.date);
            isRunning = true;
            const result = await runScrapeForDate(selectedDate, {
              ...options,
              sourceId,
              sinkId: DEFAULT_SINK_ID,
              syncSheets: false,
              pauseOnExit: false,
              uiMode: true,
            });
            res.writeHead(result.ok ? 200 : 500, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
          } catch (error) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: error.message }));
          } finally {
            isRunning = false;
          }
        });
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: error.message }));
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const appUrl = `http://127.0.0.1:${address.port}/`;
  log("UI", `Date picker UI running at ${appUrl}`);
  openBrowser(appUrl);
  log("UI", "Browser launched. Keep this window open while using the app.");
}

async function main() {
  loadDotEnvFile(ENV_PATH);
  setupLogging();
  const options = parseArgs(process.argv.slice(2));

  if (options.uiMode) {
    await startUiServer(options);
    return;
  }

  const result = await runScrapeForDate(options.date, options);
  if (options.pauseOnExit) {
    await pauseForExitIfNeeded();
  }
  closeLogging();
  process.exitCode = result.ok ? 0 : 1;
}

main().catch(async (error) => {
  if (!logState) {
    setupLogging();
  }
  logError("ERROR", error);
  closeLogging();
  process.exitCode = 1;
});
