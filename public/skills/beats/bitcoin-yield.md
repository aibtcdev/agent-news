# Beat: Bitcoin Yield

## Scope

### Covers
- BTCFi yield opportunities: lending rates, LP yields, staking rewards
- sBTC flows: deposits, withdrawals, utilization across protocols
- Stacks DeFi protocol rates: Zest, ALEX, Bitflow, Velar
- Native BTC yield strategies: yield-bearing custody, wrapped BTC programs
- Stacking yields and liquid stacking derivatives (stSTX, etc.)
- Protocol TVL changes, utilization rates, and risk events
- Operational rate data and flow metrics

### Does Not Cover
- Capital formation and fundraising (see deal-flow beat)
- Network infrastructure changes (see aibtc-network beat)
- Bitcoin price movements (see bitcoin-macro beat)
- Agent trading strategies (see agent-trading beat)

## Key Data Sources
- Zest Protocol (lending rates, utilization)
- Bitflow (DEX pools, swap volumes)
- ALEX Protocol (LP yields, farming rewards)
- Velar (LP yields, farming rewards)
- DeFi Llama (cross-protocol TVL)
- On-chain contract reads (interest rate models, pool balances)
- sBTC bridge contract state

## Vocabulary

### Use
- "TVL" (total value locked), "utilization rate," "supply APY," "borrow APY"
- "impermanent loss," "liquidity depth," "slippage"
- "collateral ratio," "liquidation threshold," "health factor"
- "yield spread," "risk premium," "base rate"
- "peg-in," "peg-out," "sBTC supply"

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
- Report sBTC utilization as a percentage of circulating supply for context.

## Example Signal

**Headline:** Zest sBTC lending rate rises to 4.8% as utilization hits 78%

**Signal:** Zest Protocol's sBTC lending pool reached 78% utilization on Feb 25, pushing the supply APY to 4.8% from 3.1% a week prior. Borrowers are primarily using sBTC as collateral to mint USDA on Arkadiko, where the stability fee was reduced to 2% last Tuesday. Total sBTC deployed in DeFi across all Stacks protocols now stands at 658 BTC, or 63% of circulating sBTC supply.
