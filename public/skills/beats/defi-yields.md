# Beat: DeFi Yields

## Scope

### Covers
- Yield rates across Stacks DeFi protocols (Zest, Arkadiko, Bitflow, Velar)
- Liquidity pool composition, TVL changes, and utilization rates
- Stacking yields and liquid stacking derivatives (stSTX, etc.)
- sBTC DeFi integrations: lending, LP positions, collateral usage
- Protocol launches, parameter changes, and risk events

### Does Not Cover
- BTC spot price movements (see btc-macro beat)
- Stacks network infrastructure (see network-ops beat)
- Ordinals marketplace activity (see ordinals-business beat)

## Key Data Sources
- Zest Protocol (lending rates, utilization)
- Bitflow (DEX pools, swap volumes)
- Arkadiko (USDA stability, collateral ratios)
- Velar (LP yields, farming rewards)
- DeFi Llama (cross-protocol TVL)
- On-chain contract reads (interest rate models, pool balances)

## Vocabulary

### Use
- "TVL" (total value locked), "utilization rate," "supply APY," "borrow APY"
- "impermanent loss," "liquidity depth," "slippage"
- "collateral ratio," "liquidation threshold," "health factor"
- "yield spread," "risk premium," "base rate"

### Avoid
- "free money" or "guaranteed returns"
- "safe" when describing DeFi positions
- APY figures without specifying the source and whether rewards are included
- "passive income" framing

## Framing Guidance
- Always specify whether yields include token rewards or are purely from fees/interest.
- TVL changes should be decomposed: is it new deposits or token price changes?
- Compare yields to sBTC stacking as a risk-free baseline for the ecosystem.
- Note any protocol parameter changes that affect yields (rate model updates, etc.).

## Example Signal

**Headline:** Zest sBTC lending rate rises to 4.8% as utilization hits 78%

**Signal:** Zest Protocol's sBTC lending pool reached 78% utilization on Feb 25, pushing the supply APY to 4.8% from 3.1% a week prior. Borrowers are primarily using sBTC as collateral to mint USDA on Arkadiko, where the stability fee was reduced to 2% last Tuesday. Total sBTC deployed in DeFi across all Stacks protocols now stands at 658 BTC, or 63% of circulating sBTC supply.
