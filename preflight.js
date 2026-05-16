#!/usr/bin/env node
// fredy-evm-preflight — audit an EVM NFT mint before broadcasting
//
// Usage:
//   node preflight.js <contract> [wallet] [--chain=auto] [--quiet]
//
// What it checks:
//   1. Chain auto-detect (Ethereum, Base, Arbitrum, Optimism, Polygon)
//   2. Contract: code length, basic ERC721 interface, mintPrice / paused / supply
//   3. Sourcify verification status
//   4. Common revert selectors decoded
//   5. Wallet (optional): EIP-7702 delegation check, balance, hasMintedPublic
//   6. Fee data + estimated mint cost
//
// Read-only. Never broadcasts a tx. No private keys needed.

const {JsonRpcProvider, getAddress, Contract} = require("ethers");
const https = require("https");

const CHAINS = {
  ethereum: { id: 1,    rpc: "https://ethereum-rpc.publicnode.com", explorer: "https://etherscan.io",       sourcify: 1 },
  base:     { id: 8453, rpc: "https://mainnet.base.org",            explorer: "https://basescan.org",        sourcify: 8453 },
  arbitrum: { id: 42161, rpc: "https://arb1.arbitrum.io/rpc",       explorer: "https://arbiscan.io",         sourcify: 42161 },
  optimism: { id: 10,   rpc: "https://mainnet.optimism.io",         explorer: "https://optimistic.etherscan.io", sourcify: 10 },
  polygon:  { id: 137,  rpc: "https://polygon-bor-rpc.publicnode.com", explorer: "https://polygonscan.com",  sourcify: 137 },
};

// Known revert selectors and their meanings
const REVERT_SELECTORS = {
  "0x64a0ae92": "ERC721InvalidReceiver — receiver doesn't implement onERC721Received correctly (often EIP-7702 delegated EOA)",
  "0xf7760f25": "WrongPrice — msg.value doesn't match the contract's MINT_PRICE",
  "0x8c4841e4": "MintCodeAlreadyUsed — backend single-use code has been consumed",
  "0x8baa579f": "InvalidSignature — backend-signed mint code signature failed verification",
  "0xfb8f41b2": "ERC20InsufficientAllowance — allowance below transfer amount",
  "0xe450d38c": "ERC20InsufficientBalance — balance below transfer amount",
  "0xa9fbf51f": "PublicMintLimitReached — wallet already minted its quota",
  "0x4ca88867": "InsufficientFunds — generic 'not enough ETH' error",
};

const ARGS = process.argv.slice(2);
const opts = { contract: null, wallet: null, chain: "auto", quiet: false };
for (const a of ARGS) {
  if (a === "--quiet") opts.quiet = true;
  else if (a.startsWith("--chain=")) opts.chain = a.slice(8);
  else if (a.startsWith("0x") && a.length === 42 && !opts.contract) opts.contract = getAddress(a);
  else if (a.startsWith("0x") && a.length === 42) opts.wallet = getAddress(a);
}
if (!opts.contract) {
  console.error("Usage: node preflight.js <contract> [wallet] [--chain=auto|ethereum|base|arbitrum|optimism|polygon] [--quiet]");
  process.exit(1);
}

function log(...a) { if (!opts.quiet) console.log(...a); }
function fmtETH(wei) { return `${(Number(wei) / 1e18).toFixed(7)} ETH`; }

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "fredy-evm-preflight/0.1" }, timeout: 10000 }, (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject).on("timeout", function() { this.destroy(new Error("timeout")); });
  });
}

async function detectChain(addr) {
  log(`[chain] probing ${addr}`);
  for (const [name, cfg] of Object.entries(CHAINS)) {
    try {
      const p = new JsonRpcProvider(cfg.rpc);
      const code = await Promise.race([
        p.getCode(addr),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000))
      ]);
      if (code && code !== "0x") {
        log(`[chain] ✓ ${name} (chainId ${cfg.id}, code ${code.length} chars)`);
        return name;
      }
    } catch (e) {
      log(`[chain]   ${name}: ${e.message}`);
    }
  }
  return null;
}

async function checkSourcify(chainId, addr) {
  try {
    const r = await fetch(`https://sourcify.dev/server/check-by-addresses?addresses=${addr}&chainIds=${chainId}`);
    if (r.status !== 200) return { status: "unknown", reason: `HTTP ${r.status}` };
    const data = JSON.parse(r.body);
    if (Array.isArray(data) && data[0]) {
      const s = data[0].status || "false";
      return { status: s, raw: data[0] };
    }
    return { status: "unknown" };
  } catch (e) {
    return { status: "unknown", reason: e.message };
  }
}

async function readContract(provider, addr) {
  const ABI = [
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function totalSupply() view returns (uint256)",
    "function maxSupply() view returns (uint256)",
    "function MAX_SUPPLY() view returns (uint256)",
    "function mintPrice() view returns (uint256)",
    "function MINT_PRICE() view returns (uint256)",
    "function publicMintPrice() view returns (uint256)",
    "function paused() view returns (bool)",
    "function owner() view returns (address)",
  ];
  const c = new Contract(addr, ABI, provider);
  const reads = {};
  await Promise.all([
    c.name().then(v => reads.name = v).catch(() => {}),
    c.symbol().then(v => reads.symbol = v).catch(() => {}),
    c.totalSupply().then(v => reads.totalSupply = v).catch(() => {}),
    c.maxSupply().then(v => reads.maxSupply = v).catch(() => {}),
    c.MAX_SUPPLY().then(v => { if (!reads.maxSupply) reads.maxSupply = v; }).catch(() => {}),
    c.mintPrice().then(v => reads.mintPrice = v).catch(() => {}),
    c.MINT_PRICE().then(v => { if (reads.mintPrice === undefined) reads.mintPrice = v; }).catch(() => {}),
    c.publicMintPrice().then(v => { if (reads.mintPrice === undefined) reads.mintPrice = v; }).catch(() => {}),
    c.paused().then(v => reads.paused = v).catch(() => {}),
    c.owner().then(v => reads.owner = v).catch(() => {}),
  ]);
  return reads;
}

async function checkWalletSafety(provider, wallet) {
  const code = await provider.getCode(wallet);
  if (code === "0x") return { type: "EOA", safe: true };
  if (code.startsWith("0xef0100")) {
    const delegate = "0x" + code.slice(8);
    return {
      type: "EIP-7702 delegated EOA",
      delegate,
      safe: false,
      warning: "_safeMint will likely revert with ERC721InvalidReceiver. Run a type-4 self-tx with delegate=0x0 to revoke before minting.",
    };
  }
  return {
    type: "Smart contract",
    code_prefix: code.slice(0, 12),
    safe: "unknown",
    warning: "Treat as a contract receiver. Verify it implements onERC721Received(0x150b7a02) and returns the magic value.",
  };
}

async function checkHasMinted(provider, contract, wallet) {
  // Try common selector names
  for (const fn of ["hasMintedPublic", "hasMinted", "minted", "_minted"]) {
    try {
      const c = new Contract(contract, [`function ${fn}(address) view returns (bool)`], provider);
      const r = await c[fn](wallet);
      return { fn, result: r };
    } catch {}
  }
  return null;
}

(async () => {
  const chainName = opts.chain === "auto" ? await detectChain(opts.contract) : opts.chain;
  if (!chainName) {
    console.error("[fatal] contract has no code on any supported chain");
    process.exit(1);
  }
  const cfg = CHAINS[chainName];
  if (!cfg) {
    console.error(`[fatal] unknown chain: ${chainName}`);
    process.exit(1);
  }
  const provider = new JsonRpcProvider(cfg.rpc);
  log("");

  // Run independent checks in parallel
  const [reads, sourcify, block, feeData] = await Promise.all([
    readContract(provider, opts.contract),
    checkSourcify(cfg.sourcify, opts.contract),
    provider.getBlock("latest"),
    provider.getFeeData(),
  ]);

  console.log("=".repeat(70));
  console.log(`CONTRACT  ${opts.contract}  (${chainName})`);
  console.log("=".repeat(70));

  if (reads.name || reads.symbol)
    console.log(`  ${reads.name || "?"} (${reads.symbol || "?"})`);
  if (reads.mintPrice !== undefined)
    console.log(`  mintPrice: ${reads.mintPrice} wei  (${fmtETH(reads.mintPrice)}) ${reads.mintPrice === 0n ? "[FREE]" : ""}`);
  else
    console.log(`  mintPrice: not exposed via standard view (could be in a custom function)`);
  if (reads.totalSupply !== undefined && reads.maxSupply !== undefined) {
    const pct = (Number(reads.totalSupply) / Number(reads.maxSupply) * 100).toFixed(1);
    console.log(`  supply: ${reads.totalSupply}/${reads.maxSupply}  (${pct}% minted)`);
  } else if (reads.totalSupply !== undefined) {
    console.log(`  totalSupply: ${reads.totalSupply}`);
  }
  if (reads.paused !== undefined)
    console.log(`  paused: ${reads.paused} ${reads.paused ? "⚠" : "✓"}`);
  if (reads.owner)
    console.log(`  owner: ${reads.owner}`);

  console.log(`\n  sourcify: ${sourcify.status}${sourcify.reason ? "  ("+sourcify.reason+")" : ""}`);
  if (sourcify.status === "perfect" || sourcify.status === "partial") {
    console.log(`    → source: https://sourcify.dev/#/lookup/${opts.contract}`);
  }
  console.log(`  explorer: ${cfg.explorer}/address/${opts.contract}`);

  // Wallet checks
  if (opts.wallet) {
    console.log("\n" + "=".repeat(70));
    console.log(`WALLET    ${opts.wallet}`);
    console.log("=".repeat(70));
    const safety = await checkWalletSafety(provider, opts.wallet);
    console.log(`  type: ${safety.type}  safe: ${safety.safe}`);
    if (safety.delegate) console.log(`  delegate: ${safety.delegate}`);
    if (safety.warning) console.log(`  ⚠ ${safety.warning}`);
    const bal = await provider.getBalance(opts.wallet);
    console.log(`  balance: ${fmtETH(bal)}`);
    const minted = await checkHasMinted(provider, opts.contract, opts.wallet);
    if (minted) console.log(`  ${minted.fn}(self): ${minted.result} ${minted.result ? "⚠ already minted" : "✓"}`);
  }

  // Fee data + estimated cost
  console.log("\n" + "=".repeat(70));
  console.log("FEE DATA");
  console.log("=".repeat(70));
  console.log(`  block ${block.number}  baseFee ${(Number(block.baseFeePerGas)/1e9).toFixed(3)} gwei`);
  console.log(`  maxFeePerGas (suggested): ${(Number(feeData.maxFeePerGas || 0n)/1e9).toFixed(3)} gwei`);
  console.log(`  maxPriorityFeePerGas (suggested): ${(Number(feeData.maxPriorityFeePerGas || 0n)/1e9).toFixed(3)} gwei`);
  // Estimate at typical mint gas
  const TYPICAL_MINT_GAS = 130000n;
  const estCost = (block.baseFeePerGas + 50_000_000n) * TYPICAL_MINT_GAS;
  console.log(`  estimated mint cost (130k gas): ${fmtETH(estCost)}`);

  // Quick revert selector reference
  console.log("\n" + "=".repeat(70));
  console.log("COMMON REVERT SELECTORS (for diagnosing failures)");
  console.log("=".repeat(70));
  for (const [sel, desc] of Object.entries(REVERT_SELECTORS)) {
    console.log(`  ${sel}  ${desc}`);
  }

  // Final verdict
  console.log("\n" + "=".repeat(70));
  console.log("VERDICT");
  console.log("=".repeat(70));
  const flags = [];
  if (reads.paused === true) flags.push("⚠ paused: cannot mint right now");
  if (reads.totalSupply !== undefined && reads.maxSupply !== undefined && reads.totalSupply >= reads.maxSupply) flags.push("⚠ sold out");
  if (sourcify.status !== "perfect" && sourcify.status !== "partial") flags.push("⚠ contract not verified on Sourcify — extra caution warranted");
  if (opts.wallet) {
    const safety = await checkWalletSafety(provider, opts.wallet);
    if (!safety.safe || safety.safe === "unknown") flags.push(`⚠ wallet not safe for _safeMint: ${safety.type}`);
  }
  if (flags.length === 0) {
    console.log("  ✓ no blocking flags. mint should succeed.");
  } else {
    for (const f of flags) console.log(`  ${f}`);
  }
})().catch((e) => {
  console.error("[fatal]", e.message);
  process.exit(1);
});
