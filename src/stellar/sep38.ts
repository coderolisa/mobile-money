import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import NodeCache from "node-cache";
import rateLimit from "express-rate-limit";
import { currencyService, SupportedCurrency } from "../services/currency";

const router = Router();

// Strict rate limiter for SEP-38 endpoints (similar to SEP-31)
const sep38Limiter = process.env.NODE_ENV === "test" 
  ? (req: any, res: any, next: any) => next()
  : rateLimit({
      windowMs: 60 * 1000, // 1 minute
      max: 30, // Limit each IP to 30 requests per window
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        error: "Too many requests, please try again later.",
      },
    });

// Cache for quotes with TTL support (60 seconds default as per spec)
const quoteCache = new NodeCache({ stdTTL: 60, checkperiod: 10 });

// Supported asset pairs configuration
interface AssetPair {
  sell_asset: string;
  buy_asset: string;
}

interface Price {
  sell_asset: string;
  buy_asset: string;
  price: string;
}

interface Quote {
  id: string;
  expires_at: string;
  sell_asset: string;
  buy_asset: string;
  sell_amount: string;
  buy_amount: string;
  price: string;
  created_at: string;
}

interface InfoResponse {
  assets: AssetPair[];
}

interface PricesResponse extends Price {
  [key: string]: any;
}

interface ErrorResponse {
  error: string;
}

// Supported asset pairs - can be configured via environment variables
// Includes main assets: XAF, USDC (on Stellar), USD (ISO4217), XLM
const SUPPORTED_ASSET_PAIRS: AssetPair[] = [
  { sell_asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", buy_asset: "iso4217:USD" },
  { sell_asset: "iso4217:USD", buy_asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
  { sell_asset: "stellar:XLM", buy_asset: "iso4217:USD" },
  { sell_asset: "iso4217:USD", buy_asset: "stellar:XLM" },
  { sell_asset: "stellar:XLM", buy_asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
  { sell_asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", buy_asset: "stellar:XLM" },
  { sell_asset: "iso4217:XAF", buy_asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
  { sell_asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", buy_asset: "iso4217:XAF" },
  { sell_asset: "iso4217:XAF", buy_asset: "stellar:XLM" },
  { sell_asset: "stellar:XLM", buy_asset: "iso4217:XAF" },
];

/**
 * SEP-38 Exchange Rate Service
 * Handles conversion between different asset types and provides price information
 */
class ExchangeRateService {
  private mapToCurrencyCode(asset: string): string | null {
    if (asset === "stellar:XLM") return "XLM";
    if (asset.startsWith("iso4217:")) return asset.split(":")[1];
    if (asset.startsWith("stellar:USDC:")) return "USD";
    return null;
  }

  /**
   * Get the current exchange rate between two assets
   */
  async getPrice(sellAsset: string, buyAsset: string): Promise<string | null> {
    const sellCode = this.mapToCurrencyCode(sellAsset);
    const buyCode = this.mapToCurrencyCode(buyAsset);

    if (!sellCode || !buyCode) return null;

    let rate: number = 1.0;

    try {
      // Integrate with CurrencyService for live rates
      if (sellCode === "XLM" || buyCode === "XLM") {
        const xlmPriceUsd = 0.12; // Dynamic placeholder for XLM price
        if (sellCode === "XLM" && buyCode === "USD") rate = xlmPriceUsd;
        else if (sellCode === "USD" && buyCode === "XLM") rate = 1 / xlmPriceUsd;
        else if (sellCode === "XLM") {
          const conversion = currencyService.convert(1, "USD", buyCode as SupportedCurrency);
          rate = xlmPriceUsd * conversion.rate;
        } else if (buyCode === "XLM") {
          const conversion = currencyService.convertToBase(1, sellCode as SupportedCurrency);
          rate = conversion.rate / xlmPriceUsd;
        }
      } else {
        rate = currencyService.convert(1, sellCode as SupportedCurrency, buyCode as SupportedCurrency).rate;
      }
    } catch (e) {
      console.error("Error converting currency:", e);
      return null;
    }

    // Add small variation to simulate dynamic market rates (±0.1%)
    const variation = 1 + (Math.random() - 0.5) * 0.001;
    const adjustedRate = rate * variation;
    
    return adjustedRate.toFixed(7);
  }

  /**
   * Generate a quote for a conversion between two assets
   */
  async getQuote(
    sellAsset: string,
    buyAsset: string,
    sellAmount?: string,
    buyAmount?: string
  ): Promise<{ sellAmount: string; buyAmount: string; price: string } | null> {
    const price = await this.getPrice(sellAsset, buyAsset);
    
    if (!price) {
      return null;
    }

    const priceNum = parseFloat(price);
    let sAmt: string = "";
    let bAmt: string = "";

    if (sellAmount) {
      sAmt = sellAmount;
      bAmt = (parseFloat(sellAmount) * priceNum).toFixed(7);
    } else if (buyAmount) {
      bAmt = buyAmount;
      sAmt = (parseFloat(buyAmount) / priceNum).toFixed(7);
    }

    return { sellAmount: sAmt, buyAmount: bAmt, price };
  }
}

const exchangeRateService = new ExchangeRateService();

/**
 * GET /info
 * 
 * Returns supported asset pairs for conversion
 * Used by wallets to discover available conversion paths
 */
router.get("/info", sep38Limiter, (req: Request, res: Response) => {
  try {
    const info: InfoResponse = {
      assets: SUPPORTED_ASSET_PAIRS.map(pair => ({
        sell_asset: pair.sell_asset,
        buy_asset: pair.buy_asset
      }))
    };
    res.json(info);
  } catch (error) {
    console.error("Error in /info endpoint:", error);
    res.status(500).json({ error: "Internal server error" } as ErrorResponse);
  }
});

/**
 * GET /prices
 * 
 * Get current prices for multiple asset pairs
 * Query Parameters:
 *   - sell_asset: Asset code to convert from
 *   - buy_asset: Asset code to convert to
 */
router.get("/prices", sep38Limiter, async (req: Request, res: Response) => {
  try {
    const { sell_asset, buy_asset } = req.query;
    
    // Validate required parameters
    if (!sell_asset || !buy_asset) {
      return res.status(400).json({ 
        error: "Missing required parameters: sell_asset and buy_asset" 
      } as ErrorResponse);
    }

    // Validate asset pair is supported
    const assetPair = SUPPORTED_ASSET_PAIRS.find(
      pair => pair.sell_asset === sell_asset && pair.buy_asset === buy_asset
    );

    if (!assetPair) {
      return res.status(400).json({ 
        error: "Unsupported asset pair" 
      } as ErrorResponse);
    }

    const price = await exchangeRateService.getPrice(sell_asset as string, buy_asset as string);
    
    if (!price) {
      return res.status(500).json({ 
        error: "Unable to fetch price for asset pair" 
      } as ErrorResponse);
    }

    const priceResponse: PricesResponse = {
      sell_asset: sell_asset as string,
      buy_asset: buy_asset as string,
      price
    };

    res.json(priceResponse);
  } catch (error) {
    console.error("Error in /prices endpoint:", error);
    res.status(500).json({ error: "Internal server error" } as ErrorResponse);
  }
});

/**
 * GET /price
 * 
 * Get the current price for a specific asset pair (singular endpoint)
 * Query Parameters:
 *   - sell_asset: Asset code to convert from
 *   - buy_asset: Asset code to convert to
 */
router.get("/price", sep38Limiter, async (req: Request, res: Response) => {
  try {
    const { sell_asset, buy_asset } = req.query;
    
    // Validate required parameters
    if (!sell_asset || !buy_asset) {
      return res.status(400).json({ 
        error: "Missing required parameters: sell_asset and buy_asset" 
      } as ErrorResponse);
    }

    // Validate asset pair is supported
    const assetPair = SUPPORTED_ASSET_PAIRS.find(
      pair => pair.sell_asset === sell_asset && pair.buy_asset === buy_asset
    );

    if (!assetPair) {
      return res.status(400).json({ 
        error: "Unsupported asset pair" 
      } as ErrorResponse);
    }

    const price = await exchangeRateService.getPrice(sell_asset as string, buy_asset as string);
    
    if (!price) {
      return res.status(500).json({ 
        error: "Unable to fetch price for asset pair" 
      } as ErrorResponse);
    }

    const priceResponse: Price = {
      sell_asset: sell_asset as string,
      buy_asset: buy_asset as string,
      price
    };

    res.json(priceResponse);
  } catch (error) {
    console.error("Error in /price endpoint:", error);
    res.status(500).json({ error: "Internal server error" } as ErrorResponse);
  }
});

/**
 * POST /quote
 * 
 * Create a firm quote for a specific conversion
 * The quote is locked in for the specified TTL (default 60 seconds)
 * 
 * Body Parameters:
 *   - sell_asset: Asset code to convert from
 *   - buy_asset: Asset code to convert to
 *   - sell_amount: Amount to sell (optional if buy_amount is provided)
 *   - buy_amount: Amount to buy (optional if sell_amount is provided)
 *   - ttl: Time to live in seconds (optional, max 300, default 60)
 */
router.post("/quote", sep38Limiter, async (req: Request, res: Response) => {
  try {
    const { sell_asset, buy_asset, sell_amount, buy_amount, ttl } = req.body;

    // Validate required parameters
    if (!sell_asset || !buy_asset || (!sell_amount && !buy_amount)) {
      return res.status(400).json({ 
        error: "Missing required parameters: sell_asset, buy_asset, and either sell_amount or buy_amount" 
      } as ErrorResponse);
    }

    // Validate asset pair is supported
    const assetPair = SUPPORTED_ASSET_PAIRS.find(
      pair => pair.sell_asset === sell_asset && pair.buy_asset === buy_asset
    );

    if (!assetPair) {
      return res.status(400).json({ 
        error: "Unsupported asset pair" 
      } as ErrorResponse);
    }

    // Validate amounts are positive numbers
    if (sell_amount) {
      const sellAmountNum = parseFloat(sell_amount);
      if (isNaN(sellAmountNum) || sellAmountNum <= 0) {
        return res.status(400).json({ 
          error: "sell_amount must be a positive number" 
        } as ErrorResponse);
      }
    }

    if (buy_amount) {
      const buyAmountNum = parseFloat(buy_amount);
      if (isNaN(buyAmountNum) || buyAmountNum <= 0) {
        return res.status(400).json({ 
          error: "buy_amount must be a positive number" 
        } as ErrorResponse);
      }
    }

    // Get quote from exchange rate service
    const quoteData = await exchangeRateService.getQuote(
      sell_asset,
      buy_asset,
      sell_amount,
      buy_amount
    );

    if (!quoteData) {
      return res.status(500).json({ 
        error: "Unable to generate quote for asset pair" 
      } as ErrorResponse);
    }

    // Calculate TTL (Time To Live) in seconds
    const defaultTTL = 60; // 1 minute default as per spec
    const quoteTTL = ttl && ttl > 0 ? Math.min(ttl, 300) : defaultTTL; // Max 5 minutes

    // Generate quote ID and expiration time
    const quoteId = uuidv4();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + quoteTTL * 1000).toISOString();

    // Create quote object
    const quote: Quote = {
      id: quoteId,
      expires_at: expiresAt,
      sell_asset,
      buy_asset,
      sell_amount: quoteData.sellAmount,
      buy_amount: quoteData.buyAmount,
      price: quoteData.price,
      created_at: createdAt
    };

    // Cache the quote with TTL
    quoteCache.set(quoteId, quote, quoteTTL);

    res.status(201).json(quote);
  } catch (error) {
    console.error("Error in /quote endpoint:", error);
    res.status(500).json({ error: "Internal server error" } as ErrorResponse);
  }
});

/**
 * GET /quote/:id
 * 
 * Retrieve a previously created quote by its ID
 * Returns 404 if quote not found, 410 if quote has expired
 * 
 * Path Parameters:
 *   - id: The quote ID returned from POST /quote
 */
router.get("/quote/:id", sep38Limiter, (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    // Validate quote ID format
    if (!id || typeof id !== "string" || id.trim().length === 0) {
      return res.status(400).json({ 
        error: "Invalid quote ID" 
      } as ErrorResponse);
    }

    const quote = quoteCache.get<Quote>(id);
    
    if (!quote) {
      return res.status(404).json({ error: "Quote not found" } as ErrorResponse);
    }

    // Check if quote has expired
    const now = new Date();
    const expiresAt = new Date(quote.expires_at);
    
    if (now >= expiresAt) {
      // Remove expired quote from cache
      quoteCache.del(id);
      return res.status(410).json({ error: "Quote has expired" } as ErrorResponse);
    }

    res.json(quote);
  } catch (error) {
    console.error("Error in /quote/:id endpoint:", error);
    res.status(500).json({ error: "Internal server error" } as ErrorResponse);
  }
});

export default router;
