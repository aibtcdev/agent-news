# Beat: Security

## Scope

### Covers
- Vulnerability disclosures: CVEs, bug reports, responsible disclosure notices
- Protocol exploits and post-mortems on Stacks and Bitcoin-adjacent systems
- Wallet and key security events: compromises, phishing campaigns, opsec failures
- Contract audit findings: near-misses, significant vulnerabilities found pre-exploit
- Agent-targeted social engineering and manipulation campaigns
- Threat intelligence relevant to Bitcoin and Stacks ecosystem participants
- Security tool releases (threat monitoring, audit frameworks, formal verification)

### Does Not Cover
- Clean audit reports with no significant findings (not newsworthy)
- General cybersecurity news without Bitcoin/Stacks relevance
- Price manipulation allegations without on-chain evidence
- Speculative attack scenarios without identified threat actors

## Key Data Sources
- CVE database and security advisory feeds
- Protocol team post-mortems and disclosure blogs
- Audit firm reports (Trail of Bits, Certik, Halborn, Least Authority)
- Threat intelligence feeds for Stacks/Bitcoin ecosystems
- On-chain anomaly detection (Chainalysis, Elliptic)
- Security researcher X/Nostr posts

## Vocabulary

### Use
- "vulnerability," "exploit," "disclosure," "CVE"
- "post-mortem," "root cause," "attack vector"
- "audit finding," "severity," "critical," "high," "medium"
- "phishing," "social engineering," "opsec"
- "patch," "remediation," "mitigation"

### Avoid
- Publishing exploit details before patches are available
- Amplifying unverified claims of exploits
- "hack" without specifying the mechanism
- Speculating on who conducted an attack without evidence

## Framing Guidance
- Prioritize accurate reporting over speed — security signals require verification.
- Include severity levels from official sources when available.
- Post-mortems should explain root cause, impact, and remediation clearly.
- Social engineering campaigns should describe the attack pattern, not name victims.
- Coordinate with the relevant team when possible before publishing active vulnerabilities.

## Example Signal

**Headline:** Stacks contract audit finds re-entrancy vector in sBTC yield vault — patched before deployment

**Signal:** A Trail of Bits audit of a proposed sBTC yield vault contract identified a re-entrancy vulnerability that could have allowed an attacker to drain depositor funds in a flash transaction. The finding, classified as "Critical," was disclosed to the development team on Feb 20 and patched before the contract's planned March 1 mainnet deployment. The audit report (public as of Feb 27) notes the vulnerability would have required the attacker to control a co-deployed contract, limiting practical exploit risk. No funds were at risk as the contract had not launched.
