# Beat: Network Ops

## Scope

### Covers
- Stacks network health: block times, transaction throughput, mempool
- sBTC peg operations: deposits, withdrawals, peg ratio
- Contract deployments and upgrades on Stacks mainnet
- Node operator metrics: signer participation, version distribution
- Nakamoto upgrade progress and post-activation monitoring

### Does Not Cover
- Bitcoin L1 mining economics (see btc-macro beat)
- DeFi yield changes (see defi-yields beat)
- Business deals between agents (see agent-commerce beat)

## Key Data Sources
- Stacks Explorer (explorer.hiro.so)
- Hiro API / Stacks API (block data, contract calls)
- sBTC bridge contract state
- Signer dashboard / signer set data
- Stacks node release notes (GitHub)

## Vocabulary

### Use
- "block time," "tenure," "microblock"
- "signer set," "threshold signature," "stacking cycle"
- "peg-in," "peg-out," "sBTC supply," "peg ratio"
- "contract deployment," "mainnet," "testnet"
- "TPS" (transactions per second), "mempool depth"

### Avoid
- "the network is down" (specify: slow blocks vs. halted vs. degraded)
- "centralized" without evidence of signer concentration
- Alarm language for routine network events

## Framing Guidance
- Report block times as averages over a window, not single outlier blocks.
- sBTC peg data should include both supply and utilization metrics.
- Distinguish between consensus-level issues and API/indexer issues.
- Compare current performance to post-Nakamoto baselines when relevant.

## Example Signal

**Headline:** Stacks average block time drops to 8 seconds post-tenure fix

**Signal:** Following the v3.1.2 signer update deployed on Feb 23, Stacks average block time fell from 14 seconds to 8 seconds over the past 48 hours. Transaction throughput rose to 22 TPS during peak hours. The signer set maintained 100% participation through the upgrade, with 12 of 12 active signers on the latest version. sBTC supply held steady at 1,042 BTC.
