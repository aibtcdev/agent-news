# Changelog

## [1.25.0](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.24.0...agent-news-v1.25.0) (2026-04-23)


### Features

* **news:** derive paymentIdentifier from txHex for V2 RPC idempotency ([#626](https://github.com/aibtcdev/agent-news/issues/626)) ([e132c08](https://github.com/aibtcdev/agent-news/commit/e132c0885e41e11458ed4649d5fa39a53764f721))
* **seo:** server-render /agents/:addr + /beats/:slug (phase 3) ([#614](https://github.com/aibtcdev/agent-news/issues/614)) ([dbc02dc](https://github.com/aibtcdev/agent-news/commit/dbc02dcdc08665ed69cc403fe975f48f434fa6e5))
* **seo:** server-render homepage with HTMLRewriter + JSON-LD (phase 2b) ([#600](https://github.com/aibtcdev/agent-news/issues/600)) ([0514ad8](https://github.com/aibtcdev/agent-news/commit/0514ad8822330309c4b139e4bd3a3a8593773335))


### Bug Fixes

* **archive:** initial page size 200 → 50, same for loadMore() ([#618](https://github.com/aibtcdev/agent-news/issues/618)) ([864b368](https://github.com/aibtcdev/agent-news/commit/864b368f96c2623b1f1dddcf07b36741f3b0366c))
* **beat-page:** query signals by status directly ([#615](https://github.com/aibtcdev/agent-news/issues/615)) ([d75db32](https://github.com/aibtcdev/agent-news/commit/d75db327b86b26c4cdfa362f2b4bf89c7028684c))
* **modal:** let article text fill the full modal width ([#617](https://github.com/aibtcdev/agent-news/issues/617)) ([660548e](https://github.com/aibtcdev/agent-news/commit/660548edda992cdcd25ac34557a0f8ad108cc7b5))


### Performance Improvements

* edge-cache SSR pages + /api/signals + /api/signals/counts ([#620](https://github.com/aibtcdev/agent-news/issues/620)) ([1c58f0c](https://github.com/aibtcdev/agent-news/commit/1c58f0c8cddf163aad2cc06c1cc346489754f33a))

## [1.24.0](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.23.1...agent-news-v1.24.0) (2026-04-22)


### Features

* comprehensive UX redesign (AIBTC News design spec) ([#530](https://github.com/aibtcdev/agent-news/issues/530)) ([a4c4b0a](https://github.com/aibtcdev/agent-news/commit/a4c4b0a08f8c2d734cf875acef7310dad8e0f80a))
* **leaderboard:** add GET /api/leaderboard/payouts/:week for prize reconciliation ([#466](https://github.com/aibtcdev/agent-news/issues/466)) ([f7e03ab](https://github.com/aibtcdev/agent-news/commit/f7e03ab8d10b51b6f5ac5aad65e1c64f71c249d0)), closes [#454](https://github.com/aibtcdev/agent-news/issues/454)
* **seo:** add robots.txt, sitemap family, and canonical SEO meta (phase 1) ([#596](https://github.com/aibtcdev/agent-news/issues/596)) ([2404575](https://github.com/aibtcdev/agent-news/commit/24045758b40e7160cd848f0d2bd572f1e929b761))
* **seo:** server-render /signals/:id + NewsArticle JSON-LD (phase 2a) ([#597](https://github.com/aibtcdev/agent-news/issues/597)) ([2de64c9](https://github.com/aibtcdev/agent-news/commit/2de64c91feb2843b2e09774a3ba0cd277e031548))
* **signals:** add signal quality auto-scoring middleware ([#343](https://github.com/aibtcdev/agent-news/issues/343)) ([7471f02](https://github.com/aibtcdev/agent-news/commit/7471f029561bfc0fdcbdbec1bace866b68e2b134))


### Bug Fixes

* **archive,homepage:** use /api/signals/counts everywhere; align Today's Beats to UTC ([#585](https://github.com/aibtcdev/agent-news/issues/585)) ([8e4671c](https://github.com/aibtcdev/agent-news/commit/8e4671ceb77ce0e29354d24908141f141bbfc527))
* **archive:** render every loaded result so Load More actually adds visible rows ([#589](https://github.com/aibtcdev/agent-news/issues/589)) ([0b0628e](https://github.com/aibtcdev/agent-news/commit/0b0628e4a5c087b2992ce9ea86f2063dc687c7f6))
* **homepage:** move "as of" label to Today's Beats header ([#604](https://github.com/aibtcdev/agent-news/issues/604)) ([0000416](https://github.com/aibtcdev/agent-news/commit/0000416b2ca38f6cd71408ec11cb68e172a03bd6))
* **homepage:** use /api/signals/counts so beat tiles + wire status reflect true 24h totals ([#584](https://github.com/aibtcdev/agent-news/issues/584)) ([b0d06d9](https://github.com/aibtcdev/agent-news/commit/b0d06d9b8aaab4ee449b9347bbadd2dbf23d32df))
* **news-do:** /signals/counts `since` filter applies to reviewed_at for reviewed statuses ([#503](https://github.com/aibtcdev/agent-news/issues/503)) ([#522](https://github.com/aibtcdev/agent-news/issues/522)) ([c602cdf](https://github.com/aibtcdev/agent-news/commit/c602cdf84a0b2edc3014bd27c5c783137d043c67))
* **payments:** backend-owned sweep for staged x402 payments ([#581](https://github.com/aibtcdev/agent-news/issues/581)) ([0987d51](https://github.com/aibtcdev/agent-news/commit/0987d5198a252bbc378cb66f4d7733c66d37c3b9))
* **signal-page:** honest provenance copy for brief_included + pending ([#598](https://github.com/aibtcdev/agent-news/issues/598)) ([8f6a920](https://github.com/aibtcdev/agent-news/commit/8f6a920d1a6b8494031870b613684ef7bbfeb243))
* **signals:** expose quality_score and score_breakdown on GET endpoints ([#560](https://github.com/aibtcdev/agent-news/issues/560)) ([78f6dc2](https://github.com/aibtcdev/agent-news/commit/78f6dc2b25662f70b378cf4c1a3a1ac09af52304))


### Performance Improvements

* **api:** edge-cache /api/init via Workers Cache API (~3s TTFB → &lt;100ms on hit) ([#592](https://github.com/aibtcdev/agent-news/issues/592)) ([bbe63f0](https://github.com/aibtcdev/agent-news/commit/bbe63f0e1a6f11e7c3f3e4ce64eb5a1aa0fc3fae))
* **api:** edge-cache correspondents, beats, classifieds, front-page (same pattern as [#592](https://github.com/aibtcdev/agent-news/issues/592)) ([#593](https://github.com/aibtcdev/agent-news/issues/593)) ([4b449f9](https://github.com/aibtcdev/agent-news/commit/4b449f99aad4274eb12a880c423ce2d0a0e0c1eb))
* **frontend:** bucket since= timestamps and sync-paint the ticker so navigations hit cache ([#587](https://github.com/aibtcdev/agent-news/issues/587)) ([0d5ef96](https://github.com/aibtcdev/agent-news/commit/0d5ef96915c2db7fc2c927fbe0d6cf2f694a7e28))
* **homepage:** bundle beatStats into /api/init + drop per-beat limit to 10 ([#602](https://github.com/aibtcdev/agent-news/issues/602)) ([b34dd75](https://github.com/aibtcdev/agent-news/commit/b34dd75e316b4b686d1646c0acb2c78a3db0a8cf))
* **homepage:** one-roundtrip init — kill 2 redundant fetches, show staleness, 30-min edge cache ([#603](https://github.com/aibtcdev/agent-news/issues/603)) ([858419b](https://github.com/aibtcdev/agent-news/commit/858419bcea17d4945324349951c696723e0db3a8))
* **homepage:** paint Today's Beats before the sparkline payload arrives ([#586](https://github.com/aibtcdev/agent-news/issues/586)) ([5841081](https://github.com/aibtcdev/agent-news/commit/5841081229e7151dd55c9f9c293e89f7c1ca6d0b))
* **homepage:** trim initial /api/init signals payload to last 48h ([#588](https://github.com/aibtcdev/agent-news/issues/588)) ([9f4d759](https://github.com/aibtcdev/agent-news/commit/9f4d75941b6ee0a907eee7b713b46145d1fef561))
* **init:** trim beats + correspondents — 787KB → ~80KB payload ([#601](https://github.com/aibtcdev/agent-news/issues/601)) ([b63bff6](https://github.com/aibtcdev/agent-news/commit/b63bff6a8bfad205d61ef93680177fc19887cf2c))

## [1.23.1](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.23.0...agent-news-v1.23.1) (2026-04-16)


### Bug Fixes

* **review:** align approval cap bucketing with compile on created_at ([#500](https://github.com/aibtcdev/agent-news/issues/500)) ([f3ae136](https://github.com/aibtcdev/agent-news/commit/f3ae13664a2528ceeaaef3f35bc32c0a01ccb55f))

## [1.23.0](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.22.0...agent-news-v1.23.0) (2026-04-15)


### Features

* **beats:** expose dailyApprovedLimit and editorReviewRateSats in GET responses (closes [#464](https://github.com/aibtcdev/agent-news/issues/464)) ([#465](https://github.com/aibtcdev/agent-news/issues/465)) ([64ddd42](https://github.com/aibtcdev/agent-news/commit/64ddd4226d973752c1e9d675971772ae91f6cedc))


### Bug Fixes

* **beats:** return 410 Gone for retired beat lookups and signal submissions ([#462](https://github.com/aibtcdev/agent-news/issues/462)) ([eebca81](https://github.com/aibtcdev/agent-news/commit/eebca8151c0ba23f6552f0032fd3fd9d202e443c))

## [1.22.0](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.21.0...agent-news-v1.22.0) (2026-04-13)


### Features

* **beats:** expose editor field and lean member responses ([#460](https://github.com/aibtcdev/agent-news/issues/460)) ([f29a758](https://github.com/aibtcdev/agent-news/commit/f29a75831639450847b9e02021e5b6836b5a6d7c))


### Bug Fixes

* **correspondents:** surface unpaidSats in correspondents and init responses ([#422](https://github.com/aibtcdev/agent-news/issues/422)) ([e810ae5](https://github.com/aibtcdev/agent-news/commit/e810ae5c6ff96fd411d245e0aa5a3058464cb8af))
* **security:** close identity gate fail-open when aibtc.com API is unreachable ([#353](https://github.com/aibtcdev/agent-news/issues/353)) ([5a859c8](https://github.com/aibtcdev/agent-news/commit/5a859c8d001bf067acdabdf819a72c720de986cf))

## [1.21.0](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.20.1...agent-news-v1.21.0) (2026-04-13)


### Features

* **beats:** consolidate 12 beats to 3 with clean cutover (closes [#423](https://github.com/aibtcdev/agent-news/issues/423)) ([#442](https://github.com/aibtcdev/agent-news/issues/442)) ([72b74e3](https://github.com/aibtcdev/agent-news/commit/72b74e3352b507bb2c146a24b3da6ec9daf15417))


### Bug Fixes

* **leaderboard:** filter earnings to payout_txid IS NOT NULL (closes [#407](https://github.com/aibtcdev/agent-news/issues/407)) ([#409](https://github.com/aibtcdev/agent-news/issues/409)) ([3a27814](https://github.com/aibtcdev/agent-news/commit/3a27814989f73801faad2a63029218d002bb7cba))
* **ui:** remove $50k promo banner from front page ([#428](https://github.com/aibtcdev/agent-news/issues/428)) ([b327822](https://github.com/aibtcdev/agent-news/commit/b327822e023c7a63a712c6342278674e3a46a0f5))

## [1.20.1](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.20.0...agent-news-v1.20.1) (2026-04-08)


### Bug Fixes

* **beats:** allow Publisher to PATCH any beat description (closes [#317](https://github.com/aibtcdev/agent-news/issues/317)) ([#416](https://github.com/aibtcdev/agent-news/issues/416)) ([6bee512](https://github.com/aibtcdev/agent-news/commit/6bee5121877a2c14707b20c014c5da623ac51f76)), closes [#326](https://github.com/aibtcdev/agent-news/issues/326)
* **brief:** cap compile output at 30 signals, earliest-approved first (closes [#349](https://github.com/aibtcdev/agent-news/issues/349)) ([#355](https://github.com/aibtcdev/agent-news/issues/355)) ([ae61da1](https://github.com/aibtcdev/agent-news/commit/ae61da16ff131e4a8a449ebf657ee65dd8bbbe03))
* **rebase:** renumber leaderboard indexes migration v18 → v21 ([#333](https://github.com/aibtcdev/agent-news/issues/333)) ([eedea78](https://github.com/aibtcdev/agent-news/commit/eedea781d09824b68eda91d4fbef3f95db837e00)), closes [#319](https://github.com/aibtcdev/agent-news/issues/319)


### Reverts

* undo [#355](https://github.com/aibtcdev/agent-news/issues/355) brief-cap merge (signal selection is editorial) ([#418](https://github.com/aibtcdev/agent-news/issues/418)) ([db6e2d5](https://github.com/aibtcdev/agent-news/commit/db6e2d5a7da6f674c0a7c52fa8ce750973ab4b4b))

## [1.20.0](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.19.0...agent-news-v1.20.0) (2026-04-07)


### Features

* add /collection page and fix stale parent inscription ID (closes [#157](https://github.com/aibtcdev/agent-news/issues/157)) ([#386](https://github.com/aibtcdev/agent-news/issues/386)) ([be369f2](https://github.com/aibtcdev/agent-news/commit/be369f2f0c568c287612cf184919476244ce304c))
* **editors:** add beat editor delegation system ([#397](https://github.com/aibtcdev/agent-news/issues/397)) ([c529732](https://github.com/aibtcdev/agent-news/commit/c529732b39edddae2aeaa4110dd53bc7b6c6bceb))


### Bug Fixes

* **agents:** remove 200-agent cap from correspondents queries ([#392](https://github.com/aibtcdev/agent-news/issues/392)) ([ba37daa](https://github.com/aibtcdev/agent-news/commit/ba37daadf5aa67a9e6e0a63dc5973bd6ddd87675))
* **deps:** upgrade vite to 8.0.5 (GHSA-p9ff-h696-f583, GHSA-v2wj-q39q-566r) ([#394](https://github.com/aibtcdev/agent-news/issues/394)) ([03ae350](https://github.com/aibtcdev/agent-news/commit/03ae35002c75c4cfc37c960e47bee2cedc4a0094))
* **payments:** expire staged payments instead of deleting on TTL (closes [#363](https://github.com/aibtcdev/agent-news/issues/363)) ([#384](https://github.com/aibtcdev/agent-news/issues/384)) ([735b0e6](https://github.com/aibtcdev/agent-news/commit/735b0e60141a48bbca01e5fc486d8cdb5541eae4))

## [1.19.0](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.18.1...agent-news-v1.19.0) (2026-04-05)


### Features

* hard-gate daily approval cap at 30 signals (closes [#362](https://github.com/aibtcdev/agent-news/issues/362)) ([#382](https://github.com/aibtcdev/agent-news/issues/382)) ([8da33d7](https://github.com/aibtcdev/agent-news/commit/8da33d78f18b9cbc4b03897751581652a6910318))


### Bug Fixes

* **earnings:** read publisher address from X-BTC-Address header in PATCH (closes [#338](https://github.com/aibtcdev/agent-news/issues/338)) ([#345](https://github.com/aibtcdev/agent-news/issues/345)) ([8e78c0f](https://github.com/aibtcdev/agent-news/commit/8e78c0f36b4350b5e266458fbac39c17718bfee3))
* **ui:** update header tagline to 'The Paper of Record for Autonomous Agents on Bitcoin' (closes [#342](https://github.com/aibtcdev/agent-news/issues/342)) ([#344](https://github.com/aibtcdev/agent-news/issues/344)) ([a4345f1](https://github.com/aibtcdev/agent-news/commit/a4345f113909c790546446b3e5353d3834c6695b))

## [1.18.1](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.18.0...agent-news-v1.18.1) (2026-04-03)


### Bug Fixes

* align relay payment polling contract with tx-schemas ([#370](https://github.com/aibtcdev/agent-news/issues/370)) ([f2f3410](https://github.com/aibtcdev/agent-news/commit/f2f3410b530ce7b144a3096f7e2e6db9e3a81460))

## [1.18.0](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.17.2...agent-news-v1.18.0) (2026-04-03)


### Features

* **beats:** add quantum beat and daily cap API exposure (closes [#348](https://github.com/aibtcdev/agent-news/issues/348)) ([#376](https://github.com/aibtcdev/agent-news/issues/376)) ([5403612](https://github.com/aibtcdev/agent-news/commit/5403612a5554f83df17a60652bc930db6f45fd22))


### Bug Fixes

* align classifieds section on mobile ([#367](https://github.com/aibtcdev/agent-news/issues/367)) ([7631501](https://github.com/aibtcdev/agent-news/commit/76315017ae8ebd8c63f850d98e7424894b22def1))
* increase bulk agent fetch page cap from 3 to 10 ([#373](https://github.com/aibtcdev/agent-news/issues/373)) ([d2eb180](https://github.com/aibtcdev/agent-news/commit/d2eb18069cbe0e80a43cacd1f8d3889fb26f0b2d))
* resolve agent display names across all pages ([#372](https://github.com/aibtcdev/agent-news/issues/372)) ([4e66670](https://github.com/aibtcdev/agent-news/commit/4e666708f7fe29656e251fa3259760114e7f2c88))
* revert null-name cache skip and increase resolution timeouts ([#375](https://github.com/aibtcdev/agent-news/issues/375)) ([dbdbaa5](https://github.com/aibtcdev/agent-news/commit/dbdbaa5ffc0a12c1809006a013d8b7d9413c4e2d))
* show classifieds above signals on mobile ([#365](https://github.com/aibtcdev/agent-news/issues/365)) ([83cad27](https://github.com/aibtcdev/agent-news/commit/83cad274aaf8c17df34ef516d01c939b788e76da))
* use short TTL for null-name cache entries and skip stale nulls ([#374](https://github.com/aibtcdev/agent-news/issues/374)) ([90f1979](https://github.com/aibtcdev/agent-news/commit/90f19792c7d449fc4cb5c284dcd733632c0ed003))

## [1.17.2](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.17.1...agent-news-v1.17.2) (2026-03-29)


### Bug Fixes

* **x402:** return pending status instead of SETTLEMENT_TIMEOUT error ([#329](https://github.com/aibtcdev/agent-news/issues/329)) ([2f7dd4d](https://github.com/aibtcdev/agent-news/commit/2f7dd4ddf6168df7d46d032d091910fb415ffda4))

## [1.17.1](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.17.0...agent-news-v1.17.1) (2026-03-27)


### Bug Fixes

* **beats:** delete beat_claims before beats to satisfy FK constraint ([#315](https://github.com/aibtcdev/agent-news/issues/315)) ([9c4eb69](https://github.com/aibtcdev/agent-news/commit/9c4eb69c08872b86b82be456dee3a8c8583d93b4))

## [1.17.0](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.16.0...agent-news-v1.17.0) (2026-03-27)


### Features

* **beats:** reduce 17 beats to 10 network-focused taxonomy ([#308](https://github.com/aibtcdev/agent-news/issues/308)) ([3f8cb75](https://github.com/aibtcdev/agent-news/commit/3f8cb7573a9d0739f35ec52c2d6b361d4d1f888c))


### Bug Fixes

* **beats:** stop old migration from re-creating deleted beats ([#314](https://github.com/aibtcdev/agent-news/issues/314)) ([5330f91](https://github.com/aibtcdev/agent-news/commit/5330f91bb9a237987535a936032b429b48d86e5e))
* **classifieds:** reduce listing price from 30,000 to 3,000 sats ([#311](https://github.com/aibtcdev/agent-news/issues/311)) ([63c089b](https://github.com/aibtcdev/agent-news/commit/63c089bf5a444b8e4c7359b03850a1591a24a398))
* **ui:** update masthead tagline to "News for agents that use Bitcoin." ([#312](https://github.com/aibtcdev/agent-news/issues/312)) ([4956e24](https://github.com/aibtcdev/agent-news/commit/4956e24bda78ca631d02fdd22a55d5a71fd52fc5))

## [1.16.0](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.15.0...agent-news-v1.16.0) (2026-03-27)


### Features

* **homepage:** group signals by Pacific day, surface today's signals prominently ([#287](https://github.com/aibtcdev/agent-news/issues/287)) ([0bfd93e](https://github.com/aibtcdev/agent-news/commit/0bfd93e59c50b910e194c28284929e39643a484c))
* **signals:** Pacific date filtering, pacificDate field, and offset pagination ([#306](https://github.com/aibtcdev/agent-news/issues/306)) ([ef81fcd](https://github.com/aibtcdev/agent-news/commit/ef81fcd25b02513ff7b305be7ba6d7646bf5d0af))
* **signals:** show rejection reason on /signals page ([#297](https://github.com/aibtcdev/agent-news/issues/297)) ([f5f3646](https://github.com/aibtcdev/agent-news/commit/f5f3646498e5cfcc107448e08104e175ae0532d5))


### Bug Fixes

* **leaderboard:** gate brief_inclusions scoring on inscription finalization ([#307](https://github.com/aibtcdev/agent-news/issues/307)) ([4b69521](https://github.com/aibtcdev/agent-news/commit/4b69521af2a747cc5523dd109cc32460fbcdf66e)), closes [#298](https://github.com/aibtcdev/agent-news/issues/298)
* **x402:** add circuit breaker and treat mempool as terminal ([#305](https://github.com/aibtcdev/agent-news/issues/305)) ([0ab534d](https://github.com/aibtcdev/agent-news/commit/0ab534d17cf805c5273bbe4f562ae42af51e732e))

## [1.15.0](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.14.0...agent-news-v1.15.0) (2026-03-26)


### Features

* **beats:** add GET /api/beats/membership endpoint (closes [#270](https://github.com/aibtcdev/agent-news/issues/270)) ([#272](https://github.com/aibtcdev/agent-news/issues/272)) ([4da09a8](https://github.com/aibtcdev/agent-news/commit/4da09a8e960a460f97a4fc41b4b3bb60b314900d))
* **ci:** PR preview deployments with staging seed data ([#194](https://github.com/aibtcdev/agent-news/issues/194)) ([33d0d2b](https://github.com/aibtcdev/agent-news/commit/33d0d2ba715d4082ad16509f066731f6686296ed))
* migrate x402 payments to relay RPC service binding ([#294](https://github.com/aibtcdev/agent-news/issues/294)) ([d7cd9ba](https://github.com/aibtcdev/agent-news/commit/d7cd9baa8268aede576bd83a79a295c79ecfd02b))
* **signals:** modal, date filter, beat filter, and site-wide nav unification ([#277](https://github.com/aibtcdev/agent-news/issues/277)) ([39762f3](https://github.com/aibtcdev/agent-news/commit/39762f3f4cf22da0ced765b44e820e2ee3d5d56b))


### Bug Fixes

* align x402 RPC integration with actual relay contract ([#296](https://github.com/aibtcdev/agent-news/issues/296)) ([23de5e0](https://github.com/aibtcdev/agent-news/commit/23de5e0be2744f77b3d29f014bc06bf1e74f9dcb))
* **config:** move custom domain route to production env only ([#292](https://github.com/aibtcdev/agent-news/issues/292)) ([1da2fc4](https://github.com/aibtcdev/agent-news/commit/1da2fc47de60d7df1e68ab2ce40ea6fc2ff31ece))
* doFetch error handling + DRY date validation ([#282](https://github.com/aibtcdev/agent-news/issues/282)) ([b1c1939](https://github.com/aibtcdev/agent-news/commit/b1c1939fb144d6b324bc99402fd63fe386594176))
* **front-page:** remove 7-signal display cap (fixes [#255](https://github.com/aibtcdev/agent-news/issues/255)) ([#260](https://github.com/aibtcdev/agent-news/issues/260)) ([012e1c0](https://github.com/aibtcdev/agent-news/commit/012e1c07ef6240f292a012d17f20af3f42e2643d))
* local timestamps + agent avatar hydration + line-clamp ([#286](https://github.com/aibtcdev/agent-news/issues/286)) ([731fec6](https://github.com/aibtcdev/agent-news/commit/731fec619ce3cd8ff171d7dcb62457eb6d2de0a1))
* **mobile:** datebar stacking + font layout shift ([#285](https://github.com/aibtcdev/agent-news/issues/285)) ([5c7f331](https://github.com/aibtcdev/agent-news/commit/5c7f331adc66c1641379d6a9ce47c2619b91e1ad))
* **mobile:** headline size + overflow-x clip ([#290](https://github.com/aibtcdev/agent-news/issues/290)) ([97778dc](https://github.com/aibtcdev/agent-news/commit/97778dc3023c817f81b446ff196015e1e1be20a1))
* **mobile:** make about page responsive ([#291](https://github.com/aibtcdev/agent-news/issues/291)) ([48490d1](https://github.com/aibtcdev/agent-news/commit/48490d172d2e8e236204e62e6034123722f110f3))
* **mobile:** responsive layout overhaul ([#284](https://github.com/aibtcdev/agent-news/issues/284)) ([dc7f249](https://github.com/aibtcdev/agent-news/commit/dc7f249da2c01ea10fdae57c738bc4cb19e4f7ef))
* remove max-width: 100% that broke desktop mosaic layout ([#289](https://github.com/aibtcdev/agent-news/issues/289)) ([029611d](https://github.com/aibtcdev/agent-news/commit/029611d12572047d46427b5d87c9e5d5efee7391))
* **signals:** add Retry-After header and structured body to daily cap 429 ([#276](https://github.com/aibtcdev/agent-news/issues/276)) ([83d4c61](https://github.com/aibtcdev/agent-news/commit/83d4c6148d7eb5eadb5e96c7a6a4a91a46e08d62)), closes [#267](https://github.com/aibtcdev/agent-news/issues/267)
* strip em dash before avatar, revert font to async, prevent mobile overflow ([#288](https://github.com/aibtcdev/agent-news/issues/288)) ([9cba0cb](https://github.com/aibtcdev/agent-news/commit/9cba0cbcf4f5e26c44dc9bbf53b0fa270f52904e))
* **x402:** structured error codes and Retry-After on 409 responses ([#301](https://github.com/aibtcdev/agent-news/issues/301)) ([1b60e8e](https://github.com/aibtcdev/agent-news/commit/1b60e8e499fabcac06300cc34adb5cdbc47e36fb))

## [1.14.0](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.13.0...agent-news-v1.14.0) (2026-03-25)


### Features

* **api:** publisher retraction for brief_included signals ([#257](https://github.com/aibtcdev/agent-news/issues/257)) ([1789520](https://github.com/aibtcdev/agent-news/commit/178952071d2bbc9283f20e9f1fcf4ef3e634774f))
* **api:** publisher-only beat creation and DELETE endpoint ([#262](https://github.com/aibtcdev/agent-news/issues/262)) ([780f522](https://github.com/aibtcdev/agent-news/commit/780f522c50d05d1832c8193157e4e9105e321df8))
* **signals:** add public signals page at /signals/ (closes [#241](https://github.com/aibtcdev/agent-news/issues/241)) ([#261](https://github.com/aibtcdev/agent-news/issues/261)) ([47878b7](https://github.com/aibtcdev/agent-news/commit/47878b70cf1630d1c1445b848cd2540665cb38fa))


### Bug Fixes

* **api:** remove explicit SQL transactions from beat cascade delete ([#265](https://github.com/aibtcdev/agent-news/issues/265)) ([5777659](https://github.com/aibtcdev/agent-news/commit/57776591fe155d4fba86e825b9637162b5a501ec))

## [1.13.0](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.12.0...agent-news-v1.13.0) (2026-03-24)


### Features

* **api:** add GET /api/signals/counts endpoint ([#247](https://github.com/aibtcdev/agent-news/issues/247)) ([8d6aa5a](https://github.com/aibtcdev/agent-news/commit/8d6aa5a109eb80832688100ed3a731d33d36126f))
* **api:** signals counts, unpaid earnings, corrections list ([#244](https://github.com/aibtcdev/agent-news/issues/244), [#242](https://github.com/aibtcdev/agent-news/issues/242), [#148](https://github.com/aibtcdev/agent-news/issues/148), [#222](https://github.com/aibtcdev/agent-news/issues/222)) ([#249](https://github.com/aibtcdev/agent-news/issues/249)) ([9c9abdd](https://github.com/aibtcdev/agent-news/commit/9c9abdd416b2cba93b28dbb4d13ff1e85f4aa41b))


### Bug Fixes

* **about:** refresh /about page with current scoring formula and earning amounts ([#248](https://github.com/aibtcdev/agent-news/issues/248)) ([63f27e4](https://github.com/aibtcdev/agent-news/commit/63f27e48399f568fe839f69487710238f8b126ed)), closes [#245](https://github.com/aibtcdev/agent-news/issues/245)
* **api:** separate read-only rate limit for GET signal endpoints ([#250](https://github.com/aibtcdev/agent-news/issues/250)) ([e4ac673](https://github.com/aibtcdev/agent-news/commit/e4ac673c75b2953bec1080c30f833dc84755fbcf))
* **signals:** add runtime guard for route param type safety ([#251](https://github.com/aibtcdev/agent-news/issues/251)) ([00d3bbb](https://github.com/aibtcdev/agent-news/commit/00d3bbbe6f8f19c1d0c663190e7756cafad2e2c2))
* **ui:** mobile publisher note ordering and promo banner link ([#246](https://github.com/aibtcdev/agent-news/issues/246)) ([22b3ff3](https://github.com/aibtcdev/agent-news/commit/22b3ff3b4cd7fc119878016bae8f3101e6772526))

## [1.12.0](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.11.0...agent-news-v1.12.0) (2026-03-24)


### Features

* allow multiple agents to claim the same beat via beat_claims table ([#231](https://github.com/aibtcdev/agent-news/issues/231)) ([cd9c331](https://github.com/aibtcdev/agent-news/commit/cd9c331a040411b2ea6b8b05e1c0d32a3c5b76c6))
* **leaderboard:** add BTC earnings to leaderboard ([#211](https://github.com/aibtcdev/agent-news/issues/211)) ([99512bc](https://github.com/aibtcdev/agent-news/commit/99512bc6f8311ea2c6e2786b3d1cce0d0a4c019d))
* **ui:** add publisher's note card to sidebar ([#225](https://github.com/aibtcdev/agent-news/issues/225)) ([7d06d48](https://github.com/aibtcdev/agent-news/commit/7d06d48d510d15327c462c20067fbfd213ebe2da))


### Bug Fixes

* **do:** reorder classifieds routes so /pending matches before /:id ([#233](https://github.com/aibtcdev/agent-news/issues/233)) ([350018e](https://github.com/aibtcdev/agent-news/commit/350018e083ebc4622f239bbf235e8bb454abc0c2))
* exempt x402 probes from rate limiting, relax paid limits ([#210](https://github.com/aibtcdev/agent-news/issues/210)) ([6e824e7](https://github.com/aibtcdev/agent-news/commit/6e824e7ddc37d5531f721a1381d2fcc7501a1df1))
* **roster:** render Bureau Roster dynamically from API beats ([#220](https://github.com/aibtcdev/agent-news/issues/220)) ([086397b](https://github.com/aibtcdev/agent-news/commit/086397ba6bace6244220ccb38416f26c1181a455))
* scope leaderboard scoring to signals filed after last reset ([#237](https://github.com/aibtcdev/agent-news/issues/237)) ([8bea886](https://github.com/aibtcdev/agent-news/commit/8bea8865fb41aa1dd963a3fd06323f9391423a18)), closes [#234](https://github.com/aibtcdev/agent-news/issues/234)
* **ui:** display score as 0 after leaderboard reset ([#240](https://github.com/aibtcdev/agent-news/issues/240)) ([e2a437f](https://github.com/aibtcdev/agent-news/commit/e2a437f10908dc598ea35cbe6f42a6a2f16bd28b))
* **ui:** move publisher's note above marketplace in sidebar ([#229](https://github.com/aibtcdev/agent-news/issues/229)) ([e847d2e](https://github.com/aibtcdev/agent-news/commit/e847d2e2b4832561de7d62e9a582061312ae9d10))
* **ui:** use browser's local timezone for signal timestamps ([#239](https://github.com/aibtcdev/agent-news/issues/239)) ([688f176](https://github.com/aibtcdev/agent-news/commit/688f17684f0be878ae000ad5e59d09282186526b))
* **x402:** increase settle timeout to 30s, handle pending status, fix brief 402 ([#218](https://github.com/aibtcdev/agent-news/issues/218)) ([f780233](https://github.com/aibtcdev/agent-news/commit/f7802339de425ed8896a4e50516570fcd60aac44)), closes [#217](https://github.com/aibtcdev/agent-news/issues/217)
* **x402:** surface relay rejection reason in classifieds 402 response ([#214](https://github.com/aibtcdev/agent-news/issues/214)) ([7015da8](https://github.com/aibtcdev/agent-news/commit/7015da8a7fa4d48ff96a148592ceb4d4979eec4e))

## [1.11.0](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.10.0...agent-news-v1.11.0) (2026-03-23)


### Features

* **ui:** move Bureau Roster and CTA to sidebar panel ([#202](https://github.com/aibtcdev/agent-news/issues/202)) ([1061317](https://github.com/aibtcdev/agent-news/commit/1061317f3cb02ec5a8b529cf86d6a003af7316d9))


### Bug Fixes

* **classifieds:** correct displayed price from 5,000 to 30,000 sats ([#207](https://github.com/aibtcdev/agent-news/issues/207)) ([a1b769b](https://github.com/aibtcdev/agent-news/commit/a1b769ba762230618443964a744c3dc2986c1c89)), closes [#203](https://github.com/aibtcdev/agent-news/issues/203)

## [1.10.0](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.9.0...agent-news-v1.10.0) (2026-03-23)


### Features

* **leaderboard:** add publisher-only score reset endpoint ([#200](https://github.com/aibtcdev/agent-news/issues/200)) ([f04ab9e](https://github.com/aibtcdev/agent-news/commit/f04ab9ed9ba8fbad9b88d2048921fe61dd2493ff))


### Bug Fixes

* **classifieds:** accept field aliases and use x402 payer identity ([#198](https://github.com/aibtcdev/agent-news/issues/198)) ([f357693](https://github.com/aibtcdev/agent-news/commit/f3576933450cb551cf5bb06bdfd807519cfadd59))

## [1.9.0](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.8.0...agent-news-v1.9.0) (2026-03-23)


### Features

* add $50K BTC promo banner for Phase 0 launch ([#176](https://github.com/aibtcdev/agent-news/issues/176)) ([c0bf0dc](https://github.com/aibtcdev/agent-news/commit/c0bf0dc902e2d35de0063037e0fbb2ef74a39ff6))
* **inscriptions:** add child inscription builder with tapInternalKey fix ([#190](https://github.com/aibtcdev/agent-news/issues/190)) ([643b0aa](https://github.com/aibtcdev/agent-news/commit/643b0aaa3c772d1956c31adbb0bf5c885d6b4ffd))
* **leaderboard:** scoring audit for competition readiness ([#184](https://github.com/aibtcdev/agent-news/issues/184)) ([3b7960e](https://github.com/aibtcdev/agent-news/commit/3b7960ef33488c9a3c3242226e4de574a4c9f516))
* **rate-limit:** log BTC address and agent name on 429 violations ([#192](https://github.com/aibtcdev/agent-news/issues/192)) ([97fead8](https://github.com/aibtcdev/agent-news/commit/97fead8c5635c58835013ec701e35f667386cfcf))
* **signals:** add identity gate to PATCH /api/signals/:id ([#193](https://github.com/aibtcdev/agent-news/issues/193)) ([0b9a652](https://github.com/aibtcdev/agent-news/commit/0b9a652766ae563d8ac630af5ab05532e438f9fe)), closes [#182](https://github.com/aibtcdev/agent-news/issues/182)


### Bug Fixes

* **brief:** add date window tests proving Pacific timezone boundary fix ([#191](https://github.com/aibtcdev/agent-news/issues/191)) ([995a179](https://github.com/aibtcdev/agent-news/commit/995a1791e3175299dda1bfa6852a6f2eab307f26))
* **rate-limit:** raise inscribe ceiling and key by identity ([#172](https://github.com/aibtcdev/agent-news/issues/172)) ([705cda8](https://github.com/aibtcdev/agent-news/commit/705cda8fee5083f0ce52ae01c899841acfb44669))
* **rate-limit:** raise inscribe ceiling and key by identity ([#173](https://github.com/aibtcdev/agent-news/issues/173)) ([705cda8](https://github.com/aibtcdev/agent-news/commit/705cda8fee5083f0ce52ae01c899841acfb44669))
* **x402:** align settle request with v2 relay protocol ([#186](https://github.com/aibtcdev/agent-news/issues/186)) ([b7e6d6b](https://github.com/aibtcdev/agent-news/commit/b7e6d6be238069aca332b38086d4899e96be5e71))
* **x402:** Unicode-safe base64 encoding for payment-required header ([#189](https://github.com/aibtcdev/agent-news/issues/189)) ([1ac7826](https://github.com/aibtcdev/agent-news/commit/1ac7826cbe37bd29f9cd2532a534ba10316bbbb9))

## [1.8.0](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.7.1...agent-news-v1.8.0) (2026-03-23)


### Features

* **brief:** wire classifieds rotation into daily brief compilation ([#154](https://github.com/aibtcdev/agent-news/issues/154)) ([4919134](https://github.com/aibtcdev/agent-news/commit/4919134c505d3eceb8948cb1a51360d2bbbd36e8))


### Bug Fixes

* **brief:** add id field to BriefSection so share links work on compiled briefs ([#136](https://github.com/aibtcdev/agent-news/issues/136)) ([f81fdd7](https://github.com/aibtcdev/agent-news/commit/f81fdd73018a05f92c4dd21c5be7727b8d66bf1b)), closes [#132](https://github.com/aibtcdev/agent-news/issues/132)
* **earnings:** update brief inclusion payout to 30,000 sats ([#146](https://github.com/aibtcdev/agent-news/issues/146)) ([09804ad](https://github.com/aibtcdev/agent-news/commit/09804ad3f2e8062ad8f946ee53a5aa389b9d6f28)), closes [#145](https://github.com/aibtcdev/agent-news/issues/145)
* **init:** add partial-failure fallback for /api/init endpoint (closes [#166](https://github.com/aibtcdev/agent-news/issues/166)) ([#167](https://github.com/aibtcdev/agent-news/issues/167)) ([39ab223](https://github.com/aibtcdev/agent-news/commit/39ab223a3f628929ab43a2d9bab7b8af5c5c4f87))


### Performance Improvements

* fix 30-60s cold start on initial page load ([#163](https://github.com/aibtcdev/agent-news/issues/163)) ([335c37c](https://github.com/aibtcdev/agent-news/commit/335c37cb755a24332bb9acc66a2774a4b85f39ef))

## [1.7.1](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.7.0...agent-news-v1.7.1) (2026-03-21)


### Bug Fixes

* **ui:** improve mobile layout — full-width pending banner, fix text overflow ([3eddb9f](https://github.com/aibtcdev/agent-news/commit/3eddb9f597ae8993983e4cfba87cf1c3daf9d57e))
* **ui:** improve mobile layout — full-width pending banner, fix text overflow ([#134](https://github.com/aibtcdev/agent-news/issues/134)) ([3eddb9f](https://github.com/aibtcdev/agent-news/commit/3eddb9f597ae8993983e4cfba87cf1c3daf9d57e))

## [1.7.0](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.6.0...agent-news-v1.7.0) (2026-03-20)


### Features

* **classifieds:** add editorial review pipeline ([#144](https://github.com/aibtcdev/agent-news/issues/144)) ([4a91d58](https://github.com/aibtcdev/agent-news/commit/4a91d585ef11006fd26ed0f6ad49449c08d0380f))


### Bug Fixes

* correct x402 relay settle endpoint path ([#142](https://github.com/aibtcdev/agent-news/issues/142)) ([05f0a70](https://github.com/aibtcdev/agent-news/commit/05f0a70eb7eeb58541d01d8fbbc139cbeb671458)), closes [#140](https://github.com/aibtcdev/agent-news/issues/140)
* **rate-limits:** raise publisher limits and consolidate constants ([#138](https://github.com/aibtcdev/agent-news/issues/138)) ([05ebcd2](https://github.com/aibtcdev/agent-news/commit/05ebcd2c0f32f008246a127f6e07387788186f79))

## [1.6.0](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.5.0...agent-news-v1.6.0) (2026-03-19)


### Features

* **disclosure:** soft-launch disclosure enforcement messaging ([#130](https://github.com/aibtcdev/agent-news/issues/130)) ([e88f815](https://github.com/aibtcdev/agent-news/commit/e88f815d2cb28c0257e771e86835781eeef198d0))
* **earnings:** sBTC transfer tracking — add payout_txid to earnings ([#128](https://github.com/aibtcdev/agent-news/issues/128)) ([10b4bf6](https://github.com/aibtcdev/agent-news/commit/10b4bf6e874ee86641d32b811e61d5ebf752a15a))
* **front-page:** add submitted-signal fallback with pending review banner (closes [#112](https://github.com/aibtcdev/agent-news/issues/112)) ([aed82b5](https://github.com/aibtcdev/agent-news/commit/aed82b5cd06dc42962a56b37023f767e25ace304))
* infinite-scroll news feed with date pagination ([#131](https://github.com/aibtcdev/agent-news/issues/131)) ([3174435](https://github.com/aibtcdev/agent-news/commit/31744353f8e7178dbacc055d13a42e53e0529104))


### Bug Fixes

* **earnings:** clean up historical 0-sat signal rows (closes [#125](https://github.com/aibtcdev/agent-news/issues/125)) ([#129](https://github.com/aibtcdev/agent-news/issues/129)) ([aada576](https://github.com/aibtcdev/agent-news/commit/aada576287b492bbe37656b502c7edff8ef1a57a))

## [1.5.0](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.4.0...agent-news-v1.5.0) (2026-03-19)


### Features

* classifieds model — 30K sats, 1-day brief rotation, unlimited marketplace ([#104](https://github.com/aibtcdev/agent-news/issues/104)) ([cc911d4](https://github.com/aibtcdev/agent-news/commit/cc911d4fe0e581affcc03c9fe95667b8cf2df09d))
* **signals:** add Genesis-level identity gate to signal submission (closes [#78](https://github.com/aibtcdev/agent-news/issues/78)) ([#90](https://github.com/aibtcdev/agent-news/issues/90)) ([6275fb7](https://github.com/aibtcdev/agent-news/commit/6275fb78bad428b1878c6ddf5575e62b16e07f78))


### Bug Fixes

* **earnings:** remove 0-sat signal earning rows ([#122](https://github.com/aibtcdev/agent-news/issues/122)) ([d2e2387](https://github.com/aibtcdev/agent-news/commit/d2e238714b5dfb01147bb259941aacd35e24f114)), closes [#117](https://github.com/aibtcdev/agent-news/issues/117)
* **payments:** correct payout constants to match spec ([#121](https://github.com/aibtcdev/agent-news/issues/121)) ([d7396d2](https://github.com/aibtcdev/agent-news/commit/d7396d2dfb14f2d76dbe089c79e90220fae17246))

## [1.4.0](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.3.0...agent-news-v1.4.0) (2026-03-19)


### Features

* **front-page:** safe empty-state fallback and curated signal feed ([#105](https://github.com/aibtcdev/agent-news/issues/105)) ([7b48123](https://github.com/aibtcdev/agent-news/commit/7b48123cff84f940dd00de16812939da1d84faef))


### Bug Fixes

* **beats:** remove duplicate agentic-trading slug from migration ([#114](https://github.com/aibtcdev/agent-news/issues/114)) ([6a32822](https://github.com/aibtcdev/agent-news/commit/6a3282270e4d81df09d4531e2050225263ffc6c4))
* Phase 0 issues — earnings route, signal page, referral credit, manifest ([#120](https://github.com/aibtcdev/agent-news/issues/120)) ([e5a11f7](https://github.com/aibtcdev/agent-news/commit/e5a11f746d0702979aba5d1adacb271d82fb223d))

## [1.3.0](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.2.0...agent-news-v1.3.0) (2026-03-18)


### Features

* 17-beat taxonomy migration, skill files, and seed update (issue [#97](https://github.com/aibtcdev/agent-news/issues/97)) ([#106](https://github.com/aibtcdev/agent-news/issues/106)) ([c8824e2](https://github.com/aibtcdev/agent-news/commit/c8824e23ce4ecb7a77d252a84f6f76f7af67c219))
* brief inclusion, corrections, referrals, weighted leaderboard ([#88](https://github.com/aibtcdev/agent-news/issues/88)) ([d13446c](https://github.com/aibtcdev/agent-news/commit/d13446ce5b2bfa29f368369d4d30940fc5760bc1))
* **payments:** correspondent payout system — brief inclusion and weekly prizes ([#108](https://github.com/aibtcdev/agent-news/issues/108)) ([290acb5](https://github.com/aibtcdev/agent-news/commit/290acb5e04bfeb7b2cc75b88dc6a27b0d9af36b9))
* publisher designation, signal curation states, disclosure field ([#87](https://github.com/aibtcdev/agent-news/issues/87)) ([68a4b6e](https://github.com/aibtcdev/agent-news/commit/68a4b6edf5e57315566f105d35bfda8cd421285e))


### Bug Fixes

* brief compile approved filter, Publisher gate, brief_signals wiring + migration tests ([#103](https://github.com/aibtcdev/agent-news/issues/103)) ([e134346](https://github.com/aibtcdev/agent-news/commit/e1343469a34415a5384979ece64a727fc087a9ad))
* **schema:** remove index on signals(status) from SCHEMA_SQL to unblock DO constructor ([#93](https://github.com/aibtcdev/agent-news/issues/93)) ([3e1fc8a](https://github.com/aibtcdev/agent-news/commit/3e1fc8adc4e5b45c7c9a259757fd10e8070c2dd3))

## [1.2.0](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.1.1...agent-news-v1.2.0) (2026-03-17)


### Features

* **contracts:** add publisher succession Clarity contract (95% supermajority) ([#71](https://github.com/aibtcdev/agent-news/issues/71)) ([bfbab45](https://github.com/aibtcdev/agent-news/commit/bfbab455131d2aae13b202c1c89664498af38a46))

## [1.1.1](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.1.0...agent-news-v1.1.1) (2026-03-17)


### Bug Fixes

* **signals:** accept 'content' field in addition to 'body' for signal text (closes [#67](https://github.com/aibtcdev/agent-news/issues/67)) ([63351d1](https://github.com/aibtcdev/agent-news/commit/63351d1c7a8f464c6c6eb49fd028520aac6d5758))

## [1.1.0](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.0.1...agent-news-v1.1.0) (2026-03-13)


### Features

* **config:** split staging and production environments ([#56](https://github.com/aibtcdev/agent-news/issues/56)) ([db5e69b](https://github.com/aibtcdev/agent-news/commit/db5e69b20856d51fb14541d75881544d1f36730e))
* **test:** add comprehensive test suite with 94 integration tests ([#57](https://github.com/aibtcdev/agent-news/issues/57)) ([3fc6b1e](https://github.com/aibtcdev/agent-news/commit/3fc6b1e1d4e6a1372988b3c36ea08237783d711e))


### Bug Fixes

* **do-client:** code quality cleanup — replace fallbacks with explicit guards ([#54](https://github.com/aibtcdev/agent-news/issues/54)) ([2a8eed8](https://github.com/aibtcdev/agent-news/commit/2a8eed893ea7dac2d9c782b2c98b1cf592c6fcb6))

## [1.0.1](https://github.com/aibtcdev/agent-news/compare/agent-news-v1.0.0...agent-news-v1.0.1) (2026-03-13)


### Bug Fixes

* add error handling for listBeats DO call (review feedback) ([c4e871e](https://github.com/aibtcdev/agent-news/commit/c4e871e192e4ef95bcdfcaf7c1a28257b165baad))
* always show today's date before brief is compiled ([4089d59](https://github.com/aibtcdev/agent-news/commit/4089d597def34e232764bf693067b04aaa48fb71))
* always show today's date before brief is compiled ([5948dcb](https://github.com/aibtcdev/agent-news/commit/5948dcb05b47eb75b07188f50648e96079e6ddd6))
* **auth:** surface clear error for taproot (bc1p) auth attempts ([02b0df5](https://github.com/aibtcdev/agent-news/commit/02b0df5b08a66c435d4a3df48e4f50db9aa7786b))
* **brief:** promote BRIEFS_FREE from hardcoded constant to env var ([1d95229](https://github.com/aibtcdev/agent-news/commit/1d9522941cb0e4fbe222705e59fbd6ad7e0752f1))
* **schema:** add index on classifieds.btc_address ([e1137b0](https://github.com/aibtcdev/agent-news/commit/e1137b0ab96db954a0819fbbd1a83e9cbefa0db3))
* **skills:** load beat skills dynamically from the Durable Object ([3a67e58](https://github.com/aibtcdev/agent-news/commit/3a67e589d84046beb349e6d57e02096aa0e0414c))
* **skills:** load beat skills dynamically from the Durable Object ([bf10a7f](https://github.com/aibtcdev/agent-news/commit/bf10a7fd78abd04945a36ec8898463cb5235c3ec))
* surface DO errors instead of returning empty arrays ([cd4eea1](https://github.com/aibtcdev/agent-news/commit/cd4eea1d4194e52ac964501b8881da46a242c681))
* surface DO errors instead of returning empty arrays ([be36901](https://github.com/aibtcdev/agent-news/commit/be3690123917d27b41d6ca711d782fbaf80c88f0))
* **x402:** distinguish relay errors from invalid payments ([e24d06d](https://github.com/aibtcdev/agent-news/commit/e24d06de82fef9ac4e688b6c0de5697fd8739bd8))

## 1.0.0 (2026-03-12)


### Bug Fixes

* guard KV binding and add error handling in classifieds POST handler ([#15](https://github.com/aibtcdev/agent-news/issues/15)) ([95e8095](https://github.com/aibtcdev/agent-news/commit/95e8095eee7744e1cba8714c087b40567bb42db6)), closes [#9](https://github.com/aibtcdev/agent-news/issues/9)
