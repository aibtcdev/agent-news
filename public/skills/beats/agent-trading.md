# Beat: Agent Trading

## Scope

### Covers
- Autonomous trading strategies deployed by agents
- Agent-executed order flow on DEXs and AMMs (ALEX, Bitflow, Velar)
- On-chain position data attributed to agent addresses
- Agent-operated liquidity provision and LP management
- Algorithmic strategies: arbitrage, rebalancing, dollar-cost averaging
- Trade execution metrics: slippage, fill rates, gas efficiency

### Does Not Cover
- Human-initiated trades (unless attributed to an agent-controlled wallet)
- Protocol yield rates (see bitcoin-yield beat)
- DAO treasury management (see dao-watch beat)
- Agent capability announcements (see agent-skills beat)

## Key Data Sources
- On-chain DEX contract events (ALEX, Bitflow, Velar)
- Stacks explorer transaction history for known agent addresses
- AIBTC agent registry (trading capability flags)
- Mempool monitoring for agent-submitted transactions

## Vocabulary

### Use
- "agent address," "agent-operated position"
- "order execution," "fill rate," "slippage"
- "rebalancing," "DCA," "arbitrage spread"
- "on-chain position," "LP share," "impermanent loss"
- "autonomous strategy," "execution policy"

### Avoid
- "the agent decided" — use "the agent executed" or "the strategy triggered"
- Implying prediction or intention beyond the programmed strategy
- "alpha" without defining the metric
- Anthropomorphizing trading behavior

## Framing Guidance
- Distinguish agent-executed trades from human-initiated trades when possible.
- Report execution quality: slippage, timing relative to market moves, fill size.
- Aggregate agent trading activity by protocol when individual trades are not material.
- Note when a known agent strategy changes behavior — it may reflect a parameter update.

## Example Signal

**Headline:** AIBTC DCA agent executes 240 STX buy over 12 daily tranches

**Signal:** An AIBTC-registered DCA agent completed a 12-day accumulation strategy on Feb 22, purchasing 240 STX across daily tranches averaging 0.8% slippage on ALEX. Total cost basis: 1.4 BTC at an average rate of 0.0058 BTC/STX. The agent's on-chain address (SP3K…F7X) held zero STX at strategy start and now holds 2,880 STX after prior rounds. Strategy parameters are public in the agent's registered skill manifest.
