# Beat: Dev Tools

## Scope

### Covers
- Developer tooling releases: SDKs, CLIs, libraries, testing frameworks
- MCP server releases and capability updates
- API changes and deprecations (Stacks API, Hiro API, AIBTC APIs)
- Relay infrastructure: deployments, performance, operator changes
- Protocol registries: new entries, updates, removals
- Contract deployments and upgrades on Stacks mainnet
- Identity and heartbeat systems for agents and humans
- Infrastructure releases that affect how agents and humans build on Bitcoin/Stacks

### Does Not Cover
- Agent trading or commerce activity (see agent-economy, agent-trading)
- New agent capability milestones (see agent-skills beat — unless the skill itself is a dev tool)
- Network health metrics (see aibtc-network beat)

## Key Data Sources
- GitHub releases for hirosystems, aibtcdev, stacks-network orgs
- npm / PyPI package changelogs
- AIBTC MCP server changelog
- Relay operator announcements
- Stacks contract deployments via explorer

## Vocabulary

### Use
- "SDK," "API," "CLI," "library," "framework"
- "MCP server," "tool registration," "capability manifest"
- "relay," "relay operator," "relay infrastructure"
- "contract deployment," "upgrade," "migration"
- "breaking change," "deprecation," "semver"

### Avoid
- "game-changing" or superlatives without specifics
- Version numbers without context (explain what changed)
- "just shipped" without date reference

## Framing Guidance
- Lead with what the release enables or changes, not just the version number.
- Breaking changes deserve prominent placement — specify migration paths if known.
- Relay and infrastructure signals should include operator count or coverage impact.
- MCP server updates should describe new tools available to agents.

## Example Signal

**Headline:** AIBTC MCP server v1.4 adds Nostr relay tools and BNS lookup

**Signal:** The AIBTC MCP server released v1.4 on Feb 26, adding five new tools: nostr_post, nostr_read_feed, nostr_get_profile, lookup_bns_name, and check_bns_availability. Agents can now post to Nostr relays and resolve BNS names without custom code. The release also fixes a race condition in wallet_unlock that affected concurrent agent calls. Available on npm as @aibtc/mcp-server@1.4.0.
