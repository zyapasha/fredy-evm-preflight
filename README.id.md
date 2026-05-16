# fredy-evm-preflight

🌐 [English](README.md) · **Bahasa Indonesia**

> Audit mint NFT EVM sebelum broadcast. Read-only, gak sign, gak broadcast.

Sister tool dari [fredy-mint-executor](https://github.com/zyapasha/fredy-mint-executor). Run ini dulu sebelum mint — biar tau apakah mint bakal berhasil, surface semua blocker, dan ga buang gas buat tx yang ujung-ujungnya revert.

## Untuk pemula: ini buat apa sih?

Sebelum bayar gas buat mint NFT, lo pasti pengen tau:

- Contract-nya beneran ga, atau scam copycat?
- Lagi di-pause / sold out / salah jaringan?
- Wallet gw eligible ga (gas cukup, belum pernah mint, gak ke-block sama upgrade wallet)?

Tool ini jawab semua itu dalam <5 detik, **tanpa keluarin gas, tanpa private key.** Read-only — cuma baca RPC publik. Anggep ini "checklist sebelum mint".

**Yang lo butuhin:**
- Linux / macOS / WSL (Windows Subsystem for Linux)
- Node.js 20+ — cek dengan `node --version`
- Address contract yang mau di-audit
- (Opsional) address wallet yang mau dipakai mint — buat cek dari sisi wallet

## Yang dicek

1. **Auto-detect chain** — cari contract di Ethereum, Base, Arbitrum, Optimism, atau Polygon lewat `eth_getCode`.
2. **Baca contract** — name, symbol, mintPrice, totalSupply, maxSupply, paused, owner.
3. **Status verifikasi Sourcify** — `perfect`, `partial`, atau unverified. Link ke source viewer.
4. **Safety EIP-7702 wallet** (opsional) — deteksi EOA yang ke-delegate via type-4 transaction yang akan revert call `_safeMint` dengan `ERC721InvalidReceiver`.
5. **Saldo wallet + cek udah pernah mint** (opsional) — konfirmasi wallet ada gas dan belum pernah mint.
6. **Fee data + estimasi cost** — baseFee saat ini + saran maxFee + estimasi total cost di gas mint umum.
7. **Reference revert selector umum** — lookup cepat arti error buat diagnosa post-failure.

## Kenapa pakai tool ini

Mint NFT gagal karena alasan yang predictable:

- Contract di-pause → tx revert, lo tetap bayar gas.
- Sold out, tapi lo gak cek totalSupply.
- Wallet udah di-"upgrade" via EIP-7702 → `_safeMint` callback ke delegate, delegate gak implement `onERC721Received`, revert.
- Contract unverified → lo gak tau `mint()` ngapain.
- mintPrice on-chain beda sama yang website tulis → revert `WrongPrice()`.

Script ini catch semua itu dalam <5 detik, read-only, gak butuh key.

## Install

```bash
git clone https://github.com/zyapasha/fredy-evm-preflight.git
cd fredy-evm-preflight
npm install
```

Butuh Node.js 20+.

## Cara pakai

```bash
# Audit contract (auto-detect chain)
node preflight.js 0xCONTRACT

# Audit contract + cek wallet tertentu
node preflight.js 0xCONTRACT 0xWALLET

# Force chain (skip detection, lebih cepat)
node preflight.js 0xCONTRACT --chain=base

# Mode quiet (suppress probe log)
node preflight.js 0xCONTRACT --quiet
```

## Contoh output

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

## Deteksi EIP-7702

Pectra (Mei 2025) introduce type-4 transaction yang ngebolehin EOA install code via authorization list. Code-nya tinggal di EOA dengan prefix `0xef0100<delegate>`. Kalau lo mint ke wallet yang konek ke Coinbase Smart Wallet, MetaMask Smart Account, Ambire, atau AA UI lain yang auto-install delegate, semua `_safeMint` akan revert dengan `ERC721InvalidReceiver(receiver)`.

Tool ini deteksi prefix `0xef0100` dan decode address delegate. Buat revoke sebelum mint, kirim type-4 self-tx dengan `authorizationList=[{delegate: 0x0, nonce: tx_nonce+1}]`. Cost ~36-50k gas.

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

Setelah tx revoke confirm, `eth_getCode` return `0x` dan `_safeMint` jalan lagi.

## Quick reference revert selector

| Selector | Error |
| --- | --- |
| `0x64a0ae92` | `ERC721InvalidReceiver(address)` — EIP-7702 delegate / receiver buruk |
| `0xf7760f25` | `WrongPrice()` — `msg.value` ≠ `MINT_PRICE` |
| `0x8c4841e4` | `MintCodeAlreadyUsed()` |
| `0x8baa579f` | `InvalidSignature()` |
| `0xa9fbf51f` | `PublicMintLimitReached()` |

Buat decode selector lain:

```python
from eth_utils import keccak
print('0x' + keccak(text='SomeError(uint256)')[:4].hex())
```

## Limitations

- Gak simulate call `mint()` aktual (perlu tau args + value). Pakai `mint --dry` dari `fredy-mint-executor` buat simulasi penuh.
- Sourcify "perfect" gak berarti contract aman — cuma berarti bytecode match dengan source publish. Selalu baca fungsi `mint()` di source viewer buat footgun: mintPrice hard-coded vs owner-settable, reentrancy guard, cap supply, `selfdestruct`, `delegatecall`, role owner yang bisa drain dana.
- Function probe pake nama standar (`mintPrice`, `MINT_PRICE`, `paused`, dst). Nama custom gak ke-detect.

## Lisensi

MIT — lihat [LICENSE](LICENSE).

## Disclaimer

Tool audit read-only. Gak broadcast tx atau sign apapun. Tapi status verifikasi Sourcify bukan jaminan safety contract — selalu baca source code sendiri sebelum bayar gas.
