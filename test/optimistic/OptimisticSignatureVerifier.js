const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("OptimisticSignatureVerifier", function () {
    let contract;
    let owner, user1, user2, challenger;
    let signer, signerAddress;

    beforeEach(async function () {
        // Ottieni account di test
        [owner, user1, user2, challenger] = await ethers.getSigners();

        // Crea un wallet per firmare messaggi
        signer = ethers.Wallet.createRandom();
        signerAddress = signer.address;

        // Deploy del contratto
        const OptimisticSignatureVerifier = await ethers.getContractFactory(
            "OptimisticSignatureVerifier"
        );
        contract = await OptimisticSignatureVerifier.deploy();
        await contract.waitForDeployment();

        console.log("Contract deployed at:", await contract.getAddress());
    });

    describe("Sottomissione di Firme", function () {
        it("Dovrebbe permettere di sottomettere una firma valida", async function () {
            // Crea un messaggio e firmalo
            const message = "Hello, Optimistic Rollup!";
            const messageHash = ethers.hashMessage(message);
            const signature = await signer.signMessage(message);

            // Sottometti la firma
            const tx = await contract.submitSignature(
                messageHash,
                signature,
                signerAddress
            );

            const receipt = await tx.wait();

            // Verifica l'evento
            const event = receipt.logs.find(
                log => log.fragment && log.fragment.name === "SignatureSubmitted"
            );
            expect(event).to.not.be.undefined;

            // Verifica i dati salvati
            const submission = await contract.submissions(0);
            expect(submission.msgHash).to.equal(messageHash);
            expect(submission.claimedSigner).to.equal(signerAddress);
            expect(submission.finalized).to.be.false;
            expect(submission.challenged).to.be.false;

            console.log("✅ Firma valida sottomessa con successo");
        });

        it("Dovrebbe permettere di sottomettere una firma FALSA (senza contestazione)", async function () {
            const message = "Test message";
            const messageHash = ethers.hashMessage(message);
            const signature = await signer.signMessage(message);

            // Dichiara un indirizzo diverso dal vero firmatario (FRODE!)
            const fakeAddress = user2.address;

            // La sottomissione va a buon fine (approccio ottimistico)
            await expect(
                contract.submitSignature(messageHash, signature, fakeAddress)
            ).to.not.be.reverted;

            console.log("⚠️  Firma fraudolenta accettata (come da design ottimistico)");
        });

        it("Dovrebbe rifiutare firme con lunghezza invalida", async function () {
            const messageHash = ethers.hashMessage("test");
            const invalidSignature = "0x1234"; // Troppo corta

            await expect(
                contract.submitSignature(messageHash, invalidSignature, signerAddress)
            ).to.be.revertedWith("Invalid signature length");
        });
    });

    describe("Challenge di Firme Fraudolente", function () {
        let messageHash, signature, submissionId;

        beforeEach(async function () {
            const message = "Test for challenge";
            messageHash = ethers.hashMessage(message);
            signature = await signer.signMessage(message);
        });

        it("Dovrebbe permettere di contestare una firma fraudolenta", async function () {
            // Sottometti una firma con indirizzo sbagliato
            const fakeAddress = user2.address;
            const tx = await contract.submitSignature(
                messageHash,
                signature,
                fakeAddress
            );
            await tx.wait();

            submissionId = 0;

            // Contesta la firma
            const challengeTx = await contract.connect(challenger)
                .challengeSignature(submissionId);
            const receipt = await challengeTx.wait();

            // Verifica l'evento
            const event = receipt.logs.find(
                log => log.fragment && log.fragment.name === "SignatureChallenged"
            );
            expect(event).to.not.be.undefined;

            // Verifica che la submission sia marcata come contestata
            const submission = await contract.submissions(submissionId);
            expect(submission.challenged).to.be.true;

            console.log("✅ Firma fraudolenta contestata con successo");
            console.log(`   Vero firmatario: ${signerAddress}`);
            console.log(`   Dichiarato: ${fakeAddress}`);
        });

        it("NON dovrebbe permettere di contestare una firma valida", async function () {
            // Sottometti una firma CORRETTA
            const tx = await contract.submitSignature(
                messageHash,
                signature,
                signerAddress  // Indirizzo corretto!
            );
            await tx.wait();

            submissionId = 0;

            // Tentativo di challenge fallisce
            await expect(
                contract.connect(challenger).challengeSignature(submissionId)
            ).to.be.revertedWith("Signature is valid - challenge failed");

            console.log("✅ Challenge di firma valida correttamente rifiutata");
        });

        it("NON dovrebbe permettere challenge dopo la scadenza", async function () {
            // Sottometti firma fraudolenta
            const tx = await contract.submitSignature(
                messageHash,
                signature,
                user2.address
            );
            await tx.wait();

            submissionId = 0;

            // Avanza il tempo oltre la challenge window (300 secondi)
            await time.increase(301);

            // Challenge fallisce perché troppo tardi
            await expect(
                contract.connect(challenger).challengeSignature(submissionId)
            ).to.be.revertedWith("Challenge period expired");

            console.log("✅ Challenge tardiva correttamente rifiutata");
        });
    });

    describe("Finalizzazione", function () {
        let messageHash, signature, submissionId;

        beforeEach(async function () {
            const message = "Test for finalization";
            messageHash = ethers.hashMessage(message);
            signature = await signer.signMessage(message);

            // Sottometti firma valida
            const tx = await contract.submitSignature(
                messageHash,
                signature,
                signerAddress
            );
            await tx.wait();
            submissionId = 0;
        });

        it("Dovrebbe finalizzare dopo la challenge window senza contestazioni", async function () {
            // Avanza il tempo oltre la challenge window
            await time.increase(301);

            // Finalizza
            const tx = await contract.finalizeSignature(submissionId);
            const receipt = await tx.wait();

            // Verifica evento
            const event = receipt.logs.find(
                log => log.fragment && log.fragment.name === "SignatureFinalized"
            );
            expect(event).to.not.be.undefined;

            // Verifica stato
            const submission = await contract.submissions(submissionId);
            expect(submission.finalized).to.be.true;

            const isFinalized = await contract.isFinalized(submissionId);
            expect(isFinalized).to.be.true;

            console.log("✅ Firma finalizzata con successo");
        });

        it("NON dovrebbe finalizzare prima della scadenza", async function () {
            // Tenta finalizzazione troppo presto
            await expect(
                contract.finalizeSignature(submissionId)
            ).to.be.revertedWith("Challenge period not expired");

            console.log("✅ Finalizzazione prematura correttamente rifiutata");
        });

        it("NON dovrebbe finalizzare una submission contestata", async function () {
            // Sottometti firma fraudolenta
            const fraudTx = await contract.submitSignature(
                messageHash,
                signature,
                user2.address
            );
            await fraudTx.wait();
            const fraudId = 1;

            // Contesta
            await contract.connect(challenger).challengeSignature(fraudId);

            // Avanza il tempo
            await time.increase(301);

            // Tentativo di finalizzazione fallisce
            await expect(
                contract.finalizeSignature(fraudId)
            ).to.be.revertedWith("Submission was challenged");

            console.log("✅ Finalizzazione di submission contestata rifiutata");
        });
    });

    describe("Funzioni di Utility", function () {
        it("Dovrebbe calcolare correttamente il tempo rimanente", async function () {
            const message = "Time test";
            const messageHash = ethers.hashMessage(message);
            const signature = await signer.signMessage(message);

            await contract.submitSignature(messageHash, signature, signerAddress);
            const submissionId = 0;

            // Subito dopo submission
            let remaining = await contract.getRemainingChallengeTime(submissionId);
            expect(remaining).to.be.closeTo(300n, 5n); // ~300 secondi

            // Avanza di 100 secondi
            await time.increase(100);
            remaining = await contract.getRemainingChallengeTime(submissionId);
            expect(remaining).to.be.closeTo(200n, 5n); // ~200 secondi

            // Dopo scadenza
            await time.increase(201);
            remaining = await contract.getRemainingChallengeTime(submissionId);
            expect(remaining).to.equal(0n);

            console.log("✅ Calcolo tempo rimanente corretto");
        });

        it("Dovrebbe verificare correttamente lo stato delle submissions", async function () {
            const message = "Status test";
            const messageHash = ethers.hashMessage(message);
            const signature = await signer.signMessage(message);

            await contract.submitSignature(messageHash, signature, signerAddress);
            const submissionId = 0;

            // Inizialmente non finalizzata e non contestata
            expect(await contract.isFinalized(submissionId)).to.be.false;
            expect(await contract.isChallenged(submissionId)).to.be.false;

            // Finalizza
            await time.increase(301);
            await contract.finalizeSignature(submissionId);

            expect(await contract.isFinalized(submissionId)).to.be.true;

            console.log("✅ Verifica stato submissions corretta");
        });
    });

    describe("Test di Gas e Performance", function () {
        it("Dovrebbe misurare il gas per sottomissione vs verifica on-chain", async function () {
            const message = "Gas measurement test";
            const messageHash = ethers.hashMessage(message);
            const signature = await signer.signMessage(message);

            // Gas per sottomissione ottimistica
            const submitTx = await contract.submitSignature(
                messageHash,
                signature,
                signerAddress
            );
            const submitReceipt = await submitTx.wait();
            const submitGas = submitReceipt.gasUsed;

            console.log("\n📊 ANALISI GAS:");
            console.log(`   Sottomissione ottimistica: ${submitGas} gas`);

            // Gas per verifica on-chain (in caso di challenge)
            // Sottometti firma fraudolenta
            await contract.submitSignature(messageHash, signature, user2.address);

            const challengeTx = await contract.connect(challenger)
                .challengeSignature(1);
            const challengeReceipt = await challengeTx.wait();
            const challengeGas = challengeReceipt.gasUsed;

            console.log(`   Challenge (verifica on-chain): ${challengeGas} gas`);
            console.log(`   Differenza: ${challengeGas - submitGas} gas`);
            console.log(`   Risparmio: ~${((1 - Number(submitGas) / Number(challengeGas)) * 100).toFixed(1)}%`);

            // La sottomissione dovrebbe costare meno della verifica
            expect(submitGas).to.be.lessThan(challengeGas);
        });
    });
});