;; publisher-succession.clar
;;
;; Immutable publisher succession contract for AIBTC News DAO.
;; Inspired by Arthur Hayes' Poet DAO governance model.
;;
;; Rules:
;; - The publisher has full control over the DAO (off-chain treasury, operations).
;; - The ONLY on-chain governance action is replacing the publisher.
;; - Requires 95% supermajority of eligible voters to pass.
;; - The 95% threshold is a constant — no function can change it.
;; - One agent = one vote (not proportional to sBTC holdings).
;;
;; Voter eligibility:
;; - Must own an ERC-8004 agent identity NFT
;; - Must hold > 0 sBTC at time of voting
;;
;; Proposal lifecycle:
;; 1. Any eligible voter proposes a new publisher (propose-succession)
;; 2. Voting window opens for VOTE_WINDOW blocks (~3 days)
;; 3. Eligible voters cast for/against (vote)
;; 4. After window closes, anyone can finalize (finalize)
;; 5. If yes-votes >= 95% of total votes AND quorum met, publisher changes
;;
;; IMMUTABLE: This contract has no admin functions, no upgrade path,
;; and no way to modify the threshold. Deploy once, runs forever.

;; ─── External contract references ───

;; Future: ERC-8004 identity check via SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2
;; Blocked by lack of reverse lookup in registry. Off-chain voter registry verifies ERC-8004 ownership.

;; sBTC token — voters must hold a balance > 0
(define-constant SBTC_CONTRACT 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)

;; ─── Immutable governance parameters ───

(define-constant SUPERMAJORITY_THRESHOLD u95)  ;; 95% yes-votes required
(define-constant VOTE_WINDOW u432)             ;; ~3 days at 10-min blocks
(define-constant MIN_QUORUM u3)                ;; minimum votes to finalize
(define-constant PROPOSAL_COOLDOWN u1008)      ;; ~7 days between proposals

;; ─── Error codes ───

(define-constant ERR_NOT_ELIGIBLE (err u1000))
(define-constant ERR_PROPOSAL_ACTIVE (err u1001))
(define-constant ERR_NO_PROPOSAL (err u1002))
(define-constant ERR_ALREADY_VOTED (err u1003))
(define-constant ERR_VOTING_CLOSED (err u1004))
(define-constant ERR_VOTING_OPEN (err u1005))
(define-constant ERR_THRESHOLD_NOT_MET (err u1006))
(define-constant ERR_QUORUM_NOT_MET (err u1007))
(define-constant ERR_COOLDOWN_ACTIVE (err u1008))
(define-constant ERR_SELF_PROPOSAL (err u1009))
(define-constant ERR_USE_FINALIZE (err u1010))

;; ─── State ───

(define-data-var publisher principal tx-sender)  ;; deployer is initial publisher
(define-data-var proposal-id uint u0)

;; Current proposal (if any)
(define-data-var proposal-candidate (optional principal) none)
(define-data-var proposal-proposer (optional principal) none)
(define-data-var proposal-start-block uint u0)
(define-data-var proposal-yes uint u0)
(define-data-var proposal-no uint u0)
(define-data-var last-proposal-end uint u0)

;; Track who has voted on current proposal
(define-map votes { proposal-id: uint, voter: principal } bool)

;; ─── Read-only functions ───

(define-read-only (get-publisher)
  (var-get publisher)
)

(define-read-only (get-threshold)
  SUPERMAJORITY_THRESHOLD
)

(define-read-only (get-proposal)
  {
    id: (var-get proposal-id),
    candidate: (var-get proposal-candidate),
    proposer: (var-get proposal-proposer),
    start-block: (var-get proposal-start-block),
    end-block: (+ (var-get proposal-start-block) VOTE_WINDOW),
    yes-votes: (var-get proposal-yes),
    no-votes: (var-get proposal-no),
    active: (is-some (var-get proposal-candidate))
  }
)

(define-read-only (has-voted (voter principal))
  (default-to false (map-get? votes { proposal-id: (var-get proposal-id), voter: voter }))
)

(define-read-only (is-eligible (agent principal))
  (let
    (
      ;; Check if agent owns an ERC-8004 identity
      ;; We check if they are the owner of any agent-id by trying a read-only lookup
      ;; Since we can't enumerate, we check sBTC balance as primary gate
      (sbtc-balance (unwrap! (contract-call? SBTC_CONTRACT get-balance agent) false))
    )
    (> sbtc-balance u0)
  )
)

;; ─── Public functions ───

;; Propose a new publisher. Caller must be eligible.
(define-public (propose-succession (candidate principal))
  (let
    (
      (caller tx-sender)
      (current-block block-height)
    )
    ;; Caller must be eligible (holds sBTC)
    (asserts! (is-eligible caller) ERR_NOT_ELIGIBLE)

    ;; Cannot propose yourself as publisher — prevents self-dealing
    ;; (the current publisher can be proposed by someone else)
    ;; Note: candidate sBTC-holding is intentionally NOT checked. sBTC is a voter
    ;; eligibility gate, not a publisher prerequisite. The publisher role is off-chain
    ;; operational control — any principal can hold it.
    (asserts! (not (is-eq candidate caller)) ERR_SELF_PROPOSAL)

    ;; No active proposal
    (asserts! (is-none (var-get proposal-candidate)) ERR_PROPOSAL_ACTIVE)

    ;; Cooldown since last proposal ended
    (asserts! (>= current-block (+ (var-get last-proposal-end) PROPOSAL_COOLDOWN)) ERR_COOLDOWN_ACTIVE)

    ;; Create proposal
    (var-set proposal-id (+ (var-get proposal-id) u1))
    (var-set proposal-candidate (some candidate))
    (var-set proposal-proposer (some caller))
    (var-set proposal-start-block current-block)
    (var-set proposal-yes u0)
    (var-set proposal-no u0)

    (print {
      event: "proposal-created",
      proposal-id: (var-get proposal-id),
      candidate: candidate,
      proposer: caller,
      start-block: current-block
    })

    (ok (var-get proposal-id))
  )
)

;; Cast a vote. Caller must be eligible and not have voted on this proposal.
(define-public (vote (support bool))
  (let
    (
      (caller tx-sender)
      (current-block block-height)
      (pid (var-get proposal-id))
      (start (var-get proposal-start-block))
    )
    ;; Must have an active proposal
    (asserts! (is-some (var-get proposal-candidate)) ERR_NO_PROPOSAL)

    ;; Must be within voting window
    (asserts! (<= current-block (+ start VOTE_WINDOW)) ERR_VOTING_CLOSED)

    ;; Caller must be eligible
    (asserts! (is-eligible caller) ERR_NOT_ELIGIBLE)

    ;; Must not have already voted
    (asserts! (not (has-voted caller)) ERR_ALREADY_VOTED)

    ;; Record vote
    (map-set votes { proposal-id: pid, voter: caller } true)

    (if support
      (var-set proposal-yes (+ (var-get proposal-yes) u1))
      (var-set proposal-no (+ (var-get proposal-no) u1))
    )

    (ok support)
  )
)

;; Finalize a proposal after the voting window closes.
;; Anyone can call this — it just reads the tallies.
(define-public (finalize)
  (let
    (
      (current-block block-height)
      (start (var-get proposal-start-block))
      (candidate (unwrap! (var-get proposal-candidate) ERR_NO_PROPOSAL))
      (yes (var-get proposal-yes))
      (no (var-get proposal-no))
      (total (+ yes no))
    )
    ;; Voting window must be closed
    (asserts! (> current-block (+ start VOTE_WINDOW)) ERR_VOTING_OPEN)

    ;; Quorum check
    (asserts! (>= total MIN_QUORUM) ERR_QUORUM_NOT_MET)

    ;; 95% threshold: yes * 100 >= total * 95
    ;; Using multiplication to avoid integer division rounding
    (asserts! (>= (* yes u100) (* total SUPERMAJORITY_THRESHOLD)) ERR_THRESHOLD_NOT_MET)

    ;; Threshold met — capture previous publisher before change
    (let ((previous-publisher (var-get publisher)))

      ;; Transfer publisher role
      (var-set publisher candidate)

      ;; Clean up proposal state
      (var-set proposal-candidate none)
      (var-set proposal-proposer none)
      (var-set proposal-yes u0)
      (var-set proposal-no u0)
      (var-set proposal-start-block u0)
      (var-set last-proposal-end current-block)

      (print {
        event: "publisher-changed",
        previous-publisher: previous-publisher,
        new-publisher: candidate,
        proposal-id: (var-get proposal-id),
        yes-votes: yes,
        no-votes: no,
        block: current-block
      })

      (ok candidate)
    )
  )
)

;; Cancel a proposal that failed (didn't meet threshold).
;; Anyone can call after voting window closes.
(define-public (cancel-failed)
  (let
    (
      (current-block block-height)
      (start (var-get proposal-start-block))
      (yes (var-get proposal-yes))
      (no (var-get proposal-no))
      (total (+ yes no))
    )
    ;; Must have an active proposal
    (asserts! (is-some (var-get proposal-candidate)) ERR_NO_PROPOSAL)

    ;; Voting window must be closed
    (asserts! (> current-block (+ start VOTE_WINDOW)) ERR_VOTING_OPEN)

    ;; Either quorum not met OR threshold not met
    ;; (if both are met, use finalize instead — ERR_USE_FINALIZE guides callers)
    (asserts!
      (or
        (< total MIN_QUORUM)
        (< (* yes u100) (* total SUPERMAJORITY_THRESHOLD))
      )
      ERR_USE_FINALIZE
    )

    ;; Clean up
    (var-set proposal-candidate none)
    (var-set proposal-proposer none)
    (var-set proposal-yes u0)
    (var-set proposal-no u0)
    (var-set proposal-start-block u0)
    (var-set last-proposal-end current-block)

    (ok true)
  )
)
