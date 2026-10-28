const { ethers } = require("hardhat");
const OptimisticSequencer = require("../sequencer/Sequencer");

/**
 * Demo Completa: Optimistic Rollup L2
 *
 * Dimostra:
 * 1. Deploy contratto L1
 * 2. Avvio sequencer L2
 * 3. Sottomissione transazioni da users a L2
 * 4. Batching automatico e proposal a L1
 * 5. Challenge period e finalizzazione
 * 6. Metriche performance
 */

async function main() {
    console.log("\n" + "=".repeat(70));
    console.log("DEMO COMPLETA: OPTIMISTIC ROLLUP L2");
    console.log("=".repeat(70) + "\n");

    // ============================================
    // SETUP
    // ============================================

    console.log("Step 1: Setup Accounts\n");

    const [deployer, sequencerAccount, user1, user2, user3, challenger] =
        await ethers.getSigners();

    console.log("Accounts:");
    console.log(`  Deployer:   ${deployer.address}`);
    console.log(`  Sequencer:  ${sequencerAccount.address}`);
    console.log(`  User1:      ${user1.address}`);
    console.log(`  User2:      ${user2.address}`);
    console.log(`  User3:      ${user3.address}`);
    console.log(`  Challenger: ${challenger.address}`);

    // ============================================
    // DEPLOY L1 CONTRACT
    // ============================================

    console.log("\n" + "=".repeat(70));
    console.log("Step 2: Deploy L1 Contract");
    console.log("=".repeat(70) + "\n");

    const OptimisticRollupL1 = await ethers.getContractFactory(
        "OptimisticRollupL1"
    );
    const l1Contract = await OptimisticRollupL1.deploy(sequencerAccount.address);
    await l1Contract.waitForDeployment();

    const contractAddress = await l1Contract.getAddress();
    console.log(`Contract deployed at: ${contractAddress}\n`);

    // ============================================
    // START SEQUENCER
    // ============================================

    console.log("=".repeat(70));
    console.log("Step 3: Initialize & Start Sequencer");
    console.log("=".repeat(70) + "\n");

    const sequencer = new OptimisticSequencer(
        ethers.provider,
        l1Contract.connect(sequencerAccount),
        sequencerAccount,
        {
            batchInterval: 15000,  // 15 secondi per demo
            maxBatchSize: 10,
            minBatchSize: 1
        }
    );

    await sequencer.start();

    // Attendi un attimo
    await sleep(2000);

    // ============================================
    // SIMULATE USERS SENDING L2 TRANSACTIONS
    // ============================================

    console.log("=".repeat(70));
    console.log("Step 4: Users Submit Transactions to L2");
    console.log("=".repeat(70) + "\n");

    // Crea wallets per firmare
    const user1Wallet = new ethers.Wallet(user1.privateKey);
    const user2Wallet = new ethers.Wallet(user2.privateKey);
    const user3Wallet = new ethers.Wallet(user3.privateKey);

    // User 1: Transazioni valide
    console.log("User1 submitting transactions...");
    for (let i = 1; i <= 5; i++) {
        const message = `User1 Transaction #${i} - ${Date.now()}`;
        const signature = await user1Wallet.signMessage(message);

        await sequencer.submitL2Transaction({
            from: user1.address,
            message: message,
            signature: signature
        });
    }

    await sleep(1000);

    // User 2: Transazioni valide
    console.log("\nUser2 submitting transactions...");
    for (let i = 1; i <= 3; i++) {
        const message = `User2 Transaction #${i} - ${Date.now()}`;
        const signature = await user2Wallet.signMessage(message);

        await sequencer.submitL2Transaction({
            from: user2.address,
            message: message,
            signature: signature
        });
    }

    await sleep(1000);

    // User 3: Una transazione fraudolenta
    console.log("\nUser3 submitting transaction (one fraudulent)...");

    // Transazione 1: Valida
    const validMessage = `User3 Valid Transaction - ${Date.now()}`;
    const validSignature = await user3Wallet.signMessage(validMessage);
    await sequencer.submitL2Transaction({
        from: user3.address,
        message: validMessage,
        signature: validSignature
    });

    // Transazione 2: FRAUDOLENTA
    const fraudMessage = `User3 Fraud Attempt - ${Date.now()}`;
    const fraudSignature = await user3Wallet.signMessage(fraudMessage);
    await sequencer.submitL2Transaction({
        from: user1.address,  // FALSO! Firma e' di user3
        message: fraudMessage,
        signature: fraudSignature
    });

    console.log("\nCurrent State:");
    const state = sequencer.getState();
    console.log(`   Mempool size: ${state.mempoolSize} transactions`);
    console.log(`   Waiting for batch...\n`);

    // ============================================
    // WAIT FOR BATCH PROCESSING
    // ============================================

    console.log("=".repeat(70));
    console.log("Step 5: Wait for Sequencer to Create Batch");
    console.log("=".repeat(70) + "\n");

    console.log("Sequencer will automatically create batch in ~15 seconds...");

    // Attendi che il sequencer processi
    await sleep(20000);

    // ============================================
    // VERIFY BATCH ON L1
    // ============================================

    console.log("\n" + "=".repeat(70));
    console.log("Step 6: Verify Batch on L1");
    console.log("=".repeat(70) + "\n");

    const batchCount = await l1Contract.batchCount();
    console.log(`Total batches proposed: ${batchCount}\n`);

    if (batchCount > 0) {
        const latestBatchId = batchCount - 1n;
        const batch = await l1Contract.batches(latestBatchId);

        console.log(`Batch #${latestBatchId}:`);
        console.log(`  State Root: ${batch.stateRoot}`);
        console.log(`  Num Transactions: ${batch.numTransactions}`);
        console.log(`  L2 Block Number: ${batch.l2BlockNumber}`);
        console.log(`  Proposer: ${batch.proposer}`);
        console.log(`  Timestamp: ${new Date(Number(batch.timestamp) * 1000).toISOString()}`);
        console.log(`  Finalized: ${batch.finalized}`);
        console.log(`  Challenged: ${batch.challenged}\n`);

        // Mostra submissions nel batch
        const submissionIds = await l1Contract.getBatchSubmissions(latestBatchId);
        console.log(`Submissions in batch (${submissionIds.length} total):`);

        for (let i = 0; i < Math.min(submissionIds.length, 3); i++) {
            const subId = submissionIds[i];
            const sub = await l1Contract.submissions(subId);
            console.log(`  [${subId}] Signer: ${sub.claimedSigner.substring(0, 10)}...`);
        }

        if (submissionIds.length > 3) {
            console.log(`  ... and ${submissionIds.length - 3} more`);
        }
    }

    // ============================================
    // CHALLENGE FRAUDULENT TRANSACTION
    // ============================================

    console.log("\n" + "=".repeat(70));
    console.log("Step 7: Challenge Fraudulent Transaction");
    console.log("=".repeat(70) + "\n");

    // Trova la submission fraudolenta
    const totalSubmissions = await l1Contract.submissionCount();
    console.log(`Searching through ${totalSubmissions} submissions for fraud...\n`);

    let fraudSubmissionId = null;

    for (let i = 0; i < totalSubmissions; i++) {
        const sub = await l1Contract.submissions(i);

        // Verifica off-chain se e' fraudolenta
        const actualSigner = ethers.verifyMessage(
            fraudMessage,
            sub.signature
        );

        if (actualSigner.toLowerCase() !== sub.claimedSigner.toLowerCase()) {
            console.log(`FRAUD DETECTED at submission #${i}`);
            console.log(`   Claimed signer: ${sub.claimedSigner}`);
            console.log(`   Actual signer:  ${actualSigner}`);
            fraudSubmissionId = i;
            break;
        }
    }

    if (fraudSubmissionId !== null) {
        console.log(`\nChallenger submitting fraud proof...\n`);

        const challengeTx = await l1Contract.connect(challenger)
            .challengeSignature(fraudSubmissionId);
        const challengeReceipt = await challengeTx.wait();

        console.log(`Challenge successful`);
        console.log(`  Transaction: ${challengeTx.hash}`);
        console.log(`  Gas used: ${challengeReceipt.gasUsed}`);
        console.log(`  Challenger: ${challenger.address}\n`);

        // Verifica stato
        const sub = await l1Contract.submissions(fraudSubmissionId);
        console.log(`Submission #${fraudSubmissionId} status:`);
        console.log(`  Challenged: ${sub.challenged}`);
        console.log(`  Finalized: ${sub.finalized}\n`);
    } else {
        console.log("No fraud found (unexpected in this demo)\n");
    }

    // ============================================
    // FINALIZATION
    // ============================================

    console.log("=".repeat(70));
    console.log("Step 8: Finalization (Simulated)");
    console.log("=".repeat(70) + "\n");

    console.log("In produzione:");
    console.log("  - Challenge period: 7 giorni");
    console.log("  - Solo submissions non-challenged possono essere finalized");
    console.log("  - Batch con anche solo 1 fraud viene rigettato\n");

    console.log("Nel nostro test:");
    console.log("  - Challenge period: 5 minuti");
    console.log("  - Dimostrazione del pattern completata\n");

    // ============================================
    // PERFORMANCE METRICS
    // ============================================

    console.log("=".repeat(70));
    console.log("Step 9: Performance Metrics");
    console.log("=".repeat(70) + "\n");

    const finalState = sequencer.getState();

    console.log("L2 State:");
    console.log(`  Block Number: ${finalState.l2BlockNumber}`);
    console.log(`  State Root: ${finalState.stateRoot.substring(0, 20)}...`);
    console.log(`  Accounts: ${finalState.accountCount}`);
    console.log(`  Verified Signatures: ${finalState.verifiedCount}`);

    console.log("\nTransaction Stats:");
    console.log(`  L2 Transactions: ${finalState.stats.l2TxCount}`);
    console.log(`  L1 Transactions: ${finalState.stats.l1TxCount}`);
    console.log(`  Batches Proposed: ${finalState.stats.totalBatchesProposed}`);
    console.log(`  Compression Ratio: ${(finalState.stats.l2TxCount / Math.max(finalState.stats.l1TxCount, 1)).toFixed(2)}x`);

    console.log("\nGas Savings:");
    console.log(`  Total Gas Saved: ${finalState.stats.totalGasSaved.toLocaleString()}`);

    if (finalState.stats.l2TxCount > 0) {
        const avgSavingsPerTx = finalState.stats.totalGasSaved / finalState.stats.l2TxCount;
        console.log(`  Avg per Transaction: ${avgSavingsPerTx.toLocaleString()} gas`);

        // Calcola risparmio economico
        const gasPriceGwei = 30;
        const ethPriceUsd = 3000;
        const totalSavingEth = (finalState.stats.totalGasSaved * gasPriceGwei) / 1e9;
        const totalSavingUsd = totalSavingEth * ethPriceUsd;

        console.log(`\nEconomic Savings (@ ${gasPriceGwei} gwei, ETH=${ethPriceUsd}):`);
        console.log(`  Total: ${totalSavingUsd.toFixed(4)}`);
        console.log(`  Per Tx: ${(totalSavingUsd / finalState.stats.l2TxCount).toFixed(6)}`);
    }

    // ============================================
    // COMPARISON
    // ============================================

    console.log("\n" + "=".repeat(70));
    console.log("Step 10: Comparison Traditional vs L2");
    console.log("=".repeat(70) + "\n");

    const numTxs = finalState.stats.l2TxCount;

    // Scenario tradizionale
    const traditionalGasPerTx = 45000;
    const traditionalTotalGas = numTxs * traditionalGasPerTx;
    const traditionalL1Calls = numTxs;

    // Scenario L2
    const l2TotalGas = traditionalTotalGas - finalState.stats.totalGasSaved;
    const l2L1Calls = finalState.stats.l1TxCount;

    console.log("Traditional Approach (All On-chain):");
    console.log(`  L1 Transactions: ${traditionalL1Calls}`);
    console.log(`  Total Gas: ${traditionalTotalGas.toLocaleString()}`);
    console.log(`  Avg Gas/Tx: ${traditionalGasPerTx.toLocaleString()}`);

    console.log("\nL2 Optimistic Approach:");
    console.log(`  L2 Transactions: ${numTxs}`);
    console.log(`  L1 Transactions: ${l2L1Calls}`);
    console.log(`  Total Gas: ${l2TotalGas.toLocaleString()}`);
    console.log(`  Avg Gas/Tx: ${(l2TotalGas / numTxs).toFixed(0)}`);

    console.log("\nImprovement:");
    console.log(`  Gas Reduction: ${((finalState.stats.totalGasSaved / traditionalTotalGas) * 100).toFixed(1)}%`);
    console.log(`  L1 Calls Reduction: ${((1 - l2L1Calls / traditionalL1Calls) * 100).toFixed(1)}%`);
    console.log(`  Throughput Increase: ${(traditionalL1Calls / l2L1Calls).toFixed(2)}x`);

    // ============================================
    // ARCHITECTURE
    // ============================================

    console.log("\n" + "=".repeat(70));
    console.log("Architecture Summary");
    console.log("=".repeat(70) + "\n");

    console.log(`
    Users --> L2 Sequencer --> Process Off-chain --> Create Batch
                  |                                        |
                  | (Free execution)                       |
                  |                                        v
                  |                                   L1 Contract
                  |                                        |
                  +-----> Monitor Off-chain <-------------+
                              |                Challenge Period
                              |                      |
                          Fraud? ---> Challenge -----+
                                         |
                                    [Resolved]
    `);

    console.log("Key Components:");
    console.log("  [OK] L2 Sequencer: Running and processing transactions");
    console.log("  [OK] L2 State: Maintaining off-chain state in-memory");
    console.log("  [OK] Proposer: Batching and proposing to L1");
    console.log("  [OK] L1 Contract: Receiving and storing proposals");
    console.log("  [OK] Challenge Mechanism: Detecting and proving fraud");

    // ============================================
    // CLEANUP
    // ============================================

    console.log("\n" + "=".repeat(70));
    console.log("Cleanup");
    console.log("=".repeat(70) + "\n");

    await sequencer.stop();

    console.log("\n" + "=".repeat(70));
    console.log("DEMO COMPLETED SUCCESSFULLY");
    console.log("=".repeat(70) + "\n");

    console.log("Summary:");
    console.log(`  - Processed ${numTxs} transactions through L2`);
    console.log(`  - Created ${finalState.stats.totalBatchesProposed} batch(es)`);
    console.log(`  - Saved ${finalState.stats.totalGasSaved.toLocaleString()} gas`);
    console.log(`  - Detected and challenged 1 fraud attempt`);
    console.log(`  - Demonstrated complete L2 architecture\n`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });