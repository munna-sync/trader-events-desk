// Hybrid taxonomy (trading + trade/SaaS/fintech + business) and auto-classifier.
// Shared by the portal and the seed builder. Group 0 holds the trading niches.
var TAXONOMY = [
  { id: "trading", name: "Financial Markets & Trading", cats: [
    { id: "forex", name: "Forex Trading", kw: ["forex", "fx", "currency", "currencies", "cfd", "cfds", "eurusd", "online trading", "intraday", "marktanalyse", "trading plan", "trading-plan", "price action", "technical analysis"] },
    { id: "crypto", name: "Crypto & Web3 Trading", kw: ["crypto", "bitcoin", "blockchain", "web3", "defi", "stablecoin", "stablecoins", "digital assets", "tokenization", "tokenized", "rwa", "altcoin", "crypto exchanges"] },
    { id: "gold", name: "Gold & Precious Metals", kw: ["gold", "silver", "precious metals", "bullion", "commodities", "xauusd"] },
    { id: "signals", name: "Signal-Based Trading", kw: ["signal", "signals", "copy trading", "social trading", "trade alerts", "trading creators", "mirror trading"] },
    { id: "prop", name: "Prop Firm Trading", kw: ["prop", "prop firm", "prop firms", "prop traders", "proprietary trading", "funded trader", "funded account", "funded accounts", "trading challenge"] },
    { id: "algo", name: "Algorithmic & Quant Trading", kw: ["algorithmic", "algo", "quant", "quantitative", "automated trading", "trading bots", "expert advisor", "ai trading", "ai and quant"] }
  ]},
  { id: "tradesaas", name: "Trade, SaaS & Fintech", cats: [
    { id: "trade-automation", name: "Trade Automation", kw: ["trade automation", "trading automation", "tradetech", "rpa", "robotic process", "workflow automation"] },
    { id: "trade-services", name: "Trade Services", kw: ["trade finance", "export finance", "trade services", "letters of credit", "supply chain finance", "commodity finance", "gtr", "sibos", "cash management", "treasury", "correspondent banking"] },
    { id: "global-trade", name: "Global Trade & Import/Export", kw: ["import", "export", "trade fair", "canton fair", "international trade", "cross-border", "customs", "tariff", "sourcing", "overseas buyers", "exporters", "trade show", "logistics", "supply chain", "shipping", "container", "freight", "intralogistics"] },
    { id: "saas", name: "SaaS Products", kw: ["saas", "software as a service", "b2b software", "arr", "subscription", "go-to-market", "saastr", "product-led"] },
    { id: "fintech", name: "FinTech", kw: ["fintech", "payments", "banking", "money20/20", "digital banking", "open banking", "neobank", "broker", "brokers", "liquidity", "trading platform", "metatrader", "payment providers", "financial services"] },
    { id: "embedded-finance", name: "Embedded Finance", kw: ["embedded finance", "banking-as-a-service", "baas", "embedded payments", "super-app", "open finance", "api economy"] },
    { id: "regtech", name: "RegTech & Compliance", kw: ["regtech", "regulatory", "regulation", "compliance", "aml", "kyc", "regulator", "regulators", "dora", "governance"] }
  ]},
  { id: "business", name: "Business, Economy & Leadership", cats: [
    { id: "macro", name: "World Economy & Macro Trends", kw: ["world economy", "global economy", "macro", "geopolitic", "economic forum", "davos", "central bank", "interest rates", "inflation", "market structure", "outlook", "public-private", "capital markets", "securities", "post-trade"] },
    { id: "business-growth", name: "Business Growth", kw: ["growth", "scaleup", "scale-up", "sme", "msmes", "expansion", "market entry", "export diversification"] },
    { id: "leadership", name: "Corporate Leadership", kw: ["leaders", "leadership", "c-suite", "ceo", "executives", "c-level", "coo", "cio", "decision-makers"] },
    { id: "vc-funding", name: "Venture Capital & Funding", kw: ["venture", "investors", "vc", "funding", "pitch", "angel", "startups", "startup", "founders"] },
    { id: "wealth", name: "Wealth Management", kw: ["wealth", "family office", "family offices", "private wealth", "asset management", "portfolio", "sovereign wealth", "income investing", "investing"] },
    { id: "digital-transformation", name: "Enterprise Digital Transformation", kw: ["digital transformation", "digitalisation", "digitalization", "industry 4.0", "smart cities", "digital economy", "cloud", "data centres", "data centers", "artificial intelligence", "ai", "agentic", "generative", "enterprise", "ecommerce", "e-commerce", "omnichannel", "retail technology"] }
  ]}
];

function _kwRegex(k) {
  var esc = k.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
  return new RegExp("(^|[^a-z0-9])" + esc + "([^a-z0-9]|$)", "i");
}

// Title hits weigh 2, description hits 1; keep the top 5.
// niche = the strongest category; a trading category wins ties.
function classifyEvent(title, description) {
  var t = (title || "").toLowerCase(), d = (description || "").toLowerCase(), scores = {};
  TAXONOMY.forEach(function (g) {
    g.cats.forEach(function (c) {
      var s = 0;
      c.kw.forEach(function (k) { var re = _kwRegex(k); if (re.test(t)) s += 2; if (re.test(d)) s += 1; });
      if (s > 0) scores[c.id] = s;
    });
  });
  var cats = Object.keys(scores).sort(function (a, b) { return scores[b] - scores[a]; }).slice(0, 5);
  var tradingIds = TAXONOMY[0].cats.map(function (c) { return c.id; });
  var top = cats.length ? scores[cats[0]] : 0;
  var niche = cats.filter(function (c) { return tradingIds.indexOf(c) >= 0 && scores[c] >= top; })[0] || cats[0] || "";
  return { categories: cats, niche: niche, groups: groupsFor(cats), scores: scores };
}

function groupsFor(catIds) {
  return TAXONOMY.filter(function (g) { return g.cats.some(function (c) { return catIds.indexOf(c.id) >= 0; }); }).map(function (g) { return g.id; });
}

export { TAXONOMY, classifyEvent, groupsFor };
