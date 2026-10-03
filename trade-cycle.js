/**
 * Bybit auto trade cycle — secrets ONLY from env (never client).
 * Set in Netlify: BYBIT_API_KEY, BYBIT_API_SECRET
 * Optional: BYBIT_BASE_URL (default https://api.bybit.com)
 * No min/max USD caps — apportions full free USDT across buys.
 */

const crypto = require("crypto");
const https = require("https");

const RECV = "5000";

function env(k, d) {
  return process.env[k] != null && process.env[k] !== "" ? process.env[k] : d;
}

function request(method, path, query, bodyObj, apiKey, apiSecret, baseHost) {
  const body = bodyObj ? JSON.stringify(bodyObj) : "";
  const timestamp = Date.now().toString();
  const queryStr = query || "";
  const preSign =
    timestamp + apiKey + RECV + (method === "GET" ? queryStr : body);
  const sign = crypto
    .createHmac("sha256", apiSecret)
    .update(preSign)
    .digest("hex");

  const urlPath =
    method === "GET" && queryStr ? path + "?" + queryStr : path;

  const opts = {
    hostname: baseHost,
    path: urlPath,
    method,
    headers: {
      "Content-Type": "application/json",
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-SIGN": sign,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": RECV,
      "X-BAPI-SIGN-TYPE": "2",
    },
  };
  if (body && method !== "GET") {
    opts.headers["Content-Length"] = Buffer.byteLength(body);
  }

  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data || "{}"));
        } catch (e) {
          reject(new Error("Bad JSON: " + data.slice(0, 200)));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    if (body && method !== "GET") req.write(body);
    req.end();
  });
}

function publicGet(path, baseHost) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: baseHost, path, method: "GET" },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data || "{}"));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(12000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return typeof event.body === "string" ? JSON.parse(event.body) : event.body;
  } catch (e) {
    return {};
  }
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ ok: false, error: "POST only" }),
    };
  }

  // Prefer Crypto_Bybit_* (set in Netlify UI for this site)
  const apiKey =
    env("Crypto_Bybit_API_Key", "") ||
    env("CRYPTO_BYBIT_API_KEY", "") ||
    env("BYBIT_API_KEY", "") ||
    env("Crypto_Netlify_API_Key", "") ||
    env("CRYPTO_NETLIFY_API_KEY", "");
  const apiSecret =
    env("Crypto_Bybit_API_Secret", "") ||
    env("CRYPTO_BYBIT_API_SECRET", "") ||
    env("BYBIT_API_SECRET", "") ||
    env("Crypto_Netlify_API_Secret", "") ||
    env("CRYPTO_NETLIFY_API_SECRET", "");
  const baseHost = (env("BYBIT_BASE_URL", "https://api.bybit.com") || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");

  const body = parseBody(event);
  const dryRun = !!body.dryRun;

  if (!dryRun && (!apiKey || !apiSecret)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        ok: false,
        error:
          "Missing API key/secret. Set Crypto_Bybit_API_Key + Crypto_Bybit_API_Secret in Netlify env (Functions + Runtime scopes), then redeploy.",
        seen: {
          hasKey: !!apiKey,
          hasSecret: !!apiSecret,
        },
      }),
    };
  }
  const sells = Array.isArray(body.sells) ? body.sells : [];
  const buys = Array.isArray(body.buys) ? body.buys : [];
  // sells: [{ symbol: "NEARUSDT" }]
  // buys:  [{ symbol: "SUIUSDT" }]

  const log = [];
  const results = { sells: [], buys: [], balances: {} };

  try {
    // Account type: try UNIFIED then SPOT
    let usdtFree = 0;
    let wallet = await request(
      "GET",
      "/v5/account/wallet-balance",
      "accountType=UNIFIED",
      null,
      apiKey,
      apiSecret,
      baseHost
    );
    if (wallet.retCode !== 0) {
      wallet = await request(
        "GET",
        "/v5/account/wallet-balance",
        "accountType=SPOT",
        null,
        apiKey,
        apiSecret,
        baseHost
      );
    }
    if (wallet.retCode !== 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          ok: false,
          error: "Wallet: " + (wallet.retMsg || JSON.stringify(wallet)),
        }),
      };
    }

    const lists = wallet.result?.list || [];
    const coins = [];
    lists.forEach((acc) => {
      (acc.coin || []).forEach((c) => {
        const free = parseFloat(c.walletBalance || c.equity || 0);
        if (c.coin === "USDT") usdtFree = free;
        if (free > 0) coins.push({ coin: c.coin, free });
      });
    });
    results.balances.usdt = usdtFree;
    results.balances.coins = coins;
    log.push("USDT free ~" + usdtFree.toFixed(4));

    // --- SELLS: market sell full free balance of base coin ---
    for (const s of sells.slice(0, 8)) {
      const symbol = String(s.symbol || "").toUpperCase();
      if (!symbol.endsWith("USDT")) continue;
      const base = symbol.replace("USDT", "");
      const held = coins.find((c) => c.coin === base);
      if (!held || held.free <= 0) {
        results.sells.push({ symbol, skip: "no balance" });
        continue;
      }
      // qty: base amount; trim a little for fees
      let qty = held.free * 0.995;
      const order = {
        category: "spot",
        symbol,
        side: "Sell",
        orderType: "Market",
        qty: String(qty),
        marketUnit: "baseCoin",
      };
      if (dryRun) {
        results.sells.push({ symbol, dryRun: true, qty });
        log.push("DRY SELL " + symbol + " qty " + qty);
        continue;
      }
      const r = await request(
        "POST",
        "/v5/order/create",
        "",
        order,
        apiKey,
        apiSecret,
        baseHost
      );
      results.sells.push({ symbol, retCode: r.retCode, retMsg: r.retMsg, result: r.result });
      log.push("SELL " + symbol + " → " + (r.retMsg || r.retCode));
    }

    // Refresh USDT after sells (best effort)
    if (!dryRun && sells.length) {
      try {
        const w2 = await request(
          "GET",
          "/v5/account/wallet-balance",
          "accountType=UNIFIED",
          null,
          apiKey,
          apiSecret,
          baseHost
        );
        const list2 = w2.result?.list || [];
        list2.forEach((acc) => {
          (acc.coin || []).forEach((c) => {
            if (c.coin === "USDT") usdtFree = parseFloat(c.walletBalance || 0);
          });
        });
      } catch (e) {}
    }

    // --- BUYS: split available USDT across buy symbols ---
    const buyList = buys
      .map((b) => String(b.symbol || "").toUpperCase())
      .filter((s) => s.endsWith("USDT"))
      .slice(0, 5);

    let budget = usdtFree * 0.995; // leave a tiny dust buffer only
    if (buyList.length && budget > 0) {
      const each = budget / buyList.length;
      for (const symbol of buyList) {
        if (!(each > 0)) {
          results.buys.push({ symbol, skip: "zero budget" });
          continue;
        }
        // qty precision: up to 8 dp for small accounts
        const qtyStr = each >= 1 ? each.toFixed(4) : each.toFixed(8);
        const order = {
          category: "spot",
          symbol,
          side: "Buy",
          orderType: "Market",
          qty: qtyStr,
          marketUnit: "quoteCoin", // spend USDT
        };
        if (dryRun) {
          results.buys.push({ symbol, dryRun: true, usdt: each });
          log.push("DRY BUY " + symbol + " ~$" + each);
          continue;
        }
        const r = await request(
          "POST",
          "/v5/order/create",
          "",
          order,
          apiKey,
          apiSecret,
          baseHost
        );
        results.buys.push({
          symbol,
          usdt: each,
          retCode: r.retCode,
          retMsg: r.retMsg,
          result: r.result,
        });
        log.push("BUY " + symbol + " $" + each + " → " + (r.retMsg || r.retCode));
      }
    } else if (buyList.length) {
      log.push("Skip buys — no USDT free (" + budget + ")");
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        dryRun,
        log,
        results,
        note: "Market orders · equal USDT split on buys · sells full free base. Not financial advice.",
      }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: String(e.message || e) }),
    };
  }
};
