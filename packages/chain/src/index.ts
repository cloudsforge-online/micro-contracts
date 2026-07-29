/**
 * Chain families, confirmation policy, and smallest-unit amount arithmetic.
 *
 * **This is the narrowest package in the set, and it is exact-pinned by every consumer.**
 *
 * `wallet`, `settlement`, `custody` and `indexer` must agree byte-for-byte on the values in this
 * file. A skew in `RATE_SCALE`, in a confirmation depth, or in the rounding direction of
 * `shardsForCoinAmount` is not a 500 — it is money credited at the wrong depth, or a balance that
 * silently disagrees with the chain. That is a financial incident, so this package is pinned to
 * an exact version rather than a caret range, and a change to it is a coordinated release.
 *
 * Everything here is pure. No I/O, no dependencies, no environment.
 */

export type ChainFamily = 'evm' | 'ember' | 'solana' | 'bitcoin' | 'xrp'

export type Network = 'mainnet' | 'testnet'

export type AssetCode = 'EMBER' | 'BTC' | 'ETH' | 'SOL' | 'XRP' | 'SHARD'

export interface ChainSpec {
  readonly asset: AssetCode
  readonly family: ChainFamily
  readonly name: string
  /** Smallest-unit exponent. EMBER is 18 because Hearth is an account-model EVM chain. */
  readonly decimals: number
  /** Blocks (or ledgers) before a deposit is credited. */
  readonly confirmations: number
  /**
   * A reorg at least this deep halts crediting for the chain and pages.
   *
   * Set below `confirmations` deliberately: a reorg shallower than the credit depth cannot have
   * produced a wrong credit, so it is noise. One at or past this depth means the assumption the
   * depth encodes has failed.
   */
  readonly reorgAlarmDepth: number
  /** Chain id where the family has one. Ember mainnet is 7411, testnet 7412. */
  readonly chainId?: Readonly<Record<Network, number>>
  readonly explorerTxUrl: Readonly<Record<Network, string | null>>
}

/**
 * The supported chains.
 *
 * EMBER's depth of 60 (~15 minutes at a 15-second block time) is the number Hearth publishes to
 * exchanges in `docs/exchange-integration.md` §4. It is high because Hearth is a young CPU-mined
 * chain with no finality gadget, and depth is the only defence available.
 */
export const CHAINS: Readonly<Record<AssetCode, ChainSpec>> = Object.freeze({
  EMBER: Object.freeze({
    asset: 'EMBER',
    family: 'ember',
    name: 'Hearth',
    decimals: 18,
    confirmations: 60,
    reorgAlarmDepth: 5,
    chainId: Object.freeze({ mainnet: 7411, testnet: 7412 }),
    explorerTxUrl: Object.freeze({
      mainnet: 'https://explorer.cloudsforge.online/#/tx/',
      testnet: 'https://explorer.cloudsforge.online/#/tx/',
    }),
  }),
  ETH: Object.freeze({
    asset: 'ETH',
    family: 'evm',
    name: 'Ethereum',
    decimals: 18,
    confirmations: 12,
    reorgAlarmDepth: 3,
    chainId: Object.freeze({ mainnet: 1, testnet: 11155111 }),
    explorerTxUrl: Object.freeze({
      mainnet: 'https://etherscan.io/tx/',
      testnet: 'https://sepolia.etherscan.io/tx/',
    }),
  }),
  BTC: Object.freeze({
    asset: 'BTC',
    family: 'bitcoin',
    name: 'Bitcoin',
    decimals: 8,
    confirmations: 3,
    reorgAlarmDepth: 2,
    explorerTxUrl: Object.freeze({
      mainnet: 'https://mempool.space/tx/',
      testnet: 'https://mempool.space/testnet/tx/',
    }),
  }),
  SOL: Object.freeze({
    asset: 'SOL',
    family: 'solana',
    name: 'Solana',
    decimals: 9,
    confirmations: 32,
    reorgAlarmDepth: 8,
    explorerTxUrl: Object.freeze({
      mainnet: 'https://solscan.io/tx/',
      testnet: 'https://solscan.io/tx/',
    }),
  }),
  XRP: Object.freeze({
    asset: 'XRP',
    family: 'xrp',
    name: 'XRP Ledger',
    decimals: 6,
    confirmations: 1,
    reorgAlarmDepth: 1,
    explorerTxUrl: Object.freeze({
      mainnet: 'https://livenet.xrpl.org/transactions/',
      testnet: 'https://testnet.xrpl.org/transactions/',
    }),
  }),
  SHARD: Object.freeze({
    asset: 'SHARD',
    family: 'evm', // never used on chain; present so the record is total
    name: 'Shards',
    decimals: 0,
    confirmations: 0,
    reorgAlarmDepth: 0,
    explorerTxUrl: Object.freeze({ mainnet: null, testnet: null }),
  }),
})

export const ON_CHAIN_ASSETS: readonly AssetCode[] = Object.freeze([
  'EMBER',
  'BTC',
  'ETH',
  'SOL',
  'XRP',
])

export function chainSpec(asset: AssetCode): ChainSpec {
  const spec = CHAINS[asset]
  if (!spec) throw new Error(`unknown asset: ${asset}`)
  return spec
}

/**
 * Fixed-point scale for exchange rates. Six decimal places, as BigInt.
 *
 * Rates are never floats. A float rate applied to an 18-decimal amount loses precision in the
 * least significant digits, which is exactly where a reconciliation drift shows up.
 */
export const RATE_SCALE = 1_000_000n

/** Shards per US dollar. 100 Shards = 1 USD, fixed. */
export const SHARDS_PER_USD = 100n

/**
 * Convert a smallest-unit coin amount to Shards at a scaled USD rate.
 *
 * **Rounds down, always.** Rounding a credit up mints Shards that no coin backs; over enough
 * conversions that is a growing, invisible liability. Rounding down leaves dust in the user's
 * favour on the coin side, which reconciliation can see.
 */
export function shardsForCoinAmount(
  smallestUnits: bigint,
  decimals: number,
  usdPerCoinScaled: bigint,
): bigint {
  if (smallestUnits < 0n) throw new RangeError('amount must not be negative')
  if (usdPerCoinScaled < 0n) throw new RangeError('rate must not be negative')
  const divisor = 10n ** BigInt(decimals)
  return (smallestUnits * usdPerCoinScaled * SHARDS_PER_USD) / (divisor * RATE_SCALE)
}

/** The inverse. Also rounds down, so a user is never given more coin than their Shards buy. */
export function coinAmountForShards(
  shards: bigint,
  decimals: number,
  usdPerCoinScaled: bigint,
): bigint {
  if (shards < 0n) throw new RangeError('shards must not be negative')
  if (usdPerCoinScaled <= 0n) throw new RangeError('rate must be positive')
  const multiplier = 10n ** BigInt(decimals)
  return (shards * multiplier * RATE_SCALE) / (usdPerCoinScaled * SHARDS_PER_USD)
}

/**
 * Format a smallest-unit amount for display. Never used for arithmetic.
 *
 * Returns a plain decimal string with no thousands separators and no currency symbol, because
 * locale formatting belongs in the browser and a formatted number that finds its way back into a
 * calculation is a bug waiting to happen.
 */
export function formatAmount(smallestUnits: bigint, decimals: number): string {
  const negative = smallestUnits < 0n
  const abs = negative ? -smallestUnits : smallestUnits
  const divisor = 10n ** BigInt(decimals)
  const whole = abs / divisor
  const fraction = abs % divisor
  const sign = negative ? '-' : ''
  if (decimals === 0) return `${sign}${whole}`
  const fractionText = fraction.toString().padStart(decimals, '0').replace(/0+$/, '')
  return fractionText ? `${sign}${whole}.${fractionText}` : `${sign}${whole}`
}

/** Parse a decimal string into smallest units. Refuses more precision than the asset has. */
export function parseAmount(text: string, decimals: number): bigint {
  const trimmed = text.trim()
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) throw new RangeError(`not a decimal amount: ${text}`)
  const negative = trimmed.startsWith('-')
  const [whole = '0', fraction = ''] = (negative ? trimmed.slice(1) : trimmed).split('.')
  if (fraction.length > decimals) {
    throw new RangeError(`too many decimal places for an asset with ${decimals}`)
  }
  const padded = fraction.padEnd(decimals, '0')
  const value = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded === '' ? '0' : padded)
  return negative ? -value : value
}

/** Is a deposit creditable at this depth? The single question every crediting path asks. */
export function isConfirmed(asset: AssetCode, confirmations: number): boolean {
  return confirmations >= chainSpec(asset).confirmations
}

/** Should a reorg of this depth halt the chain? */
export function isReorgAlarming(asset: AssetCode, depth: number): boolean {
  const spec = chainSpec(asset)
  return spec.reorgAlarmDepth > 0 && depth >= spec.reorgAlarmDepth
}

export function explorerTxUrl(asset: AssetCode, network: Network, txHash: string): string | null {
  const base = chainSpec(asset).explorerTxUrl[network]
  return base ? `${base}${txHash}` : null
}

/**
 * A canonical URN for a chain transaction, used as a cross-service reference.
 *
 * Includes the network, because an XRP address and its transactions are valid on testnet and
 * mainnet alike — a reference without the network is ambiguous in exactly the case that matters.
 */
export function txUrn(asset: AssetCode, network: Network, txHash: string): string {
  return `cf:chain:${asset.toLowerCase()}:${network}:${txHash}`
}
