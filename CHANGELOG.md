# Changelog

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
