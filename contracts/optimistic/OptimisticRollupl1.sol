// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title OptimisticRollupL1
 * @notice Contratto L1 per Optimistic Rollup con supporto batch
 * @dev Versione estesa che supporta sia singole submissions che batch dal sequencer
 */
contract OptimisticRollupL1 {

    // ============================================
    // STRUTTURE DATI
    // ============================================

    struct SignatureSubmission {
        bytes32 msgHash;
        bytes signature;
        address claimedSigner;
        uint256 submissionTime;
        bool finalized;
        bool challenged;
        address submitter;
        uint256 batchId;  // 0 se singola, >0 se parte di batch
    }

    struct Batch {
        bytes32 stateRoot;        // Merkle root dello stato L2
        uint256 numTransactions;   // Numero di tx nel batch
        uint256 timestamp;         // Quando è stato proposto
        address proposer;          // Chi ha proposto il batch
        bool finalized;
        bool challenged;
        uint256 l2BlockNumber;     // Numero blocco L2
    }

    // ============================================
    // STORAGE
    // ============================================

    // Submissions individuali (retrocompatibilità)
    mapping(uint256 => SignatureSubmission) public submissions;
    uint256 public submissionCount;

    // Batch proposals
    mapping(uint256 => Batch) public batches;
    uint256 public batchCount;

    // Mapping batch -> submission IDs
    mapping(uint256 => uint256[]) public batchSubmissions;

    // Sequencer autorizzato (per semplicità, uno solo)
    address public sequencer;

    // Parametri del sistema
    uint256 public constant CHALLENGE_PERIOD = 300; // 5 minuti per test
    uint256 public constant BATCH_SIZE_LIMIT = 100; // Max tx per batch

    // Stato L2 tracking
    uint256 public l2BlockNumber;
    bytes32 public currentStateRoot;

    // ============================================
    // EVENTI
    // ============================================

    event SignatureSubmitted(
        uint256 indexed submissionId,
        bytes32 msgHash,
        address claimedSigner,
        address submitter
    );

    event BatchProposed(
        uint256 indexed batchId,
        bytes32 stateRoot,
        uint256 numTransactions,
        uint256 l2BlockNumber,
        address proposer
    );

    event SignatureChallenged(
        uint256 indexed submissionId,
        address challenger,
        address actualSigner,
        address claimedSigner
    );

    event BatchChallenged(
        uint256 indexed batchId,
        uint256 submissionId,
        address challenger
    );

    event SignatureFinalized(
        uint256 indexed submissionId,
        bytes32 msgHash,
        address claimedSigner
    );

    event BatchFinalized(
        uint256 indexed batchId,
        bytes32 stateRoot,
        uint256 l2BlockNumber
    );

    event SequencerUpdated(
        address indexed oldSequencer,
        address indexed newSequencer
    );

    // ============================================
    // MODIFIERS
    // ============================================

    modifier onlySequencer() {
        require(msg.sender == sequencer, "Only sequencer");
        _;
    }

    // ============================================
    // CONSTRUCTOR
    // ============================================

    constructor(address _sequencer) {
        sequencer = _sequencer;
        l2BlockNumber = 0;
        currentStateRoot = bytes32(0);
    }

    // ============================================
    // FUNZIONI PRINCIPALI - SINGLE SUBMISSION
    // ============================================

    /**
     * @notice Sottometti una singola firma (modalità diretta)
     * @dev Mantiene retrocompatibilità con versione base
     */
    function submitSignature(
        bytes32 _msgHash,
        bytes memory _signature,
        address _claimedSigner
    ) external returns (uint256 submissionId) {
        require(_signature.length == 65, "Invalid signature length");
        require(_claimedSigner != address(0), "Invalid signer address");

        submissionId = submissionCount++;

        submissions[submissionId] = SignatureSubmission({
            msgHash: _msgHash,
            signature: _signature,
            claimedSigner: _claimedSigner,
            submissionTime: block.timestamp,
            finalized: false,
            challenged: false,
            submitter: msg.sender,
            batchId: 0  // Non parte di batch
        });

        emit SignatureSubmitted(
            submissionId,
            _msgHash,
            _claimedSigner,
            msg.sender
        );
    }

    // ============================================
    // FUNZIONI BATCH - PROPOSER/SEQUENCER
    // ============================================

    /**
     * @notice Il sequencer propone un batch di transazioni verificate su L2
     * @param _stateRoot Nuovo state root dopo esecuzione batch
     * @param _msgHashes Array di message hash
     * @param _signatures Array di firme
     * @param _claimedSigners Array di indirizzi dichiarati
     */
    function proposeBatch(
        bytes32 _stateRoot,
        bytes32[] calldata _msgHashes,
        bytes[] calldata _signatures,
        address[] calldata _claimedSigners
    ) external onlySequencer returns (uint256 batchId) {
        require(_msgHashes.length == _signatures.length, "Length mismatch");
        require(_msgHashes.length == _claimedSigners.length, "Length mismatch");
        require(_msgHashes.length > 0, "Empty batch");
        require(_msgHashes.length <= BATCH_SIZE_LIMIT, "Batch too large");

        batchId = batchCount++;
        l2BlockNumber++;

        // Crea batch
        batches[batchId] = Batch({
            stateRoot: _stateRoot,
            numTransactions: _msgHashes.length,
            timestamp: block.timestamp,
            proposer: msg.sender,
            finalized: false,
            challenged: false,
            l2BlockNumber: l2BlockNumber
        });

        // Crea submissions individuali per ogni tx nel batch
        uint256[] storage batchSubs = batchSubmissions[batchId];

        for (uint i = 0; i < _msgHashes.length; i++) {
            require(_signatures[i].length == 65, "Invalid signature length");

            uint256 subId = submissionCount++;

            submissions[subId] = SignatureSubmission({
                msgHash: _msgHashes[i],
                signature: _signatures[i],
                claimedSigner: _claimedSigners[i],
                submissionTime: block.timestamp,
                finalized: false,
                challenged: false,
                submitter: msg.sender,
                batchId: batchId
            });

            batchSubs.push(subId);
        }

        emit BatchProposed(
            batchId,
            _stateRoot,
            _msgHashes.length,
            l2BlockNumber,
            msg.sender
        );
    }

    // ============================================
    // CHALLENGE FUNCTIONS
    // ============================================

    /**
     * @notice Contesta una singola submission (anche dentro batch)
     */
    function challengeSignature(uint256 _submissionId) external {
        SignatureSubmission storage sub = submissions[_submissionId];

        require(!sub.finalized, "Already finalized");
        require(!sub.challenged, "Already challenged");
        require(
            block.timestamp <= sub.submissionTime + CHALLENGE_PERIOD,
            "Challenge period expired"
        );

        // Verifica firma on-chain
        address recovered = recoverSigner(sub.msgHash, sub.signature);

        require(
            recovered != sub.claimedSigner,
            "Signature valid - challenge failed"
        );

        // Marca come challenged
        sub.challenged = true;

        // Se parte di batch, marca anche il batch
        if (sub.batchId > 0) {
            batches[sub.batchId].challenged = true;

            emit BatchChallenged(
                sub.batchId,
                _submissionId,
                msg.sender
            );
        }

        emit SignatureChallenged(
            _submissionId,
            msg.sender,
            recovered,
            sub.claimedSigner
        );

        // In un sistema reale: penalizza proposer, premia challenger
    }

    // ============================================
    // FINALIZATION
    // ============================================

    /**
     * @notice Finalizza una singola submission
     */
    function finalizeSignature(uint256 _submissionId) external {
        SignatureSubmission storage sub = submissions[_submissionId];

        require(!sub.finalized, "Already finalized");
        require(!sub.challenged, "Submission was challenged");
        require(
            block.timestamp > sub.submissionTime + CHALLENGE_PERIOD,
            "Challenge period not expired"
        );

        sub.finalized = true;

        emit SignatureFinalized(
            _submissionId,
            sub.msgHash,
            sub.claimedSigner
        );
    }

    /**
     * @notice Finalizza un intero batch
     * @dev Tutte le submissions nel batch devono essere non-challenged
     */
    function finalizeBatch(uint256 _batchId) external {
        Batch storage batch = batches[_batchId];

        require(!batch.finalized, "Already finalized");
        require(!batch.challenged, "Batch was challenged");
        require(
            block.timestamp > batch.timestamp + CHALLENGE_PERIOD,
            "Challenge period not expired"
        );

        // Verifica che nessuna submission nel batch sia challenged
        uint256[] memory subs = batchSubmissions[_batchId];
        for (uint i = 0; i < subs.length; i++) {
            require(!submissions[subs[i]].challenged, "Contains challenged tx");
            submissions[subs[i]].finalized = true;
        }

        // Finalizza batch
        batch.finalized = true;
        currentStateRoot = batch.stateRoot;

        emit BatchFinalized(
            _batchId,
            batch.stateRoot,
            batch.l2BlockNumber
        );
    }

    // ============================================
    // UTILITY FUNCTIONS
    // ============================================

    function recoverSigner(
        bytes32 _msgHash,
        bytes memory _signature
    ) public pure returns (address) {
        require(_signature.length == 65, "Invalid signature length");

        bytes32 r;
        bytes32 s;
        uint8 v;

        assembly {
            r := mload(add(_signature, 32))
            s := mload(add(_signature, 64))
            v := byte(0, mload(add(_signature, 96)))
        }

        return ecrecover(_msgHash, v, r, s);
    }

    // ============================================
    // VIEW FUNCTIONS
    // ============================================

    function getBatchSubmissions(uint256 _batchId)
    external
    view
    returns (uint256[] memory)
    {
        return batchSubmissions[_batchId];
    }

    function getRemainingChallengeTime(uint256 _submissionId)
    external
    view
    returns (uint256)
    {
        SignatureSubmission storage sub = submissions[_submissionId];

        if (sub.finalized || sub.challenged) {
            return 0;
        }

        uint256 deadline = sub.submissionTime + CHALLENGE_PERIOD;

        if (block.timestamp >= deadline) {
            return 0;
        }

        return deadline - block.timestamp;
    }

    function getBatchRemainingChallengeTime(uint256 _batchId)
    external
    view
    returns (uint256)
    {
        Batch storage batch = batches[_batchId];

        if (batch.finalized || batch.challenged) {
            return 0;
        }

        uint256 deadline = batch.timestamp + CHALLENGE_PERIOD;

        if (block.timestamp >= deadline) {
            return 0;
        }

        return deadline - block.timestamp;
    }

    // ============================================
    // ADMIN FUNCTIONS
    // ============================================

    function updateSequencer(address _newSequencer) external {
        require(msg.sender == sequencer, "Only current sequencer");
        require(_newSequencer != address(0), "Invalid address");

        address oldSequencer = sequencer;
        sequencer = _newSequencer;

        emit SequencerUpdated(oldSequencer, _newSequencer);
    }
}