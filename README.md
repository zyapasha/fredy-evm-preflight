# fredy-evm-preflight

🌐 **English** · [Bahasa Indonesia](README.id.md)

> Audit an EVM NFT mint before broadcasting. Read-only, no signing, no broadcasts.

Sister tool to [fredy-mint-executor](https://github.com/zyapasha/fredy-mint-executor). Run this first to know whether the mint will succeed, surface every blocker, and avoid wasting gas on a doomed transaction.

## For beginners: what is this for?

Before paying gas to mint an NFT, you want to know:

- Is the contract real and verified, or a copycat?
- Is it paused / sold out / wrong network?
- Is my wallet eligible (enough gas, not already minted, not blocked by a wallet upgrade)?

This tool answers all of that in <5 seconds, **without spending any gas and without your private key.** Read-only — it just talks to public RPCs. Treat it as the "are we good to mint?" check.

**What you need:**
- Linux / macOS / WSL (Windows Subsystem for Linux)
- Node.js 20+ — verify with `node --version`
- The contract address you want to audit
- (Optional) the wallet address you'll mint from — for the wallet-side checks

## What it checks

1. **Chain auto-detect** — finds the contract on Ethereum, Base, Arbitrum, Optimism, or Polygon via `eth_getCode`.
2. **Contract reads** — name, symbol, mintPrice, totalSupply, maxSupply, paused, owner.
3. **Sourcify verification status** — `perfect`, `partial`, or unverified. Links to source viewer.
4. **EIP-7702 wallet safety** (optional) — detects EOAs delegated via type-4 transactions that will revert `_safeMint` calls with `ERC721InvalidReceiver`.
5. **Wallet balance + already-minted check** (optional) — confirms the wallet has gas and hasn't already minted.
6. **Fee data + cost estimate** — current baseFee + suggested maxFee + estimated total cost at typical mint gas.
7. **Common revert selector reference** — fast lookup of error meanings for diagnosing post-failure traces.

## Why

NFT mints fail for predictable reasons:

- Contract is paused → tx reverts, you pay gas anyway.
- Sold out, but you didn't check totalSupply.
- Wallet has been "upgraded" via EIP-7702 → `_safeMint` calls back into the delegate, the delegate doesn't implement `onERC721Received`, revert.
- Contract is unverified → you have no idea what `mint()` actually does.
- mintPrice on-chain doesn't match what the website says → `WrongPrice()` revert.

This script catches all of those in <5 seconds, read-only, no keys needed.

## Install

```bash
git clone https://github.com/zyapasha/fredy-evm-preflight.git
cd fredy-evm-preflight
npm install
```

Requires Node.js 20+.

## Usage

```bash
# Audit a contract (chain auto-detect)
node preflight.js 0xCONTRACT

# Audit contract + check a specific wallet
node preflight.js 0xCONTRACT 0xWALLET

# Force a chain (skip detection, faster)
node preflight.js 0xCONTRACT --chain=base

# Quiet mode (suppress probe logs)
node preflight.js 0xCONTRACT --quiet
```

**Beginner tip:** if the verdict is `sold out` or `paused`, stop — minting will revert and you pay gas anyway. If the wallet check shows EIP-7702 delegate code, revoke it (snippet below) before pointing `fredy-mint-executor` at the contract.

## Sample output

```
[chain] ✓ ethereum (chainId 1, code 44924 chars)

======================================================================
CONTRACT  0xC057170B4B46563Df0970A823F4D94186B741858  (ethereum)
======================================================================
  Syntax (SYNTAX)
  mintPrice: 0 wei  (0.0000000 ETH) [FREE]
  supply: 10000/10000  (100.0% minted)
  paused: false ✓
  owner: 0x8a8a72576A557AD330De048641E8Bf905f064eb4

  sourcify: perfect
    → source: https://sourcify.dev/#/lookup/0xC057...
  explorer: https://etherscan.io/address/0xC057...

======================================================================
FEE DATA
======================================================================
  block 25106297  baseFee 0.198 gwei
  estimated mint cost (130k gas): 0.0000322 ETH

======================================================================
VERDICT
======================================================================
  ⚠ sold out
```

## EIP-7702 detection

Pectra (May 2025) introduced type-4 transactions that let EOAs install code via authorization lists. The code lives at the EOA with prefix `0xef0100<delegate>`. If you minted to a wallet that's connected to Coinbase Smart Wallet, MetaMask Smart Account, Ambire, or any other AA UI that auto-installs a delegate, every `_safeMint` will revert with `ERC721InvalidReceiver(receiver)`.

This tool detects the `0xef0100` prefix and decodes the delegate address. To revoke before minting, send a type-4 self-tx with `authorizationList=[{delegate: 0x0, nonce: tx_nonce+1}]`. Costs ~36-50k gas.

```javascript
// ethers v6 ≥ 6.16
const auth = await wallet.authorize({
  address: "0x0000000000000000000000000000000000000000",
  nonce: nonce + 1,
  chainId: Number(chainId),
});
const tx = {
  type: 4, chainId: Number(chainId), nonce,
  to: wallet.address, value: 0n, data: "0x",
  gasLimit: 100000n,
  maxFeePerGas: feeData.maxFeePerGas,
  maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
  authorizationList: [auth],
};
await wallet.sendTransaction(tx);
```

After the revoke tx confirms, `eth_getCode` returns `0x` and `_safeMint` works again.

## Revert selector quick reference

| Selector | Error |
| --- | --- |
| `0x64a0ae92` | `ERC721InvalidReceiver(address)` — EIP-7702 delegate / bad receiver |
| `0xf7760f25` | `WrongPrice()` — `msg.value` ≠ `MINT_PRICE` |
| `0x8c4841e4` | `MintCodeAlreadyUsed()` |
| `0x8baa579f` | `InvalidSignature()` |
| `0xa9fbf51f` | `PublicMintLimitReached()` |

To decode any unknown selector:

```python
from eth_utils import keccak
print('0x' + keccak(text='SomeError(uint256)')[:4].hex())
```

## Limitations

- Doesn't simulate the actual `mint()` call (would need to know args + value). Use `mint --dry` from `fredy-mint-executor` for full simulation.
- Sourcify "perfect" doesn't mean the contract is benevolent — only that the bytecode matches a published source. Always read the `mint()` function in the linked source viewer for footguns: hard-coded vs owner-settable mintPrice, reentrancy guards, supply caps, `selfdestruct`, `delegatecall`, owner role that can drain user funds.
- Function probe relies on standard names (`mintPrice`, `MINT_PRICE`, `paused`, etc.). Custom function names won't be picked up.

## License

MIT — see [LICENSE](LICENSE).

## Disclaimer

Read-only audit tool. Doesn't broadcast transactions or sign anything. But Sourcify verification status is not a guarantee of contract safety — always read the source code yourself before paying gas.
