const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const OptimisticSequencer = require("../../sequencer/Sequencer");

describe("OptimisticRollupL1", function () {
    let l1Contract;
    let sequencer;
    let deployer, sequencerAccount, user1, user2, user3, challenger;
    let user1Wallet, user2Wallet, user3Wallet;

    beforeEach(async function () {
        // Get accounts
        [deployer, sequencerAccount, user1, user2, user3, challenger] =
            await ethers.getSigners();

        // Create wallets for signing
        user1Wallet = new ethers.Wallet(user1.privateKey);
        user2Wallet = new ethers.Wallet(user2.privateKey);
        user3Wallet = new ethers.Wallet(user3.privateKey);

        // Deploy L1 contract
        const OptimisticRollupL1 = await ethers.getContractFactory(
            "OptimisticRollupL1"
        );
        l1Contract = await OptimisticRollupL1.deploy(sequencerAccount.address);
        await l1Contract.waitForDeployment();

        console.log("Contract deployed at:", await l1Contract.getAddress());

        // Initialize sequencer
        sequencer = new OptimisticSequencer(
            ethers.provider,
            l1Contract.connect(sequencerAccount),
            sequencerAccount,
            {
                batchInterval: 5000,  // 5 secondi per test veloci
                maxBatchSize: 10,
                minBatchSize: 1
            }
        );
    });

    afterEach(async function () {
        // Stop sequencer se in esecuzione
        if (sequencer && sequencer.isRunning) {
            await sequencer.stop();
        }
    });

    describe("Deployment", function () {
        it("Dovrebbe deployare con sequencer corretto", async function () {
            expect(await l1Contract.sequencer()).to.equal(sequencerAccount.address);
            expect(await l1Contract.batchCount()).to.equal(0);
            expect(await l1Contract.submissionCount()).to.equal(0);

            console.log("[OK] Contract deployed with correct sequencer");
        });

        it("Dovrebbe inizializzare lo stato correttamente", async function () {
            expect(await l1Contract.l2BlockNumber()).to.equal(0);
            expect(await l1Contract.currentStateRoot()).to.equal(ethers.ZeroHash);

            console.log("[OK] Initial state correct");
        });
    });

    describe("Single Submission (Retrocompatibilità)", function () {
        it("Dovrebbe permettere submission singola diretta", async function () {
            const message = "Test direct submission";
            const messageHash = ethers.hashMessage(message);
            const signature = await user1Wallet.signMessage(message);

            const tx = await l1Contract.submitSignature(
                messageHash,
                signature,
                user1.address
            );
            const receipt = await tx.wait();

            // Verifica evento
            const event = receipt.logs.find(
                log => log.fragment && log.fragment.name === "SignatureSubmitted"
            );
            expect(event).to.not.be.undefined;

            // Verifica dati
            const submission = await l1Contract.submissions(0);
            expect(submission.msgHash).to.equal(messageHash);
            expect(submission.claimedSigner).to.equal(user1.address);
            expect(submission.batchId).to.equal(0); // Non parte di batch

            console.log("[OK] Direct submission works");
        });
    });

    describe("Batch Proposals", function () {
        it("Dovrebbe permettere al sequencer di proporre un batch", async function () {
            const message1 = "Batch tx 1";
            const message2 = "Batch tx 2";

            const hash1 = ethers.hashMessage(message1);
            const hash2 = ethers.hashMessage(message2);

            const sig1 = await user1Wallet.signMessage(message1);
            const sig2 = await user2Wallet.signMessage(message2);

            const stateRoot = ethers.keccak256(ethers.toUtf8Bytes("test_state"));

            const tx = await l1Contract.connect(sequencerAccount).proposeBatch(
                stateRoot,
                [hash1, hash2],
                [sig1, sig2],
                [user1.address, user2.address]
            );
            const receipt = await tx.wait();

            // Verifica evento BatchProposed
            const batchEvent = receipt.logs.find(
                log => log.fragment && log.fragment.name === "BatchProposed"
            );
            expect(batchEvent).to.not.be.undefined;

            // Verifica batch creato
            const batchCount = await l1Contract.batchCount();
            expect(batchCount).to.equal(1);

            const batch = await l1Contract.batches(0);
            expect(batch.stateRoot).to.equal(stateRoot);
            expect(batch.numTransactions).to.equal(2);
            expect(batch.proposer).to.equal(sequencerAccount.address);

            // Verifica submissions create
            const submissionCount = await l1Contract.submissionCount();
            expect(submissionCount).to.equal(2);

            const sub1 = await l1Contract.submissions(0);
            expect(sub1.batchId).to.equal(1); // Batch ID 0, ma interno è 1

            console.log("[OK] Batch proposal successful");
            console.log(`    Batch ID: 0, ${batch.numTransactions} transactions`);
        });

        it("NON dovrebbe permettere a non-sequencer di proporre batch", async function () {
            const stateRoot = ethers.keccak256(ethers.toUtf8Bytes("test"));
            const hash = ethers.hashMessage("test");
            const sig = await user1Wallet.signMessage("test");

            await expect(
                l1Contract.connect(user1).proposeBatch(
                    stateRoot,
                    [hash],
                    [sig],
                    [user1.address]
                )
            ).to.be.revertedWith("Only sequencer");

            console.log("[OK] Non-sequencer correctly rejected");
        });

        it("Dovrebbe rifiutare batch vuoti", async function () {
            const stateRoot = ethers.keccak256(ethers.toUtf8Bytes("test"));

            await expect(
                l1Contract.connect(sequencerAccount).proposeBatch(
                    stateRoot,
                    [],
                    [],
                    []
                )
            ).to.be.revertedWith("Empty batch");

            console.log("[OK] Empty batch rejected");
        });

        it("Dovrebbe rifiutare batch con array length mismatch", async function () {
            const stateRoot = ethers.keccak256(ethers.toUtf8Bytes("test"));
            const hash = ethers.hashMessage("test");
            const sig = await user1Wallet.signMessage("test");

            await expect(
                l1Contract.connect(sequencerAccount).proposeBatch(
                    stateRoot,
                    [hash],
                    [sig],
                    [user1.address, user2.address] // Mismatch!
                )
            ).to.be.revertedWith("Length mismatch");

            console.log("[OK] Array mismatch rejected");
        });
    });

    describe("Challenge Mechanism", function () {
        let fraudMessageHash, fraudSignature;

        beforeEach(async function () {
            // Setup: crea batch con 1 firma fraudolenta
            const validMsg = "Valid message";
            const fraudMsg = "Fraud message";

            fraudMessageHash = fraudMsg;

            const validHash = ethers.hashMessage(validMsg);
            fraudSignature = await user2Wallet.signMessage(fraudMsg);

            const validSig = await user1Wallet.signMessage(validMsg);

            const stateRoot = ethers.keccak256(ethers.toUtf8Bytes("state"));

            // Proponi batch con 1 valida e 1 fraudolenta
            await l1Contract.connect(sequencerAccount).proposeBatch(
                stateRoot,
                [validHash, ethers.hashMessage(fraudMsg)],
                [validSig, fraudSignature],
                [user1.address, user1.address] // Seconda è fraud: firma di user2 ma claim user1
            );
        });

        it("Dovrebbe permettere di contestare una submission fraudolenta", async function () {
            // La submission fraudolenta è la #1
            const fraudSubmissionId = 1;

            const tx = await l1Contract.connect(challenger)
                .challengeSignature(fraudSubmissionId);
            const receipt = await tx.wait();

            // Verifica evento
            const event = receipt.logs.find(
                log => log.fragment && log.fragment.name === "SignatureChallenged"
            );
            expect(event).to.not.be.undefined;

            // Verifica stato
            const submission = await l1Contract.submissions(fraudSubmissionId);
            expect(submission.challenged).to.be.true;

            // Verifica che il batch sia marcato come challenged
            const batch = await l1Contract.batches(0);
            expect(batch.challenged).to.be.true;

            console.log("[OK] Fraudulent submission challenged successfully");
        });

        it("NON dovrebbe permettere challenge su firma valida", async function () {
            const validSubmissionId = 0;

            await expect(
                l1Contract.connect(challenger).challengeSignature(validSubmissionId)
            ).to.be.revertedWith("Signature valid - challenge failed");

            console.log("[OK] Valid signature challenge rejected");
        });

        it("NON dovrebbe permettere challenge dopo period scaduto", async function () {
            const fraudSubmissionId = 1;

            // Avanza tempo oltre challenge period
            await time.increase(301);

            await expect(
                l1Contract.connect(challenger).challengeSignature(fraudSubmissionId)
            ).to.be.revertedWith("Challenge period expired");

            console.log("[OK] Late challenge rejected");
        });
    });

    describe("Batch Finalization", function () {
        beforeEach(async function () {
            // Setup: proponi batch valido
            const msg1 = "Valid 1";
            const msg2 = "Valid 2";

            const hash1 = ethers.hashMessage(msg1);
            const hash2 = ethers.hashMessage(msg2);

            const sig1 = await user1Wallet.signMessage(msg1);
            const sig2 = await user2Wallet.signMessage(msg2);

            const stateRoot = ethers.keccak256(ethers.toUtf8Bytes("state"));

            await l1Contract.connect(sequencerAccount).proposeBatch(
                stateRoot,
                [hash1, hash2],
                [sig1, sig2],
                [user1.address, user2.address]
            );
        });

        it("Dovrebbe finalizzare batch dopo challenge period", async function () {
            const batchId = 0;

            // Avanza tempo
            await time.increase(301);

            const tx = await l1Contract.finalizeBatch(batchId);
            const receipt = await tx.wait();

            // Verifica evento
            const event = receipt.logs.find(
                log => log.fragment && log.fragment.name === "BatchFinalized"
            );
            expect(event).to.not.be.undefined;

            // Verifica stato
            const batch = await l1Contract.batches(batchId);
            expect(batch.finalized).to.be.true;

            // Verifica che currentStateRoot sia aggiornato
            const currentStateRoot = await l1Contract.currentStateRoot();
            expect(currentStateRoot).to.equal(batch.stateRoot);

            console.log("[OK] Batch finalized successfully");
        });

        it("NON dovrebbe finalizzare batch prima di challenge period", async function () {
            const batchId = 0;

            await expect(
                l1Contract.finalizeBatch(batchId)
            ).to.be.revertedWith("Challenge period not expired");

            console.log("[OK] Early finalization rejected");
        });

        it("NON dovrebbe finalizzare batch con challenge", async function () {
            // Aggiungi submission fraudolenta e contestala
            const fraudMsg = "Fraud";
            const fraudHash = ethers.hashMessage(fraudMsg);
            const fraudSig = await user2Wallet.signMessage(fraudMsg);

            await l1Contract.connect(sequencerAccount).proposeBatch(
                ethers.keccak256(ethers.toUtf8Bytes("fraud_state")),
                [fraudHash],
                [fraudSig],
                [user1.address] // Fraud!
            );

            // Challenge
            await l1Contract.connect(challenger).challengeSignature(2);

            // Tenta finalize
            await time.increase(301);

            await expect(
                l1Contract.finalizeBatch(1)
            ).to.be.revertedWith("Batch was challenged");

            console.log("[OK] Challenged batch finalization rejected");
        });
    });

    describe("Sequencer Integration", function () {
        it("Dovrebbe processare transazioni attraverso sequencer", async function () {
            // Start sequencer
            await sequencer.start();

            // Submit transazioni L2
            const message1 = "L2 transaction 1";
            const signature1 = await user1Wallet.signMessage(message1);

            await sequencer.submitL2Transaction({
                from: user1.address,
                message: message1,
                signature: signature1
            });

            const message2 = "L2 transaction 2";
            const signature2 = await user2Wallet.signMessage(message2);

            await sequencer.submitL2Transaction({
                from: user2.address,
                message: message2,
                signature: signature2
            });

            // Verifica mempool
            const state = sequencer.getState();
            expect(state.mempoolSize).to.equal(2);

            // Forza creazione batch
            await sequencer.createAndProposeBatch();

            // Verifica che batch sia stato proposto su L1
            const batchCount = await l1Contract.batchCount();
            expect(batchCount).to.equal(1);

            const batch = await l1Contract.batches(0);
            expect(batch.numTransactions).to.equal(2);

            console.log("[OK] Sequencer integration works");
            console.log(`    Processed 2 L2 transactions`);
            console.log(`    Created 1 batch on L1`);

            // Stop sequencer
            await sequencer.stop();
        });

        it("Dovrebbe calcolare correttamente gas savings", async function () {
            await sequencer.start();

            // Submit 5 transazioni
            for (let i = 0; i < 5; i++) {
                const message = `Transaction ${i}`;
                const signature = await user1Wallet.signMessage(message);

                await sequencer.submitL2Transaction({
                    from: user1.address,
                    message: message,
                    signature: signature
                });
            }

            // Crea batch
            const result = await sequencer.createAndProposeBatch();

            expect(result).to.not.be.null;
            expect(result.numTxs).to.equal(5);
            expect(result.gasSaved).to.be.greaterThan(0);

            // Traditional: 5 × 45,000 = 225,000
            // Optimistic batch: ~150,000
            // Savings: ~75,000+ gas

            const traditionalGas = 5 * 45000;
            const savingsPercent = (result.gasSaved / traditionalGas) * 100;

            console.log("[OK] Gas savings calculated");
            console.log(`    Traditional: ${traditionalGas} gas`);
            console.log(`    Optimistic: ${traditionalGas - result.gasSaved} gas`);
            console.log(`    Saved: ${result.gasSaved} gas (${savingsPercent.toFixed(1)}%)`);

            expect(savingsPercent).to.be.greaterThan(30); // At least 30% savings

            await sequencer.stop();
        });
    });

    describe("View Functions", function () {
        it("Dovrebbe restituire submission IDs per batch", async function () {
            // Proponi batch con 3 tx
            const messages = ["msg1", "msg2", "msg3"];
            const hashes = messages.map(m => ethers.hashMessage(m));
            const signatures = await Promise.all(
                messages.map(m => user1Wallet.signMessage(m))
            );
            const signers = [user1.address, user1.address, user1.address];

            const stateRoot = ethers.keccak256(ethers.toUtf8Bytes("state"));

            await l1Contract.connect(sequencerAccount).proposeBatch(
                stateRoot,
                hashes,
                signatures,
                signers
            );

            // Get submissions per batch
            const submissionIds = await l1Contract.getBatchSubmissions(0);
            expect(submissionIds.length).to.equal(3);

            console.log("[OK] getBatchSubmissions works");
        });

        it("Dovrebbe calcolare tempo challenge rimanente", async function () {
            const message = "test";
            const hash = ethers.hashMessage(message);
            const sig = await user1Wallet.signMessage(message);

            await l1Contract.submitSignature(hash, sig, user1.address);

            let remaining = await l1Contract.getRemainingChallengeTime(0);
            expect(remaining).to.be.closeTo(300n, 5n);

            await time.increase(100);

            remaining = await l1Contract.getRemainingChallengeTime(0);
            expect(remaining).to.be.closeTo(200n, 5n);

            console.log("[OK] getRemainingChallengeTime works");
        });
    });

    describe("Gas Analysis", function () {
        it("Dovrebbe confrontare gas: singola vs batch", async function () {
            // Test 1: Singola submission diretta
            const msg1 = "Single submission";
            const hash1 = ethers.hashMessage(msg1);
            const sig1 = await user1Wallet.signMessage(msg1);

            const singleTx = await l1Contract.submitSignature(
                hash1,
                sig1,
                user1.address
            );
            const singleReceipt = await singleTx.wait();
            const singleGas = singleReceipt.gasUsed;

            // Test 2: Batch con 5 submissions
            const messages = Array.from({length: 5}, (_, i) => `Batch msg ${i}`);
            const hashes = messages.map(m => ethers.hashMessage(m));
            const signatures = await Promise.all(
                messages.map(m => user1Wallet.signMessage(m))
            );
            const signers = Array(5).fill(user1.address);

            const stateRoot = ethers.keccak256(ethers.toUtf8Bytes("state"));

            const batchTx = await l1Contract.connect(sequencerAccount).proposeBatch(
                stateRoot,
                hashes,
                signatures,
                signers
            );
            const batchReceipt = await batchTx.wait();
            const batchGas = batchReceipt.gasUsed;

            // Analisi
            const batchGasPerTx = Number(batchGas) / 5;
            const savings = ((Number(singleGas) - batchGasPerTx) / Number(singleGas)) * 100;

            console.log("\n[GAS ANALYSIS]");
            console.log(`  Single submission: ${singleGas} gas`);
            console.log(`  Batch (5 tx): ${batchGas} gas total`);
            console.log(`  Batch per tx: ${batchGasPerTx.toFixed(0)} gas`);
            console.log(`  Savings: ${savings.toFixed(1)}%`);

            expect(batchGasPerTx).to.be.lessThan(Number(singleGas));
        });
    });
});