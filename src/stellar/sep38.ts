/**
 * SEP-38 — Quote Server & Dynamic Price Streams
 *
 * Endpoints:
 *   GET  /sep38/info       – List supported asset pairs
 *   GET  /sep38/prices     – Indicative price for a pair
 *   GET  /sep38/price      – Alias for /prices (singular form)
 *   POST /sep38/quote      – Create a firm quote (stored in Redis with TTL)
 *   GET  /sep38/quote/:id  – Retrieve a stored quote by ID
 *
 * Quote persistence: Redis (key: `sep38:quote:<id>`, TTL = quote lifetime).
 * Falls back to NodeCache when Redis is unavailable, so the service degrades
 * gracefully in local dev without Redis.
 *
 * Zod validation schemas live in src/openapi/schemas/sep38.ts and are
 * imported here for runtime validation — keeping schema definitions DRY.
 */

import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import NodeCache from "node-cache";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { rateProvider } from "../services/sep38/rateProvider";
import { redisClient } from "../config/redis";
import {
  Sep38QuoteRequestSchema,
  Sep38PriceQuerySchema,
} from "../openapi/schemas/sep38";

const router = Router();

// ─── Rate limiter ─────────────────────────────────────────────────────────────

const sep38Limiter =
  process.env.NODE_ENV === "test"
    ? (req: any, res: any, next: any) => next()
    : rateLimit({
        windowMs: 60 * 1000, // 1 minute
        max: 30,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: "Too many requests, please try again later." },
      });

// ─── NodeCache fallback (used when Redis is unavailable) ──────────────────────

const localQuoteCache = new NodeCache({ stdTTL: 60, checkperiod: 10 });

// ─── Interfaces ───────────────────────────────────────────────────────────────

interface AssetPair {
  sell_asset: string;
  buy_asset: string;
}

interface Quote {
  id: string;
  expires_at: string;
  sell_asset: string;
  buy_asset: string;
  sell_amount: string;
  buy_amount: string;
  price: string;
  fee_percent: string;
  fee_fixed: string;
  created_at: string;
}

// ─── Supported asset pairs ────────────────────────────────────────────────────

const SUPPORTED_ASSET_PAIRS: AssetPair[] = [
  {
    sell_asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    buy_asset: "iso4217:USD",
  },
  {
    sell_asset: "iso4217:USD",
    buy_asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  },
  { sell_asset: "stellar:XLM", buy_asset: "iso4217:USD" },
  { sell_asset: "iso4217:USD", buy_asset: "stellar:XLM" },
  {
    sell_asset: "stellar:XLM",
    buy_asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  },
  {
    sell_asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    buy_asset: "stellar:XLM",
  },
  {
    sell_asset: "iso4217:XAF",
    buy_asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  },
  {
    sell_asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    buy_asset: "iso4217:XAF",
  },
  { sell_asset: "iso4217:XAF", buy_asset: "stellar:XLM" },
  { sell_asset: "stellar:XLM", buy_asset: "iso4217:XAF" },
];

// ─── Redis quote helpers ──────────────────────────────────────────────────────

const REDIS_KEY_PREFIX = "sep38:quote:";

async function storeQuote(quote: Quote, ttlSeconds: number): Promise<void> {
  const key = `${REDIS_KEY_PREFIX}${quote.id}`;
  const serialised = JSON.stringify(quote);
  try {
    if (redisClient.isOpen) {
      await redisClient.setEx(key, ttlSeconds, serialised);
      return;
    }
  } catch (err) {
    console.warn("SEP-38: Redis write failed, falling back to NodeCache", err);
  }
  // Fallback: NodeCache (single-instance only)
  localQuoteCache.set(quote.id, quote, ttlSeconds);
}

async function retrieveQuote(id: string): Promise<Quote | null> {
  const key = `${REDIS_KEY_PREFIX}${id}`;
  try {
    if (redisClient.isOpen) {
      const raw = await redisClient.get(key);
      return raw ? (JSON.parse(raw) as Quote) : null;
    }
  } catch (err) {
    console.warn("SEP-38: Redis read failed, falling back to NodeCache", err);
  }
  return localQuoteCache.get<Quote>(id) ?? null;
}

async function deleteQuote(id: string): Promise<void> {
  try {
    if (redisClient.isOpen) {
      await redisClient.del(`${REDIS_KEY_PREFIX}${id}`);
    }
  } catch {
    /* no-op */
  }
  localQuoteCache.del(id);
}

// ─── Route helpers ────────────────────────────────────────────────────────────

function isSupportedPair(sellAsset: string, buyAsset: string): boolean {
  return SUPPORTED_ASSET_PAIRS.some(
    (p) => p.sell_asset === sellAsset && p.buy_asset === buyAsset,
  );
}

// ─── GET /info ────────────────────────────────────────────────────────────────

/**
 * Returns the list of supported asset conversion pairs.
 * Wallets call this first to discover available routes.
 */
router.get("/info", sep38Limiter, (_req: Request, res: Response) => {
  try {
    res.json({ assets: SUPPORTED_ASSET_PAIRS });
  } catch (error) {
    console.error("SEP-38 /info error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /prices ──────────────────────────────────────────────────────────────

/**
 * Returns an indicative (non-binding) exchange rate.
 * Rates include a small market spread and may fluctuate.
 */
router.get("/prices", sep38Limiter, async (req: Request, res: Response) => {
  try {
    const parsed = Sep38PriceQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: parsed.error.issues,
      });
    }

    const { sell_asset, buy_asset } = parsed.data;

    if (!isSupportedPair(sell_asset, buy_asset)) {
      return res.status(400).json({ error: "Unsupported asset pair" });
    }

    const priceResult = await rateProvider.getIndicativePrice(sell_asset, buy_asset);
    if (!priceResult) {
      return res.status(500).json({ error: "Unable to fetch price for asset pair" });
    }

    res.json({
      sell_asset,
      buy_asset,
      price: priceResult.price,
      fee_percent: priceResult.fee_percent,
      fee_fixed: priceResult.fee_fixed,
    });
  } catch (error) {
    console.error("SEP-38 /prices error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /price ───────────────────────────────────────────────────────────────

/**
 * Singular-form alias for GET /prices.
 * Some SEP-38 clients use the singular path; this keeps them compatible.
 */
router.get("/price", sep38Limiter, async (req: Request, res: Response) => {
  try {
    const parsed = Sep38PriceQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: parsed.error.issues,
      });
    }

    const { sell_asset, buy_asset } = parsed.data;

    if (!isSupportedPair(sell_asset, buy_asset)) {
      return res.status(400).json({ error: "Unsupported asset pair" });
    }

    const priceResult = await rateProvider.getIndicativePrice(sell_asset, buy_asset);
    if (!priceResult) {
      return res.status(500).json({ error: "Unable to fetch price for asset pair" });
    }

    res.json({
      sell_asset,
      buy_asset,
      price: priceResult.price,
      fee_percent: priceResult.fee_percent,
      fee_fixed: priceResult.fee_fixed,
    });
  } catch (error) {
    console.error("SEP-38 /price error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /quote ──────────────────────────────────────────────────────────────

/**
 * Creates a firm, time-locked quote.
 *
 * The quote is stored in Redis (key: sep38:quote:<id>) with the TTL configured
 * by the caller (default 60 s, maximum 300 s). If Redis is unavailable the
 * quote falls back to NodeCache — it will still work but won't survive restarts.
 */
router.post("/quote", sep38Limiter, async (req: Request, res: Response) => {
  try {
    // ── 1. Validate request body via Zod schema ──────────────────────────────
    let body: z.infer<typeof Sep38QuoteRequestSchema>;
    try {
      body = Sep38QuoteRequestSchema.parse(req.body);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: "Validation failed", details: err.issues });
      }
      throw err;
    }

    const { sell_asset, buy_asset, sell_amount, buy_amount, ttl } = body;

    // ── 2. Validate asset pair ────────────────────────────────────────────────
    if (!isSupportedPair(sell_asset, buy_asset)) {
      return res.status(400).json({ error: "Unsupported asset pair" });
    }

    // ── 3. Fetch firm price from rate provider ────────────────────────────────
    const firmPriceResult = await rateProvider.getFirmPrice(sell_asset, buy_asset);
    if (!firmPriceResult) {
      return res.status(500).json({ error: "Unable to generate quote for asset pair" });
    }

    const priceNum = parseFloat(firmPriceResult.price);

    // ── 4. Compute amounts ────────────────────────────────────────────────────
    let sAmt: string;
    let bAmt: string;

    if (sell_amount) {
      sAmt = sell_amount;
      bAmt = (parseFloat(sell_amount) * priceNum).toFixed(7);
    } else {
      // buy_amount is guaranteed by Zod refine — one of the two must be set
      bAmt = buy_amount as string;
      sAmt = (parseFloat(bAmt) / priceNum).toFixed(7);
    }

    // ── 5. Build the quote object ─────────────────────────────────────────────
    const QUOTE_TTL_DEFAULT = 60;
    const QUOTE_TTL_MAX = 300;
    const quoteTTL = ttl
      ? Math.min(Math.max(ttl, 1), QUOTE_TTL_MAX)
      : QUOTE_TTL_DEFAULT;

    const quoteId = uuidv4();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + quoteTTL * 1000).toISOString();

    const quote: Quote = {
      id: quoteId,
      expires_at: expiresAt,
      sell_asset,
      buy_asset,
      sell_amount: sAmt,
      buy_amount: bAmt,
      price: firmPriceResult.price,
      fee_percent: firmPriceResult.fee_percent,
      fee_fixed: firmPriceResult.fee_fixed,
      created_at: createdAt,
    };

    // ── 6. Persist to Redis (with NodeCache fallback) ─────────────────────────
    await storeQuote(quote, quoteTTL);

    res.status(200).json(quote);
  } catch (error) {
    console.error("SEP-38 /quote POST error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /quote/:id ───────────────────────────────────────────────────────────

/**
 * Retrieves a stored quote by its UUID.
 *
 * Returns:
 *   200 – Active quote
 *   404 – Quote was never created (or already deleted)
 *   410 – Quote found but has expired (removed from cache)
 */
router.get("/quote/:id", sep38Limiter, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Basic UUID-format check to avoid unnecessary Redis lookups
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!id || !uuidRegex.test(id)) {
      return res.status(400).json({ error: "Invalid quote ID format" });
    }

    const quote = await retrieveQuote(id);

    if (!quote) {
      return res.status(404).json({ error: "Quote not found" });
    }

    // Double-check expiry (Redis TTL handles cleanup, but belt-and-suspenders)
    if (new Date() >= new Date(quote.expires_at)) {
      await deleteQuote(id);
      return res.status(410).json({ error: "Quote has expired" });
    }

    res.json(quote);
  } catch (error) {
    console.error("SEP-38 /quote/:id error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
