import asyncio
import time
import json
import websockets
import requests
import asyncpg
import os
import ccxt.async_support as ccxt
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from fastapi.staticfiles import StaticFiles

# ─── Config ───────────────────────────────────────────────────────────────────
DATABASE_URL = os.environ.get("SUPABASE_DB_URL", "")
ACTIVE_SYMBOLS = {"BTCUSDT"}
db_pool = None

# ─── Database Setup ───────────────────────────────────────────────────────────
async def init_db():
    global db_pool
    if not DATABASE_URL:
        print("[DB] Warning: SUPABASE_DB_URL not set. Database will not work!")
        return
        
    try:
        # Supabase requires SSL, so we ensure the URL uses it
        db_pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=4)
        
        async with db_pool.acquire() as con:
            # 1. Real liquidations (WebSocket) - keep long term history
            await con.execute("""
                CREATE TABLE IF NOT EXISTS real_liquidations (
                    id        SERIAL PRIMARY KEY,
                    ts        DOUBLE PRECISION NOT NULL,
                    symbol    TEXT    NOT NULL,
                    side      TEXT    NOT NULL,
                    price     DOUBLE PRECISION NOT NULL,
                    qty       DOUBLE PRECISION NOT NULL,
                    usd_value DOUBLE PRECISION NOT NULL
                )
            """)
            await con.execute("CREATE INDEX IF NOT EXISTS idx_rl_sym_ts ON real_liquidations(symbol, ts)")
            
            # 2. Order Book Heatmap (Estimated Liquidations) - keep only 24 hours to save space
            await con.execute("""
                CREATE TABLE IF NOT EXISTS ob_heatmap (
                    id        SERIAL PRIMARY KEY,
                    ts        DOUBLE PRECISION NOT NULL,
                    symbol    TEXT    NOT NULL,
                    price     DOUBLE PRECISION NOT NULL,
                    usd_value DOUBLE PRECISION NOT NULL,
                    side      TEXT    NOT NULL
                )
            """)
            await con.execute("CREATE INDEX IF NOT EXISTS idx_ob_sym_ts ON ob_heatmap(symbol, ts)")
            print("[DB] Connected to Supabase and initialized tables.")
    except Exception as e:
        print(f"[DB ERROR] Failed to connect to database: {e}")
        db_pool = None

async def save_real_liquidation(symbol, side, price, qty):
    if not db_pool: return
    usd_value = price * qty
    async with db_pool.acquire() as db:
        await db.execute(
            "INSERT INTO real_liquidations(ts,symbol,side,price,qty,usd_value) VALUES($1,$2,$3,$4,$5,$6)",
            time.time(), symbol, side, price, qty, usd_value
        )

async def save_ob_heatmap_batch(symbol, ts, records):
    """records: list of (price, usd_value, side)"""
    if not db_pool: return
    async with db_pool.acquire() as db:
        data = [(ts, symbol, r[0], r[1], r[2]) for r in records]
        await db.executemany(
            "INSERT INTO ob_heatmap(ts,symbol,price,usd_value,side) VALUES($1,$2,$3,$4,$5)",
            data
        )

async def cleanup_old_ob_data():
    """Delete Order Book data older than 24 hours to save storage."""
    while True:
        try:
            if db_pool:
                cutoff = time.time() - (24 * 3600)
                async with db_pool.acquire() as db:
                    await db.execute("DELETE FROM ob_heatmap WHERE ts < $1", cutoff)
                print("[CLEANUP] Deleted ob_heatmap data older than 24h.")
        except Exception as e:
            print(f"[CLEANUP] Error: {e}")
        await asyncio.sleep(3600)  # Run every hour

# ─── Order Book Poller (Background Heatmap) ───────────────────────────────────
def get_bucket_size(price: float) -> float:
    if price > 10000: return 100.0
    if price > 1000:  return 10.0
    if price > 100:   return 1.0
    if price > 1:     return 0.1
    return round(price * 0.001, 8)

async def fetch_exchange_ob(exchange, symbol: str, limit: int = 1000):
    try:
        await exchange.load_markets()
        if symbol not in exchange.markets:
            alt_symbol = symbol.replace('USDT', 'USD')
            if alt_symbol in exchange.markets:
                symbol = alt_symbol
            else:
                return {'bids': [], 'asks': []}
        return await exchange.fetch_order_book(symbol, limit)
    except Exception as e:
        print(f"Error fetching from {exchange.id}: {e}")
        return {'bids': [], 'asks': []}
    finally:
        await exchange.close()

async def fetch_aggregated_depth_and_save(raw_symbol: str, current_price: float):
    if raw_symbol.endswith('USDT'):
        ccxt_symbol = f"{raw_symbol[:-4]}/USDT"
    else:
        ccxt_symbol = f"{raw_symbol[:-3]}/{raw_symbol[-3:]}"

    exchanges = [ccxt.binanceus(), ccxt.coinbase(), ccxt.kraken()]
    tasks = [fetch_exchange_ob(ex, ccxt_symbol) for ex in exchanges]
    results = await asyncio.gather(*tasks)

    merged_bids = {}
    merged_asks = {}
    for ob in results:
        for item in ob.get('bids', []):
            p, q = item[0], item[1]
            merged_bids[p] = merged_bids.get(p, 0) + q
        for item in ob.get('asks', []):
            p, q = item[0], item[1]
            merged_asks[p] = merged_asks.get(p, 0) + q

    leverages = [5, 10, 25, 50, 100]
    bucket_size = get_bucket_size(current_price)
    
    long_liq = {}
    short_liq = {}
    
    for p, q in merged_bids.items():
        for lev in leverages:
            liq_p = p * (1 - (1/lev))
            bucket = round(liq_p / bucket_size) * bucket_size
            long_liq[bucket] = long_liq.get(bucket, 0) + (q * p)
            
    for p, q in merged_asks.items():
        for lev in leverages:
            liq_p = p * (1 + (1/lev))
            bucket = round(liq_p / bucket_size) * bucket_size
            short_liq[bucket] = short_liq.get(bucket, 0) + (q * p)
            
    min_p = current_price * 0.75
    max_p = current_price * 1.25
    
    records = []
    for p, v in long_liq.items():
        if v > 0 and p >= min_p: records.append((p, v, "long"))
    for p, v in short_liq.items():
        if v > 0 and p <= max_p: records.append((p, v, "short"))
        
    if records:
        await save_ob_heatmap_batch(raw_symbol, time.time(), records)

async def poll_order_book_heatmap():
    """Poll every 10 seconds for active symbols."""
    while True:
        try:
            for symbol in list(ACTIVE_SYMBOLS):
                klines = fetch_klines_sync(symbol, "1h", limit=1)
                current_price = klines[-1]["close"] if klines else 0
                if current_price:
                    await fetch_aggregated_depth_and_save(symbol, current_price)
        except Exception as e:
            print(f"[OB_POLL] Error: {e}")
        await asyncio.sleep(10)

# ─── Real-Time WebSocket (Foreground Bubbles) ─────────────────────────────────
BINANCE_LIQ_WS = "wss://fstream.binance.com/ws/!forceOrder@arr"

async def listen_liquidations():
    while True:
        try:
            print("[LIQ] Connecting to Binance liquidation stream...")
            async with websockets.connect(
                BINANCE_LIQ_WS, ping_interval=20, ping_timeout=20, close_timeout=5
            ) as ws:
                print("[LIQ] Connected! Listening for REKT events...")
                async for raw in ws:
                    try:
                        msg = json.loads(raw)
                        order = msg.get("o", {})
                        symbol = order.get("s", "")
                        side = order.get("S", "")
                        price = float(order.get("ap", 0) or order.get("p", 0))
                        qty = float(order.get("q", 0))
                        
                        if not symbol or not price or not qty:
                            continue
                        
                        # In Binance futures: 
                        # Order side SELL -> long was liquidated
                        # Order side BUY -> short was liquidated
                        liq_side = "short" if side == "BUY" else "long"
                        await save_real_liquidation(symbol, liq_side, price, qty)
                        # Add to active symbols so order book poller starts tracking it
                        ACTIVE_SYMBOLS.add(symbol)
                    except Exception as e:
                        pass
        except Exception as e:
            print(f"[LIQ] Disconnected: {e}. Reconnecting in 5s...")
            await asyncio.sleep(5)

# ─── Lifespan ─────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    task1 = asyncio.create_task(listen_liquidations())
    task2 = asyncio.create_task(poll_order_book_heatmap())
    task3 = asyncio.create_task(cleanup_old_ob_data())
    yield
    task1.cancel()
    task2.cancel()
    task3.cancel()
    if db_pool:
        await db_pool.close()

# ─── App & API ────────────────────────────────────────────────────────────────
app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def fetch_klines_sync(symbol: str, interval: str, limit: int = 100):
    try:
        r = requests.get(
            "https://api.binance.us/api/v3/klines",
            params={"symbol": symbol, "interval": interval, "limit": limit},
            timeout=10
        )
        if r.status_code != 200:
            return []
        
        return [{
            "time":   int(row[0]) // 1000,
            "open":   float(row[1]),
            "high":   float(row[2]),
            "low":    float(row[3]),
            "close":  float(row[4]),
            "volume": float(row[5])
        } for row in r.json()]
    except Exception:
        return []

@app.get("/api/chart-data")
async def get_chart_data(symbol: str = "BTCUSDT", interval: str = "1h"):
    symbol = symbol.upper()
    ACTIVE_SYMBOLS.add(symbol)
    
    candles = fetch_klines_sync(symbol, interval)
    current_price = candles[-1]["close"] if candles else 0

    ob_rows = []
    rl_rows = []
    ob_slots = {}
    ob_since = time.time() - (24 * 3600)
    
    if db_pool:
        async with db_pool.acquire() as db:
            ob_rows = await db.fetch(
                "SELECT ts, price, usd_value, side FROM ob_heatmap WHERE symbol=$1 AND ts>=$2 ORDER BY ts ASC",
                symbol, ob_since
            )
            rl_rows = await db.fetch(
                "SELECT ts, price, qty, usd_value, side FROM real_liquidations WHERE symbol=$1 ORDER BY ts ASC",
                symbol
            )
    
    # Process OB Heatmap (bucketed by time and price)
    TIME_SLOT = 600 # 10 mins
    for r in ob_rows:
        slot_ts = int(r["ts"] / TIME_SLOT) * TIME_SLOT
        bucket = r["price"]
        if slot_ts not in ob_slots:
            ob_slots[slot_ts] = {}
        if bucket not in ob_slots[slot_ts]:
            ob_slots[slot_ts][bucket] = {"long": 0.0, "short": 0.0}
        ob_slots[slot_ts][bucket][r["side"]] += r["usd_value"]

    ob_history = []
    for slot_ts in sorted(ob_slots.keys()):
        data = []
        for bucket, sides in ob_slots[slot_ts].items():
            tot = sides["long"] + sides["short"]
            if tot > 0:
                dom = "long" if sides["long"] >= sides["short"] else "short"
                data.append({
                    "price": bucket,
                    "volume": tot,
                    "type": dom
                })
        if data:
            ob_history.append({"timestamp": slot_ts, "data": data})

    # Process Real Liquidations (Exact events)
    rl_history = []
    for r in rl_rows:
        rl_history.append({
            "timestamp": r["ts"],
            "price": r["price"],
            "qty": r["qty"],
            "usd_value": r["usd_value"],
            "side": r["side"]
        })

    return {
        "symbol": symbol,
        "current_price": current_price,
        "candles": candles,
        "ob_heatmap_history": ob_history,
        "real_liquidations": rl_history
    }

# ─── Serve Static Frontend ────────────────────────────────────────────────────
# Mount the current directory to serve index.html, js/, css/, etc.
current_dir = os.path.dirname(os.path.abspath(__file__))
app.mount("/", StaticFiles(directory=current_dir, html=True), name="static")
