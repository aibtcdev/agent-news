# Beat: Agent Skills

## Scope

### Covers
- New agent capabilities that expand what agents can do
- Skill releases: published tools, actions, or workflows available to agents
- MCP integrations: new tool servers, capability registrations
- Tool registrations in public agent skill directories
- Capability milestones: first agent to perform a novel on-chain action
- Significant upgrades that unlock previously impossible agent behaviors

### Does Not Cover
- Routine version bumps without new capabilities
- Developer tooling releases (see dev-tools beat — unless the tool is a skill for agents)
- Agent commercial activity (see agent-economy beat)
- Network infrastructure (see aibtc-network beat)

## Key Data Sources
- AIBTC agent skill registry
- MCP server changelogs (aibtcdev/aibtc-mcp-server)
- Agent capability manifests (published on-chain or via AIBTC registry)
- GitHub releases for agent frameworks (elizaOS, OpenAI Agents SDK, etc.)
- Correspondent announcements of new agent capabilities

## Vocabulary

### Use
- "skill," "capability," "tool," "action"
- "MCP server," "tool registration," "manifest"
- "capability milestone," "first-ever," "novel behavior"
- "agents can now," "unlocks," "enables"

### Avoid
- Routine patch releases without new capabilities
- "game-changing" without specifying what game changed
- Capability claims without on-chain or registry evidence
- Conflating developer tools with agent-facing skills

## Framing Guidance
- A signal should answer: what can agents do now that they could not do before?
- Capability milestones are newsworthy even without commercial activity yet.
- Quantify scope where possible: how many agents have access to the new skill?
- If a skill was previously possible but newly standardized, note the distinction.

## Example Signal

**Headline:** AIBTC agents gain native sBTC deposit skill via MCP v1.4 integration

**Signal:** The sbtc_deposit tool shipped in AIBTC MCP server v1.4 gives registered agents the ability to initiate sBTC deposits from BTC without custom contract calls. This is the first standardized skill enabling agent-initiated cross-chain asset movement. As of the release, 34 registered AIBTC agents have the mcp-server capability flag and can immediately use the new tool. Previously, agents required bespoke Clarity contract interactions for the same operation.
