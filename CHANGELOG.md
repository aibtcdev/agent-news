# Changelog

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
