// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title OptimisticSignatureVerifier
 * @notice Implementa un sistema ottimistico per la verifica di firme ECDSA
 * @dev Le firme vengono accettate per default e possono essere contestate durante la challenge window
 */
contract OptimisticSignatureVerifier {

    // Struttura per memorizzare una sottomissione di firma
    struct SignatureSubmission {
        bytes32 msgHash;           // Hash del messaggio firmato
        bytes signature;           // Firma ECDSA (r, s, v)
        address claimedSigner;     // Indirizzo dichiarato del firmatario
        uint256 submissionTime;    // Timestamp della sottomissione
        bool finalized;            // Se true, la finestra di challenge è scaduta
        bool challenged;           // Se true, è stata contestata
        address submitter;         // Chi ha sottomesso la firma
    }

    // Mapping: ID sottomissione => dati della sottomissione
    mapping(uint256 => SignatureSubmission) public submissions;

    // Contatore per gli ID delle sottomissioni
    uint256 public submissionCount;

    // Durata della challenge window (in secondi)
    uint256 public constant CHALLENGE_PERIOD = 300; // 5 minuti per test (in produzione: 7 giorni)

    // Reward per chi trova una frode
    uint256 public constant CHALLENGE_REWARD = 0.1 ether;

    // Eventi
    event SignatureSubmitted(
        uint256 indexed submissionId,
        bytes32 msgHash,
        address claimedSigner,
        address submitter
    );

    event SignatureChallenged(
        uint256 indexed submissionId,
        address challenger,
        address actualSigner,
        address claimedSigner
    );

    event SignatureFinalized(
        uint256 indexed submissionId,
        bytes32 msgHash,
        address claimedSigner
    );

    /**
     * @notice Sottomette una firma per verifica ottimistica
     * @param _msgHash Hash del messaggio che si afferma essere firmato
     * @param _signature Firma ECDSA in formato (r, s, v)
     * @param _claimedSigner Indirizzo che si afferma abbia firmato
     * @return submissionId ID della sottomissione
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
            submitter: msg.sender
        });

        emit SignatureSubmitted(
            submissionId,
            _msgHash,
            _claimedSigner,
            msg.sender
        );
    }

    /**
     * @notice Contesta una sottomissione fraudolenta
     * @param _submissionId ID della sottomissione da contestare
     * @dev Verifica che la firma sia effettivamente invalida
     */
    function challengeSignature(uint256 _submissionId) external {
        SignatureSubmission storage sub = submissions[_submissionId];

        require(!sub.finalized, "Submission already finalized");
        require(!sub.challenged, "Submission already challenged");
        require(
            block.timestamp <= sub.submissionTime + CHALLENGE_PERIOD,
            "Challenge period expired"
        );

        // Recupera l'indirizzo reale dalla firma
        address recovered = recoverSigner(sub.msgHash, sub.signature);

        // La challenge ha successo solo se c'è discrepanza
        require(
            recovered != sub.claimedSigner,
            "Signature is valid - challenge failed"
        );

        // Marca come contestata
        sub.challenged = true;

        emit SignatureChallenged(
            _submissionId,
            msg.sender,
            recovered,
            sub.claimedSigner
        );

        // In un sistema reale: penalizza il submitter e premia il challenger
        // payable(msg.sender).transfer(CHALLENGE_REWARD);
    }

    /**
     * @notice Finalizza una sottomissione dopo la challenge window
     * @param _submissionId ID della sottomissione da finalizzare
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

        // A questo punto la firma è considerata valida e definitiva
        // Qui potresti sbloccare fondi, aggiornare stato, ecc.
    }

    /**
     * @notice Recupera il firmatario da una firma ECDSA
     * @param _msgHash Hash del messaggio
     * @param _signature Firma in formato (r, s, v)
     * @return Indirizzo del firmatario
     */
    function recoverSigner(
        bytes32 _msgHash,
        bytes memory _signature
    ) public pure returns (address) {
        require(_signature.length == 65, "Invalid signature length");

        bytes32 r;
        bytes32 s;
        uint8 v;

        // Estrai r, s, v dalla firma
        assembly {
            r := mload(add(_signature, 32))
            s := mload(add(_signature, 64))
            v := byte(0, mload(add(_signature, 96)))
        }

        // Usa ecrecover (precompilata EVM)
        return ecrecover(_msgHash, v, r, s);
    }

    /**
     * @notice Verifica se una sottomissione è stata finalizzata con successo
     */
    function isFinalized(uint256 _submissionId) external view returns (bool) {
        return submissions[_submissionId].finalized;
    }

    /**
     * @notice Verifica se una sottomissione è stata contestata
     */
    function isChallenged(uint256 _submissionId) external view returns (bool) {
        return submissions[_submissionId].challenged;
    }

    /**
     * @notice Ottiene il tempo rimanente per contestare una sottomissione
     */
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
}