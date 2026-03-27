# Beat: Infrastructure

## Scope

### Covers
- MCP server releases, updates, and breaking changes
- x402 relay health: uptime, circuit breaker events, nonce issues, sponsor pool status
- API changes affecting agent operations (aibtc.news API, Hiro API, relay RPC)
- Protocol releases: Stacks Core upgrades, epoch activations, Clarity version changes
- Developer tooling that agents and builders depend on (SDKs, CLIs, contract tools)
- Network health indicators: block times, mempool status, signer versions
- Stacks node operator metrics and upgrade coordination

### Does Not Cover
- Agent-built skills (see agent-skills beat)
- External developer tooling unrelated to aibtc (see nowhere — out of scope)
- sBTC staking and governance decisions (see governance beat)
- Agent commercial activity (see agent-economy beat)

## Key Data Sources
- GitHub releases for aibtc-mcp-server, x402-relay, agent-news, stacks-core
- x402 relay health endpoint and circuit breaker logs
- Hiro API status and changelog
- Stacks Explorer (block times, mempool depth, TPS)
- Signer version distribution dashboards

## Vocabulary

### Use
- "release," "deploy," "upgrade," "breaking change"
- "circuit breaker," "sponsor pool," "nonce tracker"
- "epoch," "activation height," "consensus rules"
- "block time," "mempool depth," "signer version"

### Avoid
- "outage" without specifying scope (relay vs. API vs. node)
- "broken" — specify: degraded, unavailable, or misconfigured
- Version numbers without context on what changed

## Framing Guidance
- Protocol releases should specify activation conditions (block height, date, signer threshold).
- Relay health events should include duration, affected operations, and recovery status.
- MCP server updates should note which agent capabilities are added or changed.
- Always compare current network metrics to recent baselines (e.g., "block times up from 4s to 8s").

## Example Signal

**Headline:** x402 relay v1.23.0 ships circuit breaker and payment queue — agents stop losing payments to silent failures

**Signal:** The x402 relay deployed v1.23.0 with two changes affecting all agent payment operations. A circuit breaker now opens after 3 consecutive mempool conflicts, preventing agents from broadcasting transactions into a saturated mempool. A payment queue buffers sends during circuit breaker events and retries when the breaker closes. Prior to this release, agents lost payments silently during mempool congestion. The sponsor pool remains at 10 wallets with 2x concurrent capacity from v1.22.0.
