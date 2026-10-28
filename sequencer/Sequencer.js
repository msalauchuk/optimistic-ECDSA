const { ethers } = require("ethers");
const crypto = require("crypto");

/**
 * Optimistic Rollup Sequencer - L2 Implementation
 *
 * Questo sequencer:
 * 1. Mantiene uno state L2 in-memory
 * 2. Raccoglie transazioni in una mempool
 * 3. Processa transazioni off-chain
 * 4. Crea batch periodici
 * 5. Propone batch al contratto L1
 */

class OptimisticSequencer {
    constructor(l1Provider, l1Contract, sequencerWallet, config = {}) {
        this.l1Provider = l1Provider;
        this.l1Contract = l1Contract;
        this.sequencerWallet = sequencerWallet;

        // Configurazione
        this.config = {
            batchInterval: config.batchInterval || 30000,      // 30 secondi
            maxBatchSize: config.maxBatchSize || 50,           // Max 50 tx per batch
            minBatchSize: config.minBatchSize || 1,            // Min 1 tx per batch
            ...config
        };

        // L2 State (in-memory)
        this.l2State = {
            accounts: new Map(),          // address -> account info
            verifiedSignatures: new Map(), // txHash -> verification result
            l2BlockNumber: 0,
            stateRoot: ethers.ZeroHash,
            nonce: 0
        };

        // Mempool per transazioni pending
        this.mempool = [];

        // Statistiche
        this.stats = {
            totalTxProcessed: 0,
            totalBatchesProposed: 0,
            totalGasSaved: 0,
            l2TxCount: 0,
            l1TxCount: 0
        };

        // Status
        this.isRunning = false;
        this.batchTimer = null;
    }

    // ============================================
    // L2 STATE MANAGEMENT
    // ============================================

    /**
     * Inizializza un account nello state L2
     */
    initAccount(address) {
        if (!this.l2State.accounts.has(address)) {
            this.l2State.accounts.set(address, {
                address: address,
                nonce: 0,
                verifiedSignatures: [],
                balance: 0,
                createdAt: Date.now()
            });
        }
    }

    /**
     * Aggiorna lo state root usando un vero Merkle tree sugli account L2.
     */
    updateStateRoot() {
        // Estrai e ordina gli account per address per avere determinismo
        const accountEntries = Array.from(this.l2State.accounts.entries())
            .sort(([addrA], [addrB]) => addrA.localeCompare(addrB));

        // Se non ci sono account, root = ZeroHash
        if (accountEntries.length === 0) {
            this.l2State.stateRoot = ethers.ZeroHash;
            return this.l2State.stateRoot;
        }

        // Calcola i leaf hash
        const leaves = accountEntries.map(([address, account]) =>
            this.getAccountLeaf(address, account)
        );

        // Radice Merkle sugli account
        const accountsRoot = this.buildMerkleRoot(leaves);

        // Opzionale ma carino: mixiamo il Merkle root con il l2BlockNumber,
        // così il root cambia anche se gli account restano gli stessi ma cambia il "blocco L2".
        this.l2State.stateRoot = ethers.solidityPackedKeccak256(
            ["bytes32", "uint256"],
            [accountsRoot, BigInt(this.l2State.l2BlockNumber)]
        );

        return this.l2State.stateRoot;
    }

    // ============================================
    // TRANSACTION PROCESSING (OFF-CHAIN)
    // ============================================

    /**
     * Ricevi una transazione da user per processamento L2
     */
    async submitL2Transaction(tx) {
        console.log(`[L2] Received transaction from: ${tx.from}`);
        console.log(`     Message: ${tx.message.substring(0, 50)}...`);

        // Validazione base
        if (!tx.message || !tx.signature || !tx.from) {
            throw new Error("Invalid transaction format");
        }

        // Aggiungi alla mempool
        const txWithTimestamp = {
            ...tx,
            timestamp: Date.now(),
            txHash: this.generateTxHash(tx),
            status: 'pending'
        };

        this.mempool.push(txWithTimestamp);
        this.stats.l2TxCount++;

        console.log(`     Added to mempool (size: ${this.mempool.length})`);

        return txWithTimestamp.txHash;
    }

    /**
     * Processa una transazione OFF-CHAIN (no gas!)
     */
    async processTransaction(tx) {
        try {
            // 1. Hash del messaggio (EIP-191)
            const msgHash = ethers.hashMessage(tx.message);

            // 2. Verifica firma OFF-CHAIN (computazione gratuita!)
            const recoveredAddress = ethers.verifyMessage(tx.message, tx.signature);

            // 3. Determina se valida
            const isValid = recoveredAddress.toLowerCase() === tx.from.toLowerCase();

            // 4. Aggiorna L2 state
            this.initAccount(tx.from);
            const account = this.l2State.accounts.get(tx.from);
            account.nonce++;

            if (isValid) {
                account.verifiedSignatures.push({
                    message: tx.message,
                    signature: tx.signature,
                    timestamp: Date.now()
                });
            }

            // 5. Salva risultato
            this.l2State.verifiedSignatures.set(tx.txHash, {
                msgHash: msgHash,
                signature: tx.signature,
                claimedSigner: tx.from,
                actualSigner: recoveredAddress,
                isValid: isValid,
                processedAt: Date.now()
            });

            this.stats.totalTxProcessed++;

            console.log(`     Processed: ${isValid ? 'VALID' : 'INVALID'}`);
            console.log(`     Claimed: ${tx.from}`);
            console.log(`     Actual:  ${recoveredAddress}`);

            return {
                txHash: tx.txHash,
                msgHash: msgHash,
                signature: tx.signature,
                claimedSigner: tx.from,
                actualSigner: recoveredAddress,
                isValid: isValid
            };

        } catch (error) {
            console.error(`     ERROR processing tx: ${error.message}`);
            throw error;
        }
    }

    // ============================================
    // BATCH CREATION & PROPOSAL
    // ============================================

    /**
     * Crea e proponi un batch al contratto L1
     */
    async createAndProposeBatch() {
        if (this.mempool.length === 0) {
            console.log("[BATCH] No transactions in mempool, skipping batch");
            return null;
        }

        // Prendi le prime N transazioni dalla mempool
        const batchSize = Math.min(this.mempool.length, this.config.maxBatchSize);
        const txsToProcess = this.mempool.splice(0, batchSize);

        console.log("\n" + "=".repeat(60));
        console.log(`[BATCH] Creating batch with ${txsToProcess.length} transactions`);
        console.log("=".repeat(60));

        // Processa tutte le transazioni OFF-CHAIN
        const processedTxs = [];
        for (const tx of txsToProcess) {
            const result = await this.processTransaction(tx);
            processedTxs.push(result);
        }

        // Aggiorna state root
        this.l2State.l2BlockNumber++;
        const newStateRoot = this.updateStateRoot();

        console.log(`\n[STATE] L2 State Updated:`);
        console.log(`        Block Number: ${this.l2State.l2BlockNumber}`);
        console.log(`        State Root: ${newStateRoot.substring(0, 10)}...`);
        console.log(`        Total Accounts: ${this.l2State.accounts.size}`);
        console.log(`        Verified Sigs: ${this.l2State.verifiedSignatures.size}`);

        // Prepara dati per L1
        const msgHashes = processedTxs.map(tx => tx.msgHash);
        const signatures = processedTxs.map(tx => tx.signature);
        const claimedSigners = processedTxs.map(tx => tx.claimedSigner);

        // Proponi batch al contratto L1
        console.log(`\n[L1] Proposing batch to L1...`);

        try {
            const tx = await this.l1Contract.proposeBatch(
                newStateRoot,
                msgHashes,
                signatures,
                claimedSigners
            );

            console.log(`     Transaction hash: ${tx.hash}`);
            console.log(`     Waiting for confirmation...`);

            const receipt = await tx.wait();

            console.log(`     Batch proposed successfully`);
            console.log(`     Gas used: ${receipt.gasUsed.toString()}`);
            console.log(`     Block: ${receipt.blockNumber}`);

            // Aggiorna statistiche
            this.stats.totalBatchesProposed++;
            this.stats.l1TxCount++;

            // Calcola gas risparmiato
            const traditionalGas = processedTxs.length * 45000;
            const actualGas = Number(receipt.gasUsed);
            const gasSaved = traditionalGas - actualGas;
            this.stats.totalGasSaved += gasSaved;

            console.log(`\n[GAS] Gas Analysis:`);
            console.log(`      Traditional (all on-chain): ${traditionalGas.toLocaleString()} gas`);
            console.log(`      Optimistic (batched): ${actualGas.toLocaleString()} gas`);
            console.log(`      Saved: ${gasSaved.toLocaleString()} gas (${((gasSaved/traditionalGas)*100).toFixed(1)}%)`);

            return {
                batchId: this.stats.totalBatchesProposed - 1,
                stateRoot: newStateRoot,
                numTxs: processedTxs.length,
                txHash: tx.hash,
                gasUsed: receipt.gasUsed,
                gasSaved: gasSaved
            };

        } catch (error) {
            console.error(`     ERROR proposing batch: ${error.message}`);
            // In caso di errore, rimetti le tx nella mempool
            this.mempool.unshift(...txsToProcess);
            throw error;
        }
    }

    // ============================================
    // SEQUENCER LIFECYCLE
    // ============================================

    /**
     * Avvia il sequencer
     */
    async start() {
        if (this.isRunning) {
            console.log("[WARN] Sequencer already running");
            return;
        }

        console.log("\n" + "=".repeat(60));
        console.log("[SEQUENCER] Starting Optimistic Rollup Sequencer");
        console.log("=".repeat(60));
        console.log(`Sequencer address: ${this.sequencerWallet.address}`);
        console.log(`Batch interval: ${this.config.batchInterval}ms`);
        console.log(`Max batch size: ${this.config.maxBatchSize} txs`);
        console.log("=".repeat(60) + "\n");

        this.isRunning = true;

        // Avvia il loop di batching
        this.startBatchLoop();
    }

    /**
     * Loop periodico per creare batch
     */
    startBatchLoop() {
        this.batchTimer = setInterval(async () => {
            if (this.mempool.length >= this.config.minBatchSize) {
                try {
                    await this.createAndProposeBatch();
                } catch (error) {
                    console.error("[ERROR] Batch loop error:", error);
                }
            }
        }, this.config.batchInterval);
    }

    /**
     * Ferma il sequencer
     */
    async stop() {
        console.log("\n[SEQUENCER] Stopping sequencer...");

        this.isRunning = false;

        if (this.batchTimer) {
            clearInterval(this.batchTimer);
            this.batchTimer = null;
        }

        // Processa eventuali tx rimaste
        if (this.mempool.length > 0) {
            console.log(`[SEQUENCER] Processing remaining ${this.mempool.length} transactions...`);
            await this.createAndProposeBatch();
        }

        this.printStats();

        console.log("[SEQUENCER] Stopped\n");
    }

    // ============================================
    // UTILITY & STATS
    // ============================================

    generateTxHash(tx) {
        return ethers.keccak256(
            ethers.toUtf8Bytes(
                tx.message + tx.signature + tx.from + Date.now()
            )
        );
    }

    printStats() {
        console.log("\n" + "=".repeat(60));
        console.log("[STATS] SEQUENCER STATISTICS");
        console.log("=".repeat(60));
        console.log(`Total L2 Transactions Received: ${this.stats.l2TxCount}`);
        console.log(`Total L2 Transactions Processed: ${this.stats.totalTxProcessed}`);
        console.log(`Total L1 Batches Proposed: ${this.stats.totalBatchesProposed}`);
        console.log(`Total L1 Transactions: ${this.stats.l1TxCount}`);
        console.log(`L2 Block Number: ${this.l2State.l2BlockNumber}`);
        console.log(`Current State Root: ${this.l2State.stateRoot.substring(0, 20)}...`);
        console.log(`Total Gas Saved: ${this.stats.totalGasSaved.toLocaleString()}`);

        if (this.stats.l2TxCount > 0) {
            const compressionRatio = this.stats.l2TxCount / Math.max(this.stats.l1TxCount, 1);
            console.log(`Compression Ratio: ${compressionRatio.toFixed(2)}x`);
        }

        console.log("=".repeat(60) + "\n");
    }

    getState() {
        return {
            l2BlockNumber: this.l2State.l2BlockNumber,
            stateRoot: this.l2State.stateRoot,
            accountCount: this.l2State.accounts.size,
            verifiedCount: this.l2State.verifiedSignatures.size,
            mempoolSize: this.mempool.length,
            stats: this.stats
        };
    }

    // ============================================
    // MERKLE TREE HELPERS
    // ============================================

    /**
     * Calcola il leaf hash per un account L2.
     * Usiamo un encoding stile Solidity per avere qualcosa di "realistico".
     */
    getAccountLeaf(address, account) {
        return ethers.solidityPackedKeccak256(
            ["address", "uint256", "uint256", "uint256"],
            [
                address,
                BigInt(account.balance || 0),
                BigInt(account.nonce || 0),
                BigInt((account.verifiedSignatures || []).length)
            ]
        );
    }

    /**
     * Costruisce la radice Merkle da una lista di leaf hash (bytes32)
     */
    buildMerkleRoot(leaves) {
        if (leaves.length === 0) {
            return ethers.ZeroHash;
        }

        let level = [...leaves];

        while (level.length > 1) {
            const nextLevel = [];

            for (let i = 0; i < level.length; i += 2) {
                const left = level[i];
                const right = (i + 1 < level.length) ? level[i + 1] : level[i]; // duplica ultimo se dispari

                const parent = ethers.solidityPackedKeccak256(
                    ["bytes32", "bytes32"],
                    [left, right]
                );
                nextLevel.push(parent);
            }

            level = nextLevel;
        }

        return level[0];
    }


}



module.exports = OptimisticSequencer;